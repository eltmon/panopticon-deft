import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http';
import { EventStoreService } from '../../services/domain-services.js';

const mockAppendFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockGetAgentState = vi.hoisted(() => vi.fn());
const mockSetAgentPaused = vi.hoisted(() => vi.fn());
const mockMarkAgentStoppedState = vi.hoisted(() => vi.fn());
const mockSaveAgentState = vi.hoisted(() => vi.fn());
const mockSaveAgentRuntimeState = vi.hoisted(() => vi.fn());
const mockSessionExists = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockCapturePane = vi.hoisted(() => vi.fn());
const mockStopWorkspaceDocker = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  };
});

vi.mock('../../../../lib/agents.js', () => ({
  getAgentState: mockGetAgentState,
  setAgentPaused: mockSetAgentPaused,
  markAgentStoppedState: mockMarkAgentStoppedState,
  saveAgentState: mockSaveAgentState,
  saveAgentRuntimeState: mockSaveAgentRuntimeState,
  getAgentDir: vi.fn(() => '/tmp/panopticon-test-agent'),
}));

vi.mock('../../../../lib/tmux.js', () => ({
  buildTmuxCommandString: vi.fn(),
  capturePane: mockCapturePane,
  killSession: mockKillSession,
  listSessions: vi.fn(() => Effect.succeed([])),
  sessionExists: mockSessionExists,
}));

vi.mock('../../../../lib/workspace-manager.js', () => ({
  stopWorkspaceDocker: mockStopWorkspaceDocker,
}));

vi.mock('../origin-validation.js', () => ({
  validateOrigin: vi.fn(() => ({ ok: true })),
}));

import { createAgentPauseHandler } from '../agents.js';
import { stopWorkspaceDocker } from '../../../../lib/workspace-manager.js';

const baseAgentState = {
  id: 'agent-pan-1316',
  issueId: 'PAN-1316',
  workspace: '/tmp/workspaces/feature-pan-1316',
  role: 'work',
  model: 'claude-opus-4-7',
  status: 'running',
  startedAt: '2026-05-25T16:00:00.000Z',
} as const;

async function runPauseHandler(agentState: Record<string, unknown>, body: Record<string, unknown> = { reason: 'maintenance' }) {
  const request = HttpServerRequest.fromWeb(new Request('http://localhost/api/agents/agent-pan-1316/pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const appendedEvents: Record<string, unknown>[] = [];
  const eventStore = {
    append: (event: Record<string, unknown>) => Effect.sync(() => {
      appendedEvents.push(event);
      return appendedEvents.length;
    }),
    appendAsync: (event: Record<string, unknown>) => Effect.sync(() => {
      appendedEvents.push(event);
      return appendedEvents.length;
    }),
  };
  const ctx = Context.make(HttpServerRequest.HttpServerRequest, request).pipe(
    Context.add(HttpRouter.RouteContext, { params: { id: 'agent-pan-1316' }, route: {} as any }),
    Context.add(EventStoreService, eventStore as any),
  );

  const response = await Effect.runPromise(Effect.provide(createAgentPauseHandler(), Layer.succeedContext(ctx)));
  return { response, appendedEvents };
}

describe('createAgentPauseHandler Docker teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockGetAgentState.mockReturnValue(Effect.succeed(baseAgentState));
    mockSetAgentPaused.mockImplementation((id: string, reason: string | undefined, stoppedByPause: boolean) => Effect.succeed({
      ...baseAgentState,
      id,
      paused: true,
      pausedReason: reason,
      stoppedByPause,
    }));
    mockMarkAgentStoppedState.mockImplementation((state) => ({ ...state, status: 'stopped' }));
    mockSaveAgentState.mockReturnValue(Effect.void);
    mockSaveAgentRuntimeState.mockResolvedValue(undefined);
    mockSessionExists.mockReturnValue(Effect.succeed(true));
    mockKillSession.mockReturnValue(Effect.void);
    mockCapturePane.mockReturnValue(Effect.succeed(''));
    mockStopWorkspaceDocker.mockReturnValue(Effect.succeed({ containersFound: true, steps: ['compose down'] }));
  });

  it('stops the workspace Docker stack when pause stops a live agent', async () => {
    await runPauseHandler(baseAgentState);

    expect(stopWorkspaceDocker).toHaveBeenCalledOnce();
    expect(stopWorkspaceDocker).toHaveBeenCalledWith('/tmp/workspaces/feature-pan-1316', 'pan-1316');
  });

  it('does not stop Docker when pause does not stop an already stopped agent', async () => {
    const stoppedAgentState = { ...baseAgentState, status: 'stopped' };
    mockGetAgentState.mockReturnValue(Effect.succeed(stoppedAgentState));
    mockSetAgentPaused.mockImplementation((id: string, reason: string | undefined, stoppedByPause: boolean) => Effect.succeed({
      ...stoppedAgentState,
      id,
      paused: true,
      pausedReason: reason,
      stoppedByPause,
    }));
    mockSessionExists.mockReturnValue(Effect.succeed(false));

    await runPauseHandler(stoppedAgentState);

    expect(stopWorkspaceDocker).not.toHaveBeenCalled();
  });

  it('logs Docker teardown failures and still emits status_changed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStopWorkspaceDocker.mockReturnValue(Effect.fail(new Error('docker unavailable')));

    const { response, appendedEvents } = await runPauseHandler(baseAgentState);

    expect(response.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Docker teardown failed for agent-pan-1316'));
    expect(appendedEvents.some((event) => event.type === 'agent.status_changed')).toBe(true);

    warnSpy.mockRestore();
  });
});
