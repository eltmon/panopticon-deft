/**
 * XTerminalRpc — terminal-over-PanRpcGroup spike (PAN-1536).
 *
 * Drop-in alternative to XTerminal that uses the existing `terminalOpen` /
 * `subscribeTerminal` / `terminalWrite` / `terminalResize` / `terminalClose`
 * RPC methods on PanRpcGroup instead of the raw `/ws/terminal` WebSocket.
 *
 * This is a SPIKE — used only when the page URL carries `?terminal=rpc`. The
 * raw-WS path remains the default. See `.pan/drafts/PAN-1536.md` for the
 * measurement plan and the rationale for resurrecting this code path.
 *
 * Deliberate omissions vs XTerminal.tsx (kept minimal so the A/B measures
 * transport, not chrome):
 *   - no auto-copy / selection clipboard
 *   - no context menu, no settings panel
 *   - no reconnect button — WsTransport.subscribe auto-reconnects
 *
 * Snapshot semantics differ from raw WS: there is no server-side `capture-pane`
 * pre-roll. The first frames you see are whatever tmux emits on attach (its
 * own redraw). Cold-start latency comparisons in PAN-1536's Results section
 * account for this.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { WS_METHODS } from '@panctl/contracts';
import { getTransport, type PanRpcProtocolClient } from '../lib/wsTransport';

interface XTerminalRpcProps {
  sessionName: string;
  onDisconnect?: () => void;
}

const PROFILE_ENABLED = (() => {
  try {
    return localStorage.getItem('PANOPTICON_TERMINAL_PROFILE') === '1';
  } catch {
    return false;
  }
})();

function prof(sessionName: string, t0: number, label: string, extra?: string): void {
  if (!PROFILE_ENABLED) return;
  const now = performance.now();
  console.log(
    `[xterm-rpc-prof] ${sessionName} +${(now - t0).toFixed(1)}ms t=${now.toFixed(1)} ${label}${extra ? ' ' + extra : ''}`,
  );
}

export function XTerminalRpc({ sessionName, onDisconnect }: XTerminalRpcProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  useEffect(() => {
    if (!terminalRef.current) return;

    const tProf = performance.now();
    let disposed = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        cursorAccent: '#1a1a2e',
        selectionBackground: 'rgba(98, 114, 164, 0.5)',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    try { fit.fit(); } catch { /* element not sized yet */ }

    const measured = fit.proposeDimensions() ?? { cols: term.cols, rows: term.rows };
    prof(sessionName, tProf, 'xterm mounted', `${measured.cols}x${measured.rows}`);

    let lastCols = measured.cols;
    let lastRows = measured.rows;

    // ── Send keystroke → terminalWrite RPC ────────────────────────────────────
    // Fire-and-forget; we deliberately don't await so the keystroke shows on
    // the next PTY echo, not after the RPC ack. Errors are swallowed — the
    // subscribe stream's reconnect handles transport drops.
    term.onData((data: string) => {
      if (disposed) return;
      void getTransport().request((client: PanRpcProtocolClient) =>
        (client[WS_METHODS.terminalWrite] as (input: { sessionName: string; data: string }) => import('effect').Effect.Effect<void, Error>)(
          { sessionName, data },
        ),
      ).catch(() => { /* transport drop — subscribe loop will reconnect */ });
    });

    // ── Open the session (idempotent) then subscribe to the stream ────────────
    // The server starts the PTY on terminalOpen if cols/rows are present, so
    // subscribeTerminal will receive data from the first frame.
    let unsubscribe: (() => void) | null = null;

    void getTransport()
      .request((client: PanRpcProtocolClient) =>
        (client[WS_METHODS.terminalOpen] as (input: { sessionName: string; cols: number; rows: number }) => import('effect').Effect.Effect<{ sessionName: string }, Error>)(
          { sessionName, cols: measured.cols, rows: measured.rows },
        ),
      )
      .then(() => {
        prof(sessionName, tProf, 'terminalOpen ack');
        if (disposed) return;

        unsubscribe = getTransport().subscribe(
          (client) => {
            return (client[WS_METHODS.subscribeTerminal] as (input: { sessionName: string; cols: number; rows: number }) => import('effect').Stream.Stream<{ sessionName: string; data: string }, Error>)(
              { sessionName, cols: lastCols, rows: lastRows },
            );
          },
          (chunk) => {
            prof(sessionName, tProf, 'chunk', `len=${chunk.data.length}`);
            term.write(chunk.data);
          },
        );
      })
      .catch((err) => {
        console.error('[xterm-rpc] terminalOpen failed:', err);
        if (onDisconnectRef.current) {
          try { onDisconnectRef.current(); } catch { /* non-fatal */ }
        }
      });

    // ── Resize handling ───────────────────────────────────────────────────────
    let resizeRaf: number | null = null;
    const handleResize = () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (disposed) return;
        try { fit.fit(); } catch { return; }
        const next = fit.proposeDimensions() ?? { cols: term.cols, rows: term.rows };
        if (next.cols === lastCols && next.rows === lastRows) return;
        lastCols = next.cols;
        lastRows = next.rows;
        prof(sessionName, tProf, 'resize', `${next.cols}x${next.rows}`);
        void getTransport().request((client: PanRpcProtocolClient) =>
          (client[WS_METHODS.terminalResize] as (input: { sessionName: string; cols: number; rows: number }) => import('effect').Effect.Effect<void, Error>)(
            { sessionName, cols: next.cols, rows: next.rows },
          ),
        ).catch(() => { /* swallow — next resize will retry */ });
      });
    };

    window.addEventListener('resize', handleResize);
    const ro = new ResizeObserver(handleResize);
    ro.observe(terminalRef.current);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      ro.disconnect();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (unsubscribe) unsubscribe();

      void getTransport().request((client: PanRpcProtocolClient) =>
        (client[WS_METHODS.terminalClose] as (input: { sessionName: string }) => import('effect').Effect.Effect<void, Error>)(
          { sessionName },
        ),
      ).catch(() => { /* server already cleaned up */ });

      try { term.dispose(); } catch { /* already disposed */ }
    };
  }, [sessionName]);

  return (
    <div
      ref={terminalRef}
      className="absolute inset-0"
      tabIndex={0}
      style={{
        padding: '8px',
        backgroundColor: '#1a1a2e',
        overflow: 'hidden',
        outline: 'none',
      }}
    />
  );
}
