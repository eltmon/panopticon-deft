## Package Manager: Bun

This project uses **Bun** for dependency management. The lockfile is `bun.lock`.

```bash
# Install dependencies (NEVER use npm install)
bun install

# Add a dependency
bun add <package>
bun add -d <package>  # dev dependency
```

Use `npm run` / `npm test` for script execution (works fine with bun-installed deps), but **NEVER use `npm install`** — it creates a `package-lock.json` and installs differently.

## Build & Test

```bash
npm run build      # tsdown for CLI/server/contracts, Vite for frontend
npm run typecheck   # TypeScript strict mode
npm run lint        # ESLint
npm test -- --run   # Vitest
```

## Stack

**Two WebSocket endpoints:**
- `/ws/rpc` — Effect RPC (PanRpcGroup): domain events, snapshots, replay. Uses typed Schema.
- `/ws/terminal?session=<name>` — Raw WebSocket: live PTY terminal streaming via `ws` library.
  Terminal data bypasses Effect RPC because the RPC serialization layer can't handle
  high-throughput binary-like terminal data reliably.

**Terminal architecture** (`ws-terminal.ts` + `XTerminal.tsx`):
- Server: raw `WebSocketServer` with `noServer: true`, deferred PTY spawn (waits for
  client resize dimensions), `node-pty` spawns `tmux attach-session`
- Client: raw `WebSocket` API with exponential backoff reconnection
- PTY waits for tmux session to exist (`waitForTmuxSession`) before spawning
- Data flows immediately on attach — no stale data suppression
- Dimension toggle at 200ms forces correct-size repaint

**Frontend data flow:**
- `EventRouter.tsx` → connects to `/ws/rpc`, fetches snapshot via `getSnapshot` RPC,
  subscribes to `subscribeDomainEvents` stream, applies events to Zustand store
- `WsTransport.ts` — Effect-based RPC client with auto-reconnection
- Store: Zustand with shared reducers from `@panopticon/contracts`

**Session lifecycle rules:**
- On WebSocket close, do NOT kill the PTY — the tmux session survives independently.
- Do NOT pre-resize tmux windows. Let the PTY spawn handle sizing via client dimensions.
- The planning launcher script MUST export TERM/COLORTERM/LANG for Claude Code rendering.
- Planning sessions use `remain-on-exit on` + `destroy-unattached off` so the session
  survives after the agent exits, until the user clicks Done.

## Verification Gate (PAN-174)

After a work agent signals completion, Cloister runs quality gates from `projects.yaml`
before waking the review-agent. If typecheck/lint/test fail, feedback is sent to the
agent's tmux session and the completion marker is NOT processed (allowing retry).
After 3 consecutive failures, verification is bypassed to prevent permanent blocking.

## Project Resolution from Issue IDs

Issue IDs are resolved to projects via `resolveProjectFromIssue()` in `src/lib/projects.ts`
and `parseGitHubRepos()` in `src/lib/tracker-utils.ts`. Resolution order:

1. Match `linear_team` field in `projects.yaml` (e.g., `linear_team: MIN` matches `MIN-123`)
2. For GitHub-only projects without `linear_team`, derive prefix from the project key
   (e.g., project key `krux` → prefix `KRUX` matches `KRUX-3`)

When adding a new project to `projects.yaml`, either set `linear_team` explicitly or
ensure the project key (uppercased, hyphens removed) matches the issue prefix you want.

## Beads Enforcement

Work agents cannot start without beads tasks in the workspace. The start-agent endpoint
returns 422 if `.beads/issues.jsonl` does not exist. Planning must create beads via
`bd create` before handing off to implementation.

## Stash Hygiene

Stashes are git refs — they persist until explicitly dropped. Left alone, they accumulate fast (we cleared out 106 stashes during the 1.0 stabilization audit on 2026-04-23). The goal is to keep the list short enough that it stays meaningful.

**Naming rules (when Panopticon code creates a stash):**
- Start with a category prefix so stashes are greppable:
  - `pre-merge:PAN-XXX:<iso-timestamp>` — safety snapshot before a merge operation
  - `pre-spawn:PAN-XXX:<iso-timestamp>` — planning-debris snapshot before an agent start
  - `review-temp:PAN-XXX:<n>` — short-lived stash during a review-request roundtrip
  - `salvageable:PAN-XXX:<iso-timestamp>:<short-description>` — explicitly flagged as user work that may need recovery (e.g. uncommitted edits discovered during cleanup)

**Drop-on-completion rules:**
- `pre-merge:*` — drop once the merge succeeds (or the merge flow rolls back).
- `pre-spawn:*` — drop once the agent has checkpointed its first real commit.
- `review-temp:*` — drop when the review request completes (success OR failure).
- `salvageable:*` — NEVER drop automatically. These must be either recovered to a branch or reviewed by the user.

**Triage cadence:**
- Any stash older than 4 weeks that is NOT `salvageable:*` is a candidate for cleanup.
- Any `salvageable:*` stash surfaces in the dashboard's workspace inspector so the user can see it and decide.

**Recovery:**
- `git stash drop` preserves the stash commit in the reflog for 90 days. Anything dropped accidentally is recoverable during that window.

## CRITICAL: postMergeLifecycle Idempotency

