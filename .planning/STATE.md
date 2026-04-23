# 800: Effect-native agent state consolidation

## Status: In Progress

## Current Phase
Phase 2 — Service: Implement `AgentStateService` with `SubscriptionRef`, bootstrap from event store replay, fallback from `projection_cache` and `runtime.json`, forward subscription to event store, and `projection_cache` persistence on every fold.

## Completed Work
- [x] Phase 1 — Contracts: types, events, reducers, unit tests (commit: 5436645e)

## Remaining Work
- [ ] Phase 2 — Service: `AgentStateService` with `SubscriptionRef`, bootstrap, projection_cache
- [ ] Phase 3 — Ingestion endpoint + `session-start-hook` install
- [ ] Phase 4 — Hook migration (all hooks become POST emitters)
- [ ] Phase 5 — Consumer migration + cleanup (22 `tmux capture-pane` call sites)

## Key Decisions
- Follow existing `Record<string, T>` pattern in `ReadModelState` rather than introducing `HashMap` in the shared reducer (the service layer can use `SubscriptionRef<HashMap>` internally).
- `AgentRuntimeSnapshot` lives in contracts as an Effect `Schema` so both server and frontend share it.
- `runtimeSnapshotSequence` added to `AgentSnapshot` so the inspector/kanban can cheaply detect runtime updates.

## Specialist Feedback
- [none]
