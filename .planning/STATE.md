# 800: Effect-native agent state consolidation

## Status: In Progress

## Current Phase
Phase 5 — Consumer migration + cleanup: Migrate 22 `tmux capture-pane` call sites to read from `AgentStateService` instead of files. Delete old functions (`getAgentRuntimeState`, `confirmDelivery`, `parseThinkingDuration`, `checkLazyAgent`, etc.). Remove transitional runtime.json writes from hooks once consumers are migrated.

## Completed Work
- [x] Phase 1 — Contracts: types, events, reducers, unit tests (commit: 5436645e)
- [x] Phase 2 — Service: `AgentStateService` with `SubscriptionRef`, bootstrap, projection_cache (commit: 5e19dee8)
- [x] Phase 3 — Ingestion endpoint + `session-start-hook` install (commit: b06e608b)
- [x] Phase 4 — Hook migration (all hooks become POST emitters) (commit: 28861293)

## Remaining Work
- [x] Phase 5 — Consumer migration + cleanup (partial, see below)

### Phase 5 completed
- Migrated GET /api/agents to use AgentStateService for isIdle detection
- Removed unused `getAgentRuntimeState` (sync) imports from server routes
- Removed legacy heartbeat body mapping from POST /api/agents/:id/heartbeat
- Stopped writing `heartbeats/` directory in heartbeat-hook

### Phase 5 remaining
- Migrate remaining server routes (mission-control.ts, specialists.ts, workspaces.ts) to AgentStateService
- Delete `getAgentRuntimeState` (sync) and update ~25 callers in src/lib/
- Delete `saveAgentRuntimeState` and update ~15 callers in src/lib/ and server routes
- Delete `confirmDelivery` from src/lib/tmux.ts
- Delete `parseThinkingDuration`, `checkLazyAgent`, `checkStuckWorkAgents` from src/lib/cloister/deacon.ts
- Migrate ~14 `capturePane` call sites in src/lib/cloister/ and src/dashboard/server/
- Remove transitional runtime.json writes from hooks once all consumers are migrated
- Update tests for deleted functions

## Key Decisions
- Follow existing `Record<string, T>` pattern in `ReadModelState` rather than introducing `HashMap` in the shared reducer (the service layer can use `SubscriptionRef<HashMap>` internally).
- `AgentRuntimeSnapshot` lives in contracts as an Effect `Schema` so both server and frontend share it.
- `runtimeSnapshotSequence` added to `AgentSnapshot` so the inspector/kanban can cheaply detect runtime updates.

## Specialist Feedback
- [none]
