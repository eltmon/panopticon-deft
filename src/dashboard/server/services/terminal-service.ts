/**
 * TerminalService — PTY terminal streaming over PanRpcGroup (PAN-428 B20,
 * snapshot-on-attach added in PAN-1536).
 *
 * Implements the terminal RPC surface: open, write, resize, close, and
 * streamSession. Uses node-pty under Node (Bun.spawn fallback remains for
 * compatibility but is not exercised in production — see CLAUDE.md's
 * "Node 22 only" rule).
 *
 * Key behaviours:
 *  - Deferred PTY spawn: PTY is not started until the first subscribe/resize
 *    actually attaches. This keeps `terminalOpen` cheap when the dashboard is
 *    just probing whether a session exists.
 *  - Snapshot-on-attach: every `streamSession` emits a `tmux capture-pane`
 *    snapshot as the first chunk. This makes cold paint instant (matching the
 *    raw `/ws/terminal` UX) AND re-anchors client SGR state on every reload,
 *    fixing the horizontal-strip / underline corruption that occurred when
 *    PTY bytes were dropped during the subscriber-handoff gap.
 *  - On stream end: drop the queue reference only; the PTY (and the tmux
 *    session it's attached to) survive. Killing the PTY would force every
 *    other client of the same hub to re-attach, which costs paint time.
 *
 * Historical note (PAN-1536): a 200 ms dimension-toggle was previously used
 * here to force a tmux SIGWINCH-driven repaint. With the snapshot-on-attach
 * in place that toggle is redundant and was removed; it was the cause of the
 * +200 ms first-byte gap measured in PAN-1536's results section.
 */

import { Cause, Effect, Layer, Queue, Context, Stream } from 'effect';
import { homedir } from 'node:os';
import { PanRpcError, TerminalOutput } from '@panctl/contracts';
import { buildTmuxArgs, capturePane, getWindowDimensions, resizeWindow, sessionExists } from '../../../lib/tmux.js';
import { buildChildEnvWithoutTmuxSync } from '../../../lib/child-env.js';

// Match raw `/ws/terminal`'s snapshot scrollback. 500 lines covers a generous
// viewport without inflating the first frame to multi-megabyte territory.
const SNAPSHOT_SCROLLBACK_LINES = 500;

// ─── Runtime detection ────────────────────────────────────────────────────────

declare const Bun: unknown;
function isBun(): boolean {
  return typeof Bun !== 'undefined';
}

// ─── PTY process abstraction ──────────────────────────────────────────────────

interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (exitCode: number) => void): () => void;
}

// ─── Bun PTY wrapper ──────────────────────────────────────────────────────────

class BunPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;

  constructor(private readonly proc: { pid: number; exited: Promise<number>; signalCode?: number | null; terminal?: { write(d: string): void; resize?(c: number, r: number): void } }) {
    void proc.exited
      .then((code) => this.emitExit(Number.isInteger(code) ? code : 0))
      .catch(() => this.emitExit(1));
  }

  write(data: string): void {
    const t = (this.proc as { terminal?: { write(d: string): void } }).terminal;
    if (!t) throw new Error('Bun PTY terminal handle unavailable');
    t.write(data);
  }

  resize(cols: number, rows: number): void {
    const t = (this.proc as { terminal?: { resize?(c: number, r: number): void } }).terminal;
    if (!t?.resize) throw new Error('Bun PTY resize unavailable');
    t.resize(cols, rows);
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => { this.dataListeners.delete(cb); };
  }

  onExit(cb: (exitCode: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => { this.exitListeners.delete(cb); };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    const text = this.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    for (const l of this.dataListeners) l(text);
  }

  private emitExit(code: number): void {
    if (this.didExit) return;
    this.didExit = true;
    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const l of this.dataListeners) l(remainder);
    }
    for (const l of this.exitListeners) l(code);
  }
}

// ─── Node PTY wrapper ─────────────────────────────────────────────────────────

class NodePtyProcess implements PtyProcess {
  constructor(private readonly proc: import('@homebridge/node-pty-prebuilt-multiarch').IPty) {}