`onMergeComplete()` and `/api/specialists/done` have idempotency guards to prevent
infinite loops. NEVER remove these guards. The loop: specialists/done → onMergeComplete
→ postMergeLifecycle → (re-trigger) → specialists/done burned 24,626 Linear API calls
before guards were added (PAN-328).

## postMergeLifecycle Docker Cleanup

`postMergeLifecycle()` in `merge-agent.ts` stops Docker containers and networks after
merge (step 6). This prevents Docker network pool exhaustion — orphaned networks from
merged workspaces accumulate and eventually block new workspace creation with
"all predefined address pools have been fully subnetted". Docker's default pool only
supports ~31 bridge networks. NEVER remove this cleanup step.

## CRITICAL: Deep-Wipe Destroys Everything — NEVER Run Without Explicit User Confirmation

The deep-wipe endpoint (`POST /api/agents/:id/deep-wipe`) with `deleteWorkspace: true` is **irreversible** and destroys:

1. **tmux sessions** — all agent sessions killed
2. **Agent state directories** — `~/.panopticon/agents/<id>/` removed
3. **Entire workspace directory** — this includes:
   - `.planning/STATE.md` — planning progress and status
   - `.planning/plan.vbrief.json` — the **workspace-specific vBRIEF plan** with items, acceptance criteria, and dependencies (generated during planning)
   - `.planning/beads/` — all task tracking beads
   - Any implementation work in progress
4. **Git branches** — both local AND remote `feature/<issue-id>` branches deleted
5. **Linear/GitHub status** — issue status reset to Todo/Open

**The docs-level PRD** (e.g., `myn/docs/prds/planned/MIN-XXX-*.md`) survives because it's committed to the docs repo, but it is NOT the same as the workspace vBRIEF plan generated during planning. The two workspace planning artifacts are `plan.vbrief.json` (structured plan with acceptance criteria) and `STATE.md` (narrative context and current status).

**Rules:**
- **NEVER call deep-wipe programmatically** without the user explicitly requesting it
- **NEVER attempt destructive HTTP requests** (POST, DELETE) speculatively — HTTP requests execute immediately when sent; tool rejection by the user CANNOT stop an already-sent request
- When a user wants to restart an agent, use the regular stop/restart flow, NOT deep-wipe
- Deep-wipe is a last resort for cleaning up abandoned workspaces, not a routine operation

## TLDR: Token-Efficient Code Analysis

**If your workspace has a `.venv` directory, you have access to TLDR tools for code analysis.**

TLDR provides structured code summaries using 500-1,200 tokens per file instead of 10-25k, extending how much work you can accomplish per session.

### Available MCP Tools

When TLDR is available, you'll have these MCP tools:
- `tldr_context <file>` - File structure, exports, imports, key functions
- `tldr_structure <directory>` - Directory layout and relationships
- `tldr_calls <function> <file>` - Call graph (what calls this function)
- `tldr_impact <function> <file>` - Impact analysis (what this function calls)
- `tldr_semantic <query>` - Natural language code search

### Recommended Workflow

1. **Explore with TLDR first:**
   - Use `tldr_context` to understand file structure before reading
   - Use `tldr_semantic` to find relevant code by description
   - Use `tldr_calls` and `tldr_impact` for dependency analysis

2. **Read full files only when editing:**
   - TLDR shows you the structure and what to edit
   - Read the full file to get exact line numbers and implementation
   - Edit the specific sections you identified

3. **Avoid reading everything:**
   - 20 files × 15k tokens = 300k tokens (exhausts context)
   - 20 files × 800 tokens (TLDR) = 16k tokens (94% savings)

**Use TLDR liberally to maximize your session effectiveness.**

## vBRIEF Plans

Panopticon uses **vBRIEF v0.5** for machine-readable work plans. Key references:

- **Canonical spec:** [github.com/deftai/vBRIEF](https://github.com/deftai/vBRIEF)
- **Our fork:** [github.com/eltmon/vBRIEF](https://github.com/eltmon/vBRIEF)
- **Extension proposal:** [deftai/vBRIEF#1](https://github.com/deftai/vBRIEF/issues/1)
- **Panopticon docs:** [docs/VBRIEF.md](docs/VBRIEF.md)

### v0.5 Fields Implemented

`vBRIEFInfo`: `author` (tool identifier), `description`

`plan`: `uid` (UUID v4), `author` (agent model), `sequence` (write counter), `references` (issue URL + PRDs), `created`, `updated`

`items`/`subItems`: `created`, `completed` (set on status → completed)

### Auto-Behaviors

- `io.ts` (`updateItemStatus`/`updateSubItemStatus`) auto-increments `plan.sequence` and sets `updated` timestamps on every write
- `complete-planning` copies `STATE.md` and `plan.vbrief.json` to `docs/prds/active/<issue-id>/` (skip if exists)
- `start-planning` discovers PRDs from `docs/prds/planned/` and `docs/prds/active/` matching the issue ID and copies to `.planning/prd.md`

### Dashboard Viewer

VBriefViewer components at `src/dashboard/frontend/src/components/vbrief/`:
- Accessible via **vBRIEF button** on kanban issue cards and InspectorPanel
- List / DAG / Raw JSON tabs
- Fetches from `GET /api/workspaces/:issueId/plan`
