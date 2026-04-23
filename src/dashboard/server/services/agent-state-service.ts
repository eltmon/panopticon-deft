/**
 * AgentStateService — single source of truth for agent runtime state (PAN-800)
 *
 * Canonical in-memory SubscriptionRef derived from the append-only event stream.
 * Files become bootstrap/persistence only. Hooks emit typed events; this service
 * folds them into AgentRuntimeSnapshot records.
 */

import { Effect, Layer, Option, ServiceMap, Stream, SubscriptionRef } from 'effect';
import type {
  AgentRuntimeSnapshot,
  DomainEvent,
} from '@panopticon/contracts';
import { applyEvent, INITIAL_READ_MODEL_STATE } from '@panopticon/contracts';
import { EventStoreService } from './domain-services.js';
import type { StoredEvent } from '../event-store.js';
import { getProjectionCache } from './projection-cache.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentStateServiceShape {
  /** Get a single agent's runtime snapshot, if known. */
  readonly get: (agentId: string) => Effect.Effect<Option.Option<AgentRuntimeSnapshot>>;
  /** Get all known runtime snapshots. */
  readonly getAll: Effect.Effect<Record<string, AgentRuntimeSnapshot>>;
  /** Stream of snapshot map changes. */
  readonly changes: Stream.Stream<Record<string, AgentRuntimeSnapshot>>;
  /** Emit a runtime domain event (async append to event store). */
  readonly emit: (event: DomainEvent) => Effect.Effect<void>;
}

export class AgentStateService extends ServiceMap.Service<
  AgentStateService,
  AgentStateServiceShape
>()('panopticon/dashboard/AgentStateService') {}

// ─── Runtime event types ─────────────────────────────────────────────────────

const RUNTIME_EVENT_TYPES = new Set([
  'agent.activity_changed',
  'agent.thinking_started',
  'agent.thinking_stopped',
  'agent.waiting_started',
  'agent.waiting_cleared',
  'agent.message_received',
  'agent.model_set',
  'agent.state_restored',
]);

function isAgentRuntimeEvent(event: StoredEvent | DomainEvent): boolean {
  return RUNTIME_EVENT_TYPES.has(event.type);
}

/** Convert a StoredEvent to DomainEvent for the reducer. */
function storedToDomainEvent(stored: StoredEvent): DomainEvent {
  return {
    type: stored.type,
    sequence: stored.sequence,
    timestamp: stored.timestamp,
    payload: stored.payload,
  } as DomainEvent;
}

/** Apply a domain event to a runtime-snapshot map, returning only the updated map. */
function applyToRuntimeMap(
  map: Record<string, AgentRuntimeSnapshot>,
  event: DomainEvent,
): Record<string, AgentRuntimeSnapshot> {
  const miniState = { ...INITIAL_READ_MODEL_STATE, agentRuntimeById: map };
  const next = applyEvent(miniState, event);
  return next.agentRuntimeById;
}

// ─── Bootstrap helpers ───────────────────────────────────────────────────────

const AGENTS_DIR = join(homedir(), '.panopticon', 'agents');

async function discoverAgentIds(): Promise<string[]> {
  try {
    const entries = await readdir(AGENTS_DIR);
    return entries.filter((id) => existsSync(join(AGENTS_DIR, id, 'state.json')));
  } catch {
    return [];
  }
}

async function seedRuntimeFromProjectionCache(
  ref: SubscriptionRef.SubscriptionRef<Record<string, AgentRuntimeSnapshot>>,
  knownIds: string[],
): Promise<void> {
  const cache = getProjectionCache();
  let seeded = 0;
  for (const agentId of knownIds) {
    const current = await SubscriptionRef.get(ref).pipe(Effect.runPromise);
    if (current[agentId]) continue; // Already has events
    const cached = cache.loadKey(`agent-runtime:${agentId}`);
    if (cached) {
      await SubscriptionRef.update(ref, (m) => ({ ...m, [agentId]: cached as AgentRuntimeSnapshot })).pipe(
        Effect.runPromise,
      );
      seeded++;
    }
  }
  if (seeded > 0) {
    console.log(`[AgentStateService] Seeded ${seeded} agent(s) from projection cache`);
  }
}

