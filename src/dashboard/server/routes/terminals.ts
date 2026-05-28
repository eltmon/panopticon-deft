/**
 * Terminals route module — POST /api/terminals creates an ad-hoc tmux bash
 * session on the `panopticon` socket and returns its name (PAN-1545).
 *
 * Sessions created here are NOT agents: no state.json under ~/.panopticon/agents/,
 * no issue tracking, no role/harness. They're plain tmux bash sessions that the
 * dashboard's terminal renderer can attach to via `/terminal/<sessionName>`.
 *
 * Cleanup is out of scope for v0 — orphaned `term-*` sessions accumulate until
 * killed manually (`tmux -L panopticon kill-session -t term-…`). A list/kill
 * UI is tracked as a follow-up to PAN-1545.
 */
import { Layer, Effect } from 'effect';
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { jsonResponse } from '../http-helpers.js';
import { validateOrigin } from './origin-validation.js';
import { createSession, sessionExists } from '../../../lib/tmux.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text;
  if (!text) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
});

function generateSessionName(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = randomBytes(2).toString('hex');
  return `term-${ts}-${rand}`;
}

/**
 * Resolve the cwd for a new terminal session.
 *
 * 1. If `body.cwd` is provided AND exists on disk, use it.
 * 2. Otherwise fall back to `$HOME`. We deliberately don't error on a bad
 *    cwd — a working bash prompt at home is more useful than a 400 the user
 *    has to read the network panel to understand.
 */
function resolveCwd(bodyCwd: unknown): string {
  if (typeof bodyCwd === 'string' && bodyCwd.length > 0 && existsSync(bodyCwd)) {
    return bodyCwd;
  }
  return homedir();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const postTerminalRoute = HttpRouter.add(
  'POST',
  '/api/terminals',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const originCheck = validateOrigin(request);
    if (!originCheck.ok) {
      return jsonResponse({ error: originCheck.error }, { status: 403 });
    }

    const body = yield* readJsonBody;
    const cwd = resolveCwd(body['cwd']);

    // Retry on the astronomically-unlikely name collision (same second AND
    // same 4-char rand). Five retries is overkill; one would do.
    let sessionName = generateSessionName();
    for (let i = 0; i < 5; i++) {
      const exists = yield* sessionExists(sessionName).pipe(
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!exists) break;
      sessionName = generateSessionName();
    }

    yield* createSession(sessionName, cwd, undefined, {
      // No env overrides — bash inherits the dashboard server's env, which
      // already includes the user's PATH / locale / etc. (set up by `pan up`).
    }).pipe(
      Effect.mapError((cause) => {
        // Surface tmux failures as 500s with the underlying message — the
        // caller's only recourse is to retry or look at server logs.
        console.error(`[terminals] createSession failed for ${sessionName}:`, cause);
        return cause;
      }),
    );

    console.log(`[terminals] Created ad-hoc terminal "${sessionName}" cwd=${cwd}`);

    return jsonResponse({ sessionName, cwd });
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(jsonResponse({ error: `Failed to create terminal: ${String(cause)}` }, { status: 500 })),
    ),
  ),
);

// ─── Compose ─────────────────────────────────────────────────────────────────

export const terminalsRouteLayer = Layer.mergeAll(postTerminalRoute);
export default terminalsRouteLayer;
