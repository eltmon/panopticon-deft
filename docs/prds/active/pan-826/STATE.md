# PAN-826 — Conversation/Terminal Integration Refactor

**Status:** Planning complete — ready for handoff
**Tracking issue:** https://github.com/eltmon/panopticon-cli/issues/826
**Spec:** `docs/prds/active/pan-826-conversation-integration-refactor-spec.md`
**Closes:** #691, #696, #612, #823, #739

## Summary

Single refactor that consolidates the long tail of "conversation view doesn't match the terminal" symptoms. Five subsystems land together:

1. **Parser correctness** — persistent ParseState across incremental parses, `(createdAt, sequence)` tiebreaker everywhere, compact_boundary handling, duplicate-id audit.
2. **Tmux delivery verification** — replace fixed-delay `sendKeysAsync` with paste→capture-pane verify→Enter→capture-pane verify, with structured `MessageDeliveryFailed` error and busy-state detection.
3. **Instant-start** — clicking `+` mounts a live conversation; tmux + Claude spawn synchronously inside the POST handler. Delete `DraftConversationPanel`, `sessionAlive` grace window, frontend message-arrival polling.
4. **Thinking blocks** — expand/collapse UX parity with Bash entries; **prevent** signature corruption at write-time (strip in `copySessionFromCompactBoundary`, `--no-resume` on all specialists, fork option flags) — **no JSONL repair**.
5. **Failed user sends + outbox** — SQLite-backed local outbox for HTTP-layer optimistic-send failures with retry/edit/copy/discard. **Tmux delivery failures route to a separate dashboard error surface, not the outbox.**

Plus two smaller scope items:
6. **Conversation list favorite star** — reposition persistent star into the same right-aligned column as the hover-only star.
7. **T3Code structural alignment** — split `session-logic.ts` → `MessagesTimeline.logic.ts`, rename `WorkLogEntryRow` → `SimpleWorkEntryRow`, adopt `MessagesTimelineRow` discriminated union, align `.chat-markdown*` class names. Pure structural; no feature regressions.

## Key decisions

### 1. Outbox storage: **SQLite**
New `conversation_outbox` table keyed by `conversation_id` + client-generated `prompt_id` with `status` (`pending` / `failed` / `accepted`), `prompt_text`, `error_message`, `created_at`, `last_attempt_at`. Survives `pan up` cycles. Conversation API merges JSONL rows + outbox rows in the same sort pipeline; `accepted` rows reconcile away when the prompt text + timestamp window matches in JSONL.

### 2. Recovery from corrupted thinking-block signatures: **prevent only, no automatic repair**
Per user direction, **Panopticon will not write to user JSONL files** — even renaming aside is off the table. The fix is exclusively at the write side:

