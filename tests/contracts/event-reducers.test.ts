/**
 * Unit tests for agent runtime event reducers (PAN-800)
 */

import { describe, it, expect } from 'vitest'
import {
  applyEvent,
  INITIAL_READ_MODEL_STATE,
  AgentActivityChangedEvent,
  AgentThinkingStartedEvent,
  AgentThinkingStoppedEvent,
  AgentWaitingStartedEvent,
  AgentWaitingClearedEvent,
  AgentMessageReceivedEvent,
  AgentModelSetEvent,
  AgentStateRestoredEvent,
} from '@panopticon/contracts'

const agentId = 'agent-1'
const ts = '2026-04-23T12:00:00.000Z'

function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  seq = 1
): Parameters<typeof applyEvent>[1] {
  return { type, sequence: seq, timestamp: ts, payload } as any
}

// ─── agent.activity_changed ──────────────────────────────────────────────────

describe('agent.activity_changed', () => {
  it('creates a default snapshot for unknown agents', () => {
    const ev = makeEvent('agent.activity_changed', { agentId, activity: 'working', currentTool: 'Bash' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toMatchObject({
      id: agentId,
      activity: 'working',
      currentTool: 'Bash',
      lastActivity: ts,
      updatedAtSequence: 1,
    })
  })

  it('clears thinking when activity changes away from thinking', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'thinking' as const,
          thinking: { since: ts, lastToolAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.activity_changed', { agentId, activity: 'working' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].thinking).toBeUndefined()
    expect(next.agentRuntimeById[agentId].activity).toBe('working')
  })

  it('clears waiting when activity changes away from waiting', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'waiting' as const,
          waiting: { reason: 'tool_permission' as const, startedAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.activity_changed', { agentId, activity: 'idle' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].waiting).toBeUndefined()
    expect(next.agentRuntimeById[agentId].activity).toBe('idle')
  })

  it('bumps runtimeSnapshotSequence on the lifecycle snapshot', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentsById: { [agentId]: { id: agentId, issueId: 'ISS-1', status: 'running' as const } },
    }
    const ev = makeEvent('agent.activity_changed', { agentId, activity: 'working' }, 5)
    const next = applyEvent(prev, ev)
    expect(next.agentsById[agentId].runtimeSnapshotSequence).toBe(5)
  })
})

// ─── agent.thinking_started ──────────────────────────────────────────────────

describe('agent.thinking_started', () => {
  it('sets thinking state and activity', () => {
    const ev = makeEvent('agent.thinking_started', { agentId, lastToolAt: ts })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toMatchObject({
      id: agentId,
      activity: 'thinking',
      thinking: { since: ts, lastToolAt: ts },
      lastActivity: ts,
      updatedAtSequence: 1,
    })
  })
})

// ─── agent.thinking_stopped ──────────────────────────────────────────────────

