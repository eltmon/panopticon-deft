# Root-cause: conversation transcript wipes to "How can I help you?" / shows only last parts

## Symptom (operator-reported, 2026-06-13)
The dashboard conversation view spontaneously resets to the empty "How can I help you?"
state, or shows only the last few messages, **even while the operator is just reading it
(no navigation/reload)**. Started ~last 12h, **increasing frequency** (worse under load).

## Client guards already shipped (defense-in-depth — NOT the root cause)
- `71cf0ce99` — `ConversationPanel.tsx` HTTP queryFn: when the WS stream is active, only
  keep the cache if it's at least as complete as the HTTP backfill; otherwise use the HTTP
  full history (fixes the initial-load race that returned empty).
- `6f3b4ceb0` — `useConversationMessagesStream.ts` `applyConversationMessagesEvent`: a
  snapshot event must never SHRINK the transcript; merge instead of replace when it would
  (fixes the live mid-read wipe).

These stop the *visible* damage. They do NOT explain why the upstream data goes empty/partial.

## Server trigger (confirmed mechanism)
`src/dashboard/server/ws-rpc.ts` → `subscribeConversationMessages` (~line 609):
- On subscribe it parses the session JSONL and emits `snapshot: true` with `initial.messages`.
- The `watchConversation(sessionFile, …)` callback computes
  `fileWasReset = result.byteOffset < currentByteOffset` and emits **`snapshot: fileWasReset`**.
- So whenever a conversation's session JSONL **shrinks** (byteOffset drops), the server emits a
  full reset-snapshot of whatever is currently in the (smaller/empty) file.

## THE ROOT-CAUSE QUESTION (your task)
**Why do conversation session JSONL files shrink/reset mid-session while the operator is reading?**
Candidates to confirm/refute with evidence:
- (a) claude-code **compaction** rewriting the session file to a shorter form.
- (b) the conversation **resuming into a fresh/new session file** (claudeSessionId rotation) —
  `sessionFilePath(conv.cwd, conv.claudeSessionId)` / `resolveJsonlPath` then point at a fresh
  "How can I help you?" file.
- (c) a transient **mid-write/truncation read** by `watchConversation` (partial/empty read before
  the file is fully rewritten) — i.e. a debounce/atomicity bug in the watcher.
- (d) something restarting conversation sessions. NOTE: the **deacon is FROZEN**, so its
  resume/recovery patrols are NOT firing — rule in/out other restart paths.

## Suggested evidence to gather
- Pick an active conversation; watch its JSONL byteOffset + `claudeSessionId` over time; correlate
  a shrink event with a compaction marker / session-id change / file mtime.
- Inspect `watchConversation` impl (debounce, partial-read handling, how it computes byteOffset).
- Inspect `parseConversationMessages`, `resolveJsonlPath`
  (`src/dashboard/server/routes/jsonl-resolver.ts`), `sessionFilePath`,
  `src/dashboard/server/services/conversation-service.ts`.

## Deliverable
Identify the root cause with evidence, then propose (and implement if clear) the proper
server-side fix so the watcher does not emit destructive partial/empty reset-snapshots and/or
conversations don't spuriously rotate sessions. The client guards are already in; this is the
upstream fix.

## Guardrails
- The **deacon is FROZEN** and the **flywheel is OFF** — do NOT unfreeze/enable either.
- Work on `main` (operator-directed bypass) or a feature branch; commit per change.
- This is a Node-22 dashboard; rebuild (`npm run build`) before restarting; never `bun run` the server.

---

## RESOLUTION (2026-06-13, commit `30ee23b38`)

**Root cause confirmed with evidence:** claude-code session transcripts are **append-only at a
fixed path**, so any read that shows the JSONL *shrink* is always a transient artifact, never a
real reset. The server was emitting those transient smaller reads as authoritative
`snapshot:true`, and the client replaces its transcript on a snapshot → the wipe.

Evidence ruling out each candidate:
- (a) compaction rewriting shorter — **refuted.** Both claude-native and Panopticon-native
  compaction *append* a `compact_boundary` marker (`conversation-compaction.ts` `doCompact` →
  `appendFile`); they never truncate.
- (b) session-id rotation to a fresh file — **refuted.** `claude --resume <id>` reuses the same
  session UUID/file (PAN-830 design doc line 893: "same JSONL (UUID is stable)"). A
  conversation's `claude_session_id` is only rewritten on a *harness change*
  (`setConversationClaudeSessionId`, conversations.ts:2922), not on resume/respawn. HTTP and WS
  resolve the same DB-pinned file.
- (c) transient mid-write/partial read — **this is the trigger.** A read landing in a respawn's
  truncate-rewrite window (or a partial read under load) momentarily shows `fileSize < recorded
  offset`; the watcher re-parses from 0 and emits the smaller content with `snapshot:true`.
- (d) other restart path — deacon frozen; resume reuses the same file, so respawns don't rotate.
- Live confirmation: 25 s of tight sampling of three active sessions showed monotonic growth,
  stable inode, **zero** shrink/inode-swap events. Steady state is pure append.

**Fix (server-side, the upstream fix the brief asked for):** `gateSnapshotEmission()` in
`conversation-service.ts` enforces the append-only invariant at the single emission point in
`ws-rpc.ts` `subscribeConversationMessages`. A per-subscription high-water mark of the largest
full transcript emitted; any reset that would carry *fewer* messages is downgraded from
`snapshot:true` (replace) to `snapshot:false` (merge), so the client keeps history and later
appends re-flow + dedupe. Forensic `console.warn` (`[conv-stream] …`) fires on each suppressed
shrink and on a zero-message initial parse of a non-empty file, to capture the exact trigger
next time. Unit test: `gateSnapshotEmission (PAN-1642 append-only guard)`.

**Inert until `pan reload`** — the running server (pid started 02:58) still has the old code.

**Follow-ups filed:** PAN-1850 (transcripts >10 MB truncated by the `MAX_READ_BYTES` initial-read
cap — separate missing-middle bug), PAN-1851 (flywheel should fix a red `main` before launching
feature work). The change-scoped test-gate secondary task was delivered separately by PAN-1848.