- `copySessionFromCompactBoundary()` strips `signature` fields from thinking blocks in the destination JSONL (this is OUR write, not the user's session JSONL).
- All specialists (review, test, merge, inspect, uat) launch with `--no-resume` so they never hit the corruption path.
- Deacon **detects** "Invalid signature in thinking block" in agent output and **surfaces a recovery event** in the dashboard with guidance, but performs **no automatic repair** — no rename, no move, no write to the JSONL.

Rationale: prevention removes the corruption source entirely; the surviving bad-state cases pre-date this PR and the user explicitly opts to handle those manually rather than have an agent rewrite a JSONL.

### 3. Tmux failures route to a separate surface, not the outbox
`MessageDeliveryFailed` from the new tmux verification loop is a **dashboard error event** (workspace inspector entry + toast), not an entry in the user-prompt outbox. Rationale: outbox represents "the user's typed prompt is still trying to land"; tmux delivery failures are an infrastructure failure that needs visibility but doesn't carry the same user-prompt semantics. Two distinct mental models, two distinct UIs.

### 4. Sequencing: **foundation-first**
Beads land roughly in this order, with hard `blocks` edges where parser/state structure matters:

1. **Parser correctness** (ParseState persistence, sort tiebreaker, compact_boundary, duplicate-id audit + regression test fixture).
2. **Tmux verification loop** + dashboard error surface for `MessageDeliveryFailed`.
3. **Instant-start** (synchronous spawn, draft panel deletion, grace-window removal, polling removal, Playwright UAT).
4. **Thinking-block expand UX**, **signature prevention** at fork/specialist level, **fork options + warnings**, **docs refresh**.
5. **Outbox** (SQLite schema + service + API merge + frontend rendering).
6. **Conversation list favorite star repositioning**.
7. **T3Code structural alignment** — last, mechanical, sweeping rename. Carries any callers added by earlier beads.

Lower-level fixes ship before structural moves so each PR's diff stays focused.

### 5. Test strategy
- **Unit**: ParseState persistence across multiple `parseConversationMessages` invocations using the duplicate-id fixture (`~/.claude/projects/-home-eltmon-Projects/2d5ba448-3625-4e7f-beb4-0295ebf654b2.jsonl`). Vitest copies the fixture into `test/fixtures/conversations/` so the test is repo-self-contained; the file is large (~6.8MB) — keep it gitignored if size is a concern and document a one-shot copy script, OR commit it (decision deferred to the work agent based on repo conventions).
- **Integration**: tmux verification loop with a real tmux session (Vitest with fork: 'forks' to spawn tmux subprocesses); assert `MessageDeliveryFailed` raises when input region never clears.
- **Playwright UAT**: spawn an agent, fire 3 parallel tool calls + a thinking block across an incremental parse boundary, snapshot the rendered transcript, capture the terminal scrollback, assert ordering equivalence. Browser instance/profile MUST be isolated per the planning rules — do not share state with another agent's Playwright session.

## Files most affected

### Server
- `src/dashboard/server/routes/conversations.ts` — synchronous spawn; delete background queued-message task; remove sessionAlive grace; outbox endpoints; merge JSONL + outbox.
- `src/dashboard/server/services/conversation-service.ts` — ParseState moved to a per-conversation cache (lifetime = conversation); two-pass pairing preserved; sort tiebreaker; duplicate-id key audit.
- `src/lib/tmux.ts` — new verification helpers (`pasteAndVerify`, `submitAndVerify`, busy-state detector); `sendKeysAsync` reimplemented atop them or replaced.
- `src/lib/cloister/deacon.ts` — "Invalid signature in thinking block" detector (surface only, no JSONL writes).
- `src/lib/cloister/{review,test,merge,inspect,uat}-agent.ts` (and any helper that spawns specialists) — `--no-resume` on every spawn path.
- `src/lib/conversations/summary-fork.ts` — strip `signature` from thinking blocks in `copySessionFromCompactBoundary`; surface `localSummaryOnly` and `includeThinkingInSummary` options through the fork API.
- New SQLite migration adding `conversation_outbox` table + service module.

### Frontend
- `src/dashboard/frontend/src/components/MissionControl/index.tsx` — delete `draftKey`, `handleDraftCreated`, `isDraft` branching.
- `src/dashboard/frontend/src/components/chat/DraftConversationPanel.tsx` — **DELETE**.
- `src/dashboard/frontend/src/components/chat/MessagesTimeline.tsx` — adopt `MessagesTimelineRow` discriminated union; thinking-block expand toggle; render outbox failure rows.
- `src/dashboard/frontend/src/components/chat/session-logic.ts` → **rename** `MessagesTimeline.logic.ts`; replace lexicographic compare with `(createdAt, sequence)` tiebreaker.
- `WorkLogEntryRow` → **rename** `SimpleWorkEntryRow`; thinking expand inline.
- `src/dashboard/frontend/src/components/MissionControl/ConversationList.tsx` — move persistent favorited star into `.conversationActions` slot (no hover fade for the persistent variant).
- `src/dashboard/frontend/src/components/MissionControl/ForkModal.tsx` — `localSummaryOnly` + `includeThinkingInSummary` checkboxes; model-switch warning.
- CSS module — align `.chat-markdown`, `.chat-markdown-codeblock`, `.chat-markdown-copy-button`, `.chat-markdown-shiki` with T3Code.

### Docs
- `docs/FORKS.md` — full rewrite: summary vs plain semantics, thinking-block behavior, token cost, cross-model gotchas.
- `docs/MISSION-CONTROL.md` — new "Forks" section linking out.

## Open items left to the work agent

- **Fixture commit decision**: decide whether to commit the ~6.8MB duplicate-id JSONL fixture or generate a minimal synthetic fixture from it. Prefer synthetic if the structural duplication can be reproduced in a few hundred bytes.
- **Outbox migration rollout**: confirm the SQLite migration runner picks up new files automatically; add a startup self-heal if schema is missing.
- **Thinking-block expanded styling**: prose vs `pre` rendering — match T3Code's treatment if they have one; otherwise mild prose styling.

## Non-goals (reaffirmed)

- No Claude Code JSONL format changes.
- No Mission Control layout changes outside the conversation pane.
- No Markdown / Shiki rendering changes (class names align only).
- No JSONL repair or rewrite from any Panopticon code path. Prevention only.
- No new dashboard pages, panels, or routes.