async function seedRuntimeFromFiles(
  ref: SubscriptionRef.SubscriptionRef<Record<string, AgentRuntimeSnapshot>>,
  knownIds: string[],
): Promise<void> {
  let seeded = 0;
  for (const agentId of knownIds) {
    const current = await SubscriptionRef.get(ref).pipe(Effect.runPromise);
    if (current[agentId]) continue; // Already has events or projection cache
    const runtimePath = join(AGENTS_DIR, agentId, 'runtime.json');
    if (!existsSync(runtimePath)) continue;
    try {
      const raw = await readFile(runtimePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const snapshot: AgentRuntimeSnapshot = {
        id: agentId,
        activity: parsed.activity ?? 'idle',
        lastActivity: parsed.lastActivity ?? new Date().toISOString(),
        currentTool: parsed.currentTool ?? undefined,
        thinking: parsed.thinking ?? undefined,
        waiting: parsed.waiting ?? undefined,
        claudeSessionId: parsed.claudeSessionId ?? undefined,
        model: parsed.model ?? undefined,
        lastMessageAt: parsed.lastMessageAt ?? undefined,
        updatedAtSequence: 0,
      };
      await SubscriptionRef.update(ref, (m) => ({ ...m, [agentId]: snapshot })).pipe(Effect.runPromise);
      seeded++;
    } catch {
      // Skip unreadable runtime files
    }
  }
  if (seeded > 0) {
    console.log(`[AgentStateService] Seeded ${seeded} agent(s) from runtime.json files`);
  }
}

// ─── Live implementation ─────────────────────────────────────────────────────

export const AgentStateServiceLive = Layer.effect(
  AgentStateService,
  Effect.gen(function* () {
    const eventStore = yield* EventStoreService;
    const ref = yield* SubscriptionRef.make({} as Record<string, AgentRuntimeSnapshot>);

    // 1. Bootstrap from persisted event log
    const events = yield* eventStore.readFrom(0);
    for (const stored of events) {
      if (!isAgentRuntimeEvent(stored)) continue;
      const event = storedToDomainEvent(stored);
      yield* SubscriptionRef.update(ref, (m) => applyToRuntimeMap(m, event));
    }

    // 2. Bootstrap fallback: projection_cache, then runtime.json
    const knownIds = yield* Effect.promise(() => discoverAgentIds());
    yield* Effect.promise(() => seedRuntimeFromProjectionCache(ref, knownIds));
    yield* Effect.promise(() => seedRuntimeFromFiles(ref, knownIds));

    // 3. Subscribe forward — fold every future runtime event into the ref
    const runtimeStream = eventStore.streamEvents.pipe(
      Stream.filter(isAgentRuntimeEvent),
      Stream.map(storedToDomainEvent),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(ref, (m) => applyToRuntimeMap(m, event));
          // Persist the updated snapshot to projection_cache
          const current = yield* SubscriptionRef.get(ref);
          const snapshot = current[event.payload.agentId];
          if (snapshot) {
            try {
              getProjectionCache().saveKey(
                `agent-runtime:${event.payload.agentId}`,
                snapshot,
                event.sequence,
              );
            } catch {
              // Best-effort persistence
            }
          }
        }),
      ),
    );

    // Fork the subscription as a background daemon
    yield* Effect.forkDaemon(runtimeStream);

    return {
      get: (id) =>
        SubscriptionRef.get(ref).pipe(Effect.map((m) =>
          m[id] ? Option.some(m[id]) : Option.none()
        )),
      getAll: SubscriptionRef.get(ref),
      changes: ref.changes,
      emit: (event) =>
        eventStore.appendAsync(event).pipe(Effect.asVoid),
    };
  }),
);
