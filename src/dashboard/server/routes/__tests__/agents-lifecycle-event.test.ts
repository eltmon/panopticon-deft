/**
 * Tests for the agent stop/delete lifecycle event parameterization (PAN-1221 F1)
 *
 * Verifies that DELETE /api/agents/:id emits 'agent.delete_requested' and
 * POST /api/agents/:id/stop emits 'agent.stop_requested' to the lifecycle log.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Context, Effect, Layer } from 'effect';
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http';
import { EventStoreService } from '../../services/domain-services.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

const mockAppendFile = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockStopWorkspaceDocker = vi.hoisted(() => {
  const { Effect } = require('effect') as typeof import('effect');
  return vi.fn(() => Effect.succeed({ containersFound: true, steps: ['stopped docker'] }));
});
const mockResolveProjectFromIssueSync = vi.hoisted(() => vi.fn(() => ({ projectKey: 'panopticon', projectPath: '/project/root' })));
const mockFindWorkspacePath = vi.hoisted(() => vi.fn(() => '/resolved/by/issue/path'));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  };
});

vi.mock('../../../../lib/agents.js', () => ({
  getAgentState: vi.fn(),
  getAgentStateProgram: vi.fn(),
  stopAgent: vi.fn(),
  stopAgentProgram: vi.fn(),
}));

vi.mock('../../../../lib/activity-logger.js', () => ({
  emitActivityEntry: vi.fn(),
  emitActivityEntrySync: vi.fn(),
}));

vi.mock('../../../../lib/workspace-manager.js', () => ({
  stopWorkspaceDocker: mockStopWorkspaceDocker,
}));

vi.mock('../../../../lib/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/projects.js')>()),
  resolveProjectFromIssueSync: mockResolveProjectFromIssueSync,
}));

vi.mock('../../../../lib/lifecycle/archive-planning.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/lifecycle/archive-planning.js')>()),
  findWorkspacePath: mockFindWorkspacePath,
}));

vi.mock('../origin-validation.js', () => ({
  validateOrigin: vi.fn(() => ({ ok: true })),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { createAgentStopHandler } from '../agents.js';
import { getAgentState, stopAgent } from '../../../../lib/agents.js';

const mockGetAgentState = vi.mocked(getAgentState);
const mockStopAgent = vi.mocked(stopAgent);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runAgentStopHandler(
  lifecycleEvent: 'agent.delete_requested' | 'agent.stop_requested',
  agentId = 'agent-pan-test',
) {
  const request = HttpServerRequest.fromWeb(
    new Request('http://localhost/api/agents/' + agentId, { method: 'POST' }),
  );

  const mockEventStore = {
    append: () =>
      Effect.sync(() => {
        return 1;
      }),
  };

  const ctx = Context.make(HttpServerRequest.HttpServerRequest, request).pipe(
    Context.add(HttpRouter.RouteContext, { params: { id: agentId }, route: {} as any }),
    Context.add(EventStoreService, mockEventStore as any),
  );

  const handler = createAgentStopHandler(lifecycleEvent);
  await Effect.runPromise(Effect.provide(handler, Layer.succeedContext(ctx)));
}

function getLastAppendedLogLine(): { event?: string } | null {
  const lastCall = mockAppendFile.mock.calls.at(-1);
  if (!lastCall) return null;
  const logLine = lastCall[1] as string;
  try {
    return JSON.parse(logLine.trim());
  } catch {
    return null;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createAgentStopHandler lifecycle events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentState.mockReturnValue(Effect.succeed({
      issueId: 'PAN-TEST',
      role: 'work',
    } as any));
    mockStopAgent.mockReturnValue(Effect.void);
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockStopWorkspaceDocker.mockImplementation(() => Effect.succeed({ containersFound: true, steps: ['stopped docker'] }));
    mockResolveProjectFromIssueSync.mockReturnValue({ projectKey: 'panopticon', projectPath: '/project/root' });
    mockFindWorkspacePath.mockReturnValue('/resolved/by/issue/path');
  });

  it("emits 'agent.delete_requested' for DELETE route", async () => {
    await runAgentStopHandler('agent.delete_requested');

    expect(mockAppendFile).toHaveBeenCalled();
    const log = getLastAppendedLogLine();
    expect(log?.event).toBe('agent.delete_requested');
  });

  it("emits 'agent.stop_requested' for POST /stop route", async () => {
    await runAgentStopHandler('agent.stop_requested');

    expect(mockAppendFile).toHaveBeenCalled();
    const log = getLastAppendedLogLine();
    expect(log?.event).toBe('agent.stop_requested');
  });

  it('calls stopAgentProgram and getAgentStateProgram', async () => {
    await runAgentStopHandler('agent.stop_requested', 'agent-pan-999');

    expect(mockGetAgentState).toHaveBeenCalledWith('agent-pan-999');
    expect(mockStopAgent).toHaveBeenCalledWith('agent-pan-999');
  });
});

describe('createAgentStopHandler docker teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentState.mockReturnValue(Effect.succeed({
      issueId: 'PAN-1052',
      role: 'ship',
    } as any));
    mockStopAgent.mockReturnValue(Effect.void);
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockStopWorkspaceDocker.mockImplementation(() => Effect.succeed({ containersFound: true, steps: ['stopped docker'] }));
    mockResolveProjectFromIssueSync.mockReturnValue({ projectKey: 'panopticon', projectPath: '/project/root' });
    mockFindWorkspacePath.mockReturnValue('/resolved/by/issue/path');
  });

  it('tears down the issue workspace for a specialist without state.workspace', async () => {
    mockGetAgentState.mockReturnValue(Effect.succeed({
      issueId: 'PAN-1052',
      role: 'ship',
      workspace: undefined,
    } as any));

    await runAgentStopHandler('agent.stop_requested', 'agent-pan-1052-ship');

    expect(mockResolveProjectFromIssueSync).toHaveBeenCalledWith('PAN-1052');
    expect(mockFindWorkspacePath).toHaveBeenCalledWith('/project/root', 'pan-1052');
    expect(mockStopWorkspaceDocker).toHaveBeenCalledWith('/resolved/by/issue/path', 'pan-1052');
  });

  it('uses the issue-resolved workspace path for work agents instead of state.workspace', async () => {
    mockGetAgentState.mockReturnValue(Effect.succeed({
      issueId: 'PAN-1052',
      role: 'work',
      workspace: '/orchestrator/wrong/path',
    } as any));
    mockFindWorkspacePath.mockReturnValue('/resolved/by/issue/path');

    await runAgentStopHandler('agent.stop_requested', 'agent-pan-1052');

    expect(mockStopWorkspaceDocker).toHaveBeenCalledWith('/resolved/by/issue/path', 'pan-1052');
    expect(mockStopWorkspaceDocker).not.toHaveBeenCalledWith('/orchestrator/wrong/path', 'pan-1052');
  });

  it('skips docker teardown when agent state has no issueId', async () => {
    mockGetAgentState.mockReturnValue(Effect.succeed({
      role: 'work',
      workspace: '/workspace/path',
    } as any));

    await runAgentStopHandler('agent.stop_requested', 'agent-pan-1052');

    expect(mockFindWorkspacePath).not.toHaveBeenCalled();
    expect(mockStopWorkspaceDocker).not.toHaveBeenCalled();
  });
});
