/**
 * openNewTerminal — shared helper for the four "New Terminal" entry points
 * (PAN-1545). Posts to `/api/terminals` to spawn an ad-hoc tmux bash session,
 * then navigates the browser to the standalone terminal view for it.
 *
 * Usage:
 *   import { openNewTerminal } from '../lib/openNewTerminal';
 *   await openNewTerminal();                          // sidebar / palette
 *   await openNewTerminal(conversation.workspacePath); // conversation panel
 *   await openNewTerminal(issue.workspacePath);        // issue drawer
 */

interface CreateTerminalResponse {
  sessionName: string;
  cwd: string;
}

export interface OpenNewTerminalOptions {
  /** Working directory for the new bash session. Falls back to $HOME server-side. */
  cwd?: string;
  /** Where to open the terminal view. Defaults to current tab. */
  target?: '_self' | '_blank';
}

export async function openNewTerminal(
  cwdOrOptions?: string | OpenNewTerminalOptions,
): Promise<CreateTerminalResponse> {
  const opts: OpenNewTerminalOptions =
    typeof cwdOrOptions === 'string'
      ? { cwd: cwdOrOptions }
      : (cwdOrOptions ?? {});

  const res = await fetch('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const data = (await res.json()) as CreateTerminalResponse;
  const url = `/terminal/${encodeURIComponent(data.sessionName)}`;

  if (opts.target === '_blank') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.href = url;
  }

  return data;
}
