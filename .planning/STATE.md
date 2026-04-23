# 800: Effect-native agent state consolidation

## Status: In Progress

## Current Phase
Phase 3 — Ingestion endpoint + SessionStart hook install: Reshape `POST /api/agents/:id/heartbeat` into a Schema-validated, event-emitting handler. Add legacy body mapping. Install `session-start-hook` and register it in `~/.claude/settings.json` via the `pan setup hooks` path.

## Completed Work
- [x] Phase 1 — Contracts: types, events, reducers, unit tests (commit: 5436645e)
- [x] Phase 2 — Service: `AgentStateService` with `SubscriptionRef`, bootstrap, projection_cache (commit: 5e19dee8)

## Remaining Work
- [ ] Phase 3 — Ingestion endpoint + `session-start-hook` install
- [ ] Phase 4 — Hook migration (all hooks become POST emitters)
- [ ] Phase 5 — Consumer migration + cleanup (22 `tmux capture-pane` call sites)

## Key Decisions
- Follow existing `Record<string, T>` pattern in `ReadModelState` rather than introducing `HashMap` in the shared reducer (the service layer can use `SubscriptionRef<HashMap>` internally).
- `AgentRuntimeSnapshot` lives in contracts as an Effect `Schema` so both server and frontend share it.
- `runtimeSnapshotSequence` added to `AgentSnapshot` so the inspector/kanban can cheaply detect runtime updates.

## Specialist Feedback
- [none]