  write(data: string): void { this.proc.write(data); }
  resize(cols: number, rows: number): void { this.proc.resize(cols, rows); }

  onData(cb: (data: string) => void): () => void {
    const d = this.proc.onData(cb);
    return () => { d.dispose(); };
  }

  onExit(cb: (exitCode: number) => void): () => void {
    const d = this.proc.onExit(({ exitCode }) => cb(exitCode));
    return () => { d.dispose(); };
  }
}

// ─── PTY spawn ────────────────────────────────────────────────────────────────

async function waitForTmuxSession(sessionName: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await Effect.runPromise(sessionExists(sessionName))) {
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for tmux session ${sessionName} (${timeoutMs}ms)`);
}

// Cache the node-pty module so spawn + onData registration have no async gap
let _nodePtyModule: typeof import('@homebridge/node-pty-prebuilt-multiarch') | null = null;
async function getNodePty() {
  if (!_nodePtyModule) _nodePtyModule = await import('@homebridge/node-pty-prebuilt-multiarch');
  return _nodePtyModule;
}

/** Spawn PTY immediately — caller must ensure tmux session exists. */
function spawnPtyImmediate(sessionName: string, cols: number, rows: number): PtyProcess {
  const env = buildChildEnvWithoutTmuxSync(process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
  });
  const cwd = homedir();

  if (isBun()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BunGlobal = globalThis as any;
    let processHandle: BunPtyProcess | null = null;
    const subprocess = BunGlobal.Bun.spawn(['tmux', ...buildTmuxArgs(['attach-session', '-t', sessionName])], {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data: (_terminal: unknown, data: Uint8Array) => {
          processHandle?.emitData(data);
        },
      },
    });
    processHandle = new BunPtyProcess(subprocess);
    return processHandle;
  } else {
    if (!_nodePtyModule) throw new Error('node-pty not loaded — call getNodePty() first');
    const proc = _nodePtyModule.spawn('tmux', buildTmuxArgs(['attach-session', '-t', sessionName]), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    return new NodePtyProcess(proc);
  }
}

// ─── Internal session state ───────────────────────────────────────────────────

interface TerminalSessionState {
  sessionName: string;
  ptyProcess: PtyProcess | null;
  ptyStarted: boolean;
  lastCols: number;
  lastRows: number;
  pendingInput: string[];
  /** Queue used by the Effect stream to receive terminal output chunks. */
  queue: Queue.Queue<TerminalOutput, PanRpcError | Cause.Done> | null;
}

// ─── Service interface ────────────────────────────────────────────────────────

export interface TerminalServiceShape {
  open(sessionName: string, cols: number, rows: number): Effect.Effect<{ sessionName: string }, PanRpcError>;
  write(sessionName: string, data: string): Effect.Effect<void, PanRpcError>;
  resize(sessionName: string, cols: number, rows: number): Effect.Effect<void, PanRpcError>;
  close(sessionName: string): Effect.Effect<void, PanRpcError>;
  streamSession(sessionName: string, cols: number, rows: number): Stream.Stream<TerminalOutput, PanRpcError>;
}

export class TerminalService extends Context.Service<TerminalService, TerminalServiceShape>()(
  'panopticon/dashboard/TerminalService',
) {}

// ─── Service implementation ───────────────────────────────────────────────────

export const TerminalServiceLive = Layer.effect(
  TerminalService,
  Effect.sync(() => {
    const sessions = new Map<string, TerminalSessionState>();

    /** Start the PTY for a session and wire up data/exit callbacks. */
    function startPty(state: TerminalSessionState, cols: number, rows: number): void {
      if (state.ptyStarted) return;
      state.ptyStarted = true;
      state.lastCols = cols;
      state.lastRows = rows;

      console.log(`[terminal-service] Spawning PTY for ${state.sessionName} at ${cols}x${rows}`);

      // Wait for tmux session + preload node-pty, then spawn PTY and register
      // callbacks with ZERO async gap. This ensures onData is registered before
      // any data can be emitted from the initial tmux screen paint.
      Promise.all([waitForTmuxSession(state.sessionName), getNodePty()]).then(() => {
        // spawnPtyImmediate is now SYNCHRONOUS (node-pty cached) — no microtask gap
        const proc = spawnPtyImmediate(state.sessionName, cols, rows);
        state.ptyProcess = proc;

        // Register data handler SYNCHRONOUSLY with spawn — no async gap.
        let chunkCount = 0;
        proc.onData((data) => {
          chunkCount++;
          if (chunkCount <= 5) {
            console.log(`[terminal-service] ${state.sessionName} chunk#${chunkCount} len=${data.length} queueOk=${!!(state.queue && state.queue.state._tag !== "Done")}`);
          }
          if (state.queue && state.queue.state._tag !== "Done") {
            Queue.offerUnsafe(Queue.asEnqueue(state.queue), { sessionName: state.sessionName, data });
          }
        });

        proc.onExit((exitCode) => {
          console.log(`[terminal-service] PTY for ${state.sessionName} exited with code ${exitCode}`);
          state.ptyProcess = null; // Mark dead so resize guards work
          if (state.queue && state.queue.state._tag !== "Done") {
            if (exitCode !== 0) {
              // Non-zero exit (e.g., tmux session doesn't exist yet) — fail with error
              // so WsTransport.subscribe() retries instead of treating it as clean end.
              Queue.failCauseUnsafe(Queue.asEnqueue(state.queue),
                Cause.fail(new PanRpcError({ message: `PTY exited with code ${exitCode}`, code: 'TERMINAL_PTY_EXIT' })),
              );
            } else {
              Queue.endUnsafe(Queue.asEnqueue(state.queue));
            }
          }
          sessions.delete(state.sessionName);
        });

        // Flush pending input that arrived before PTY was ready.
        for (const input of state.pendingInput) {
          proc.write(input);
        }
        state.pendingInput.length = 0;
      }).catch((err) => {
        console.error(`[terminal-service] Failed to spawn PTY for ${state.sessionName}:`, err);
        if (state.queue && state.queue.state._tag !== "Done") {
          Queue.endUnsafe(Queue.asEnqueue(state.queue));
        }
        sessions.delete(state.sessionName);
      });
    }

    const open: TerminalServiceShape['open'] = (sessionName, cols, rows) =>
      Effect.gen(function* () {
        // Idempotent: reuse if already open.
        if (!sessions.has(sessionName)) {
          sessions.set(sessionName, {
            sessionName,
            ptyProcess: null,
            ptyStarted: false,
            lastCols: cols,
            lastRows: rows,
            pendingInput: [],
            queue: null,
          });
        }
        const state = sessions.get(sessionName)!;
        // Deferred spawn: startPty is called when the first resize arrives (or here if
        // cols/rows are already known from the open call). Per CLAUDE.md, both local
        // and remote handlers wait for the first resize message from the client. Since
        // the RPC protocol passes cols/rows in the open call we start immediately.
        if (!state.ptyStarted) {
          startPty(state, cols, rows);
        }
        return { sessionName };
      }).pipe(
        Effect.mapError((e) =>
          new PanRpcError({ message: `terminalOpen failed: ${String(e)}`, code: 'TERMINAL_ERROR' }),
        ),
      );

    const write: TerminalServiceShape['write'] = (sessionName, data) =>
      Effect.gen(function* () {
        const state = sessions.get(sessionName);
        if (!state) {
          return yield* Effect.fail(
            new PanRpcError({ message: `No terminal session: ${sessionName}`, code: 'TERMINAL_NOT_FOUND' }),
          );
        }
        if (state.ptyProcess) {
          state.ptyProcess.write(data);
        } else {
          state.pendingInput.push(data);
        }
      });

    const resize: TerminalServiceShape['resize'] = (sessionName, cols, rows) =>
      Effect.gen(function* () {
        const state = sessions.get(sessionName);
        if (!state) {
          return yield* Effect.fail(
            new PanRpcError({ message: `No terminal session: ${sessionName}`, code: 'TERMINAL_NOT_FOUND' }),
          );
        }
        // Deferred spawn: if PTY not yet started, start it now with the resize dimensions.
        if (!state.ptyStarted) {
          startPty(state, cols, rows);
          return;
        }
        // Ignore no-op resizes.
        if (cols === state.lastCols && rows === state.lastRows) return;
        state.lastCols = cols;
        state.lastRows = rows;
        if (state.ptyProcess) {
          try { state.ptyProcess.resize(cols, rows); } catch { return; /* PTY dead */ }
          yield* resizeWindow(sessionName, cols, rows).pipe(
            Effect.catch(() => Effect.void),
          );
        }
      });

    const close: TerminalServiceShape['close'] = (sessionName) =>
      Effect.sync(() => {
        const state = sessions.get(sessionName);
        if (!state) return;
        // Do NOT kill the PTY — just remove from tracking. The PTY exits
        // naturally when pipes close; the tmux session survives independently.
        if (state.queue && state.queue.state._tag !== "Done") {
          Queue.endUnsafe(Queue.asEnqueue(state.queue));
        }
        sessions.delete(sessionName);
      });

    const streamSession: TerminalServiceShape['streamSession'] = (sessionName, cols, rows) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Ensure session state exists. PTY spawn is deferred until the
          // subscriber actually begins consuming (acquire callback below).
          if (!sessions.has(sessionName)) {
            sessions.set(sessionName, {
              sessionName,
              ptyProcess: null,
              ptyStarted: false,
              lastCols: cols,
              lastRows: rows,
              pendingInput: [],
              queue: null,
            });
          }

          // Capture the current tmux pane state and emit it as the first chunk.
          // This is the same `capture-pane` snapshot that the raw `/ws/terminal`
          // path uses to anchor cold paint instantly. It also re-anchors on
          // every reload — any PTY bytes dropped during the subscriber-handoff
          // gap (old subscriber's queue cleared, new subscriber not yet
          // attached) are still reflected in tmux's pane state, so the snapshot
          // resets the client to a known-good rendering. Without this, lost
          // SGR escapes (e.g. unmatched ESC[4m) leave the terminal stuck in
          // an inherited style and produce the horizontal-strip corruption.
          //
          // The snapshot frame ALSO carries cols/rows so the client can resize
          // xterm to match the dimensions the snapshot was rendered at. Without
          // this, content rendered at e.g. 359-col tmux dims paints inside an
          // xterm at 385 cols, leaving each line offset and the right edge of
          // the snapshot clipped off-screen.
          const snapshotDims = yield* getWindowDimensions(sessionName).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          const snapshotData = yield* capturePane(sessionName, SNAPSHOT_SCROLLBACK_LINES, {
            escapeSequences: true,
          }).pipe(
            // Snapshot is best-effort. If the session hasn't been spawned yet,
            // capture fails — live PTY data will paint the screen from scratch.
            Effect.catch(() => Effect.succeed('')),
          );

          const liveStream = Stream.callback<TerminalOutput, PanRpcError>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const state = sessions.get(sessionName)!;
                state.queue = queue;
                if (!state.ptyStarted) {
                  startPty(state, cols, rows);
                }
              }),
              () =>
                Effect.sync(() => {
                  const state = sessions.get(sessionName);
                  // Do NOT kill the PTY on stream end — only drop our queue
                  // reference so subsequent subscribers can attach cleanly.
                  if (state && state.queue === queue) {
                    state.queue = null;
                  }
                }),
            ),
          );

          // Snapshot first, then live PTY chunks. Stream.concat enforces order
          // — the subscriber sees a complete snapshot frame before any byte
          // emitted after the capture completes. The snapshot carries its own
          // cols/rows so the client resizes xterm to match before painting.
          const snapshotStream = snapshotData
            ? Stream.succeed<TerminalOutput>({
                sessionName,
                data: snapshotData,
                cols: snapshotDims?.cols,
                rows: snapshotDims?.rows,
              })
            : Stream.empty;
          return Stream.concat(snapshotStream, liveStream);
        }),
      );

    return { open, write, resize, close, streamSession };
  }),
);