describe('agent.thinking_stopped', () => {
  it('resolves to working when resolvedBy is tool', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'thinking' as const,
          thinking: { since: ts, lastToolAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.thinking_stopped', { agentId, resolvedBy: 'tool' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].activity).toBe('working')
    expect(next.agentRuntimeById[agentId].thinking).toBeUndefined()
  })

  it('resolves to waiting when resolvedBy is waiting', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'thinking' as const,
          thinking: { since: ts, lastToolAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.thinking_stopped', { agentId, resolvedBy: 'waiting' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].activity).toBe('waiting')
  })

  it('resolves to idle when resolvedBy is idle', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'thinking' as const,
          thinking: { since: ts, lastToolAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.thinking_stopped', { agentId, resolvedBy: 'idle' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].activity).toBe('idle')
  })

  it('returns state unchanged when agent has no runtime snapshot', () => {
    const ev = makeEvent('agent.thinking_stopped', { agentId, resolvedBy: 'tool' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toBeUndefined()
  })
})

// ─── agent.waiting_started ───────────────────────────────────────────────────

describe('agent.waiting_started', () => {
  it('sets waiting state and activity', () => {
    const ev = makeEvent('agent.waiting_started', { agentId, reason: 'user_question', message: 'What next?' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toMatchObject({
      id: agentId,
      activity: 'waiting',
      waiting: { reason: 'user_question', startedAt: ts, message: 'What next?' },
      lastActivity: ts,
      updatedAtSequence: 1,
    })
  })
})

// ─── agent.waiting_cleared ───────────────────────────────────────────────────

describe('agent.waiting_cleared', () => {
  it('resumes to working when clearedBy is tool_resumed', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'waiting' as const,
          waiting: { reason: 'tool_permission' as const, startedAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.waiting_cleared', { agentId, clearedBy: 'tool_resumed' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].activity).toBe('working')
    expect(next.agentRuntimeById[agentId].waiting).toBeUndefined()
  })

  it('resumes to thinking when clearedBy is user_response', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'waiting' as const,
          waiting: { reason: 'user_question' as const, startedAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.waiting_cleared', { agentId, clearedBy: 'user_response' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].activity).toBe('thinking')
  })

  it('returns to idle for timeout or stopped', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'waiting' as const,
          waiting: { reason: 'other' as const, startedAt: ts },
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const evTimeout = makeEvent('agent.waiting_cleared', { agentId, clearedBy: 'timeout' }, 2)
    const nextTimeout = applyEvent(prev, evTimeout)
    expect(nextTimeout.agentRuntimeById[agentId].activity).toBe('idle')

    const evStopped = makeEvent('agent.waiting_cleared', { agentId, clearedBy: 'stopped' }, 3)
    const nextStopped = applyEvent(prev, evStopped)
    expect(nextStopped.agentRuntimeById[agentId].activity).toBe('idle')
  })

  it('returns state unchanged when agent has no runtime snapshot', () => {
    const ev = makeEvent('agent.waiting_cleared', { agentId, clearedBy: 'timeout' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toBeUndefined()
  })
})

// ─── agent.message_received ──────────────────────────────────────────────────

describe('agent.message_received', () => {
  it('updates lastMessageAt', () => {
    const ev = makeEvent('agent.message_received', { agentId, direction: 'to_agent', source: 'user' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId].lastMessageAt).toBe(ts)
    expect(next.agentRuntimeById[agentId].lastActivity).toBe(ts)
  })
})

// ─── agent.model_set ─────────────────────────────────────────────────────────

describe('agent.model_set', () => {
  it('sets model and claudeSessionId', () => {
    const ev = makeEvent('agent.model_set', { agentId, model: 'claude-opus-4-7', claudeSessionId: 'sess-123' })
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toMatchObject({
      model: 'claude-opus-4-7',
      claudeSessionId: 'sess-123',
      lastActivity: ts,
      updatedAtSequence: 1,
    })
  })

  it('preserves existing claudeSessionId when not provided', () => {
    const prev = {
      ...INITIAL_READ_MODEL_STATE,
      agentRuntimeById: {
        [agentId]: {
          id: agentId,
          activity: 'idle' as const,
          claudeSessionId: 'existing-sess',
          lastActivity: ts,
          updatedAtSequence: 0,
        },
      },
    }
    const ev = makeEvent('agent.model_set', { agentId, model: 'claude-sonnet-4-6' }, 2)
    const next = applyEvent(prev, ev)
    expect(next.agentRuntimeById[agentId].claudeSessionId).toBe('existing-sess')
    expect(next.agentRuntimeById[agentId].model).toBe('claude-sonnet-4-6')
  })
})

// ─── agent.state_restored ────────────────────────────────────────────────────

describe('agent.state_restored', () => {
  it('restores a full snapshot from the payload', () => {
    const snapshot = {
      id: agentId,
      activity: 'working' as const,
      currentTool: 'Bash',
      lastActivity: ts,
      updatedAtSequence: 0,
    }
    const ev = makeEvent('agent.state_restored', { agentId, snapshot }, 10)
    const next = applyEvent(INITIAL_READ_MODEL_STATE, ev)
    expect(next.agentRuntimeById[agentId]).toMatchObject({
      ...snapshot,
      updatedAtSequence: 10,
    })
  })
})
