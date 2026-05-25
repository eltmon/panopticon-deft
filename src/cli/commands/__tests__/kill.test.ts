import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const { Effect } = require('effect') as typeof import('effect');
  return {
    stopAgentSync: vi.fn(),
    getAgentStateSync: vi.fn(),
    sessionExistsSync: vi.fn(() => true),
    isRemoteAvailable: vi.fn(async () => ({ available: false, reason: 'not configured' })),
    killRemoteAgent: vi.fn(),
    stopWorkspaceDocker: vi.fn(() => Effect.succeed({ containersFound: true, steps: ['stopped docker'] })),
    resolveProjectFromIssueSync: vi.fn(() => ({ projectKey: 'panopticon', projectPath: '/project/root' })),
    findWorkspacePath: vi.fn(() => '/resolved/by/issue/path'),
    appendOperatorInterventionEvent: vi.fn(async () => {}),
  };
});

vi.mock('../../../lib/agents.js', () => ({
  stopAgentSync: mocks.stopAgentSync,
  getAgentStateSync: mocks.getAgentStateSync,
}));

vi.mock('../../../lib/tmux.js', () => ({
  sessionExistsSync: mocks.sessionExistsSync,
}));

vi.mock('../../../lib/remote/index.js', () => ({
  isRemoteAvailable: mocks.isRemoteAvailable,
}));

vi.mock('../../../lib/remote/remote-agents.js', () => ({
  killRemoteAgent: mocks.killRemoteAgent,
}));

vi.mock('../../../lib/workspace-manager.js', () => ({
  stopWorkspaceDocker: mocks.stopWorkspaceDocker,
}));

vi.mock('../../../lib/projects.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/projects.js')>()),
  resolveProjectFromIssueSync: mocks.resolveProjectFromIssueSync,
}));

vi.mock('../../../lib/lifecycle/archive-planning.js', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/lifecycle/archive-planning.js')>()),
  findWorkspacePath: mocks.findWorkspacePath,
}));

vi.mock('../../../lib/operator-interventions.js', () => ({
  appendOperatorInterventionEvent: mocks.appendOperatorInterventionEvent,
}));

import { killCommand } from '../kill.js';

describe('killCommand docker teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionExistsSync.mockReturnValue(true);
    mocks.stopWorkspaceDocker.mockImplementation(() => {
      const { Effect } = require('effect') as typeof import('effect');
      return Effect.succeed({ containersFound: true, steps: ['stopped docker'] });
    });
    mocks.resolveProjectFromIssueSync.mockReturnValue({ projectKey: 'panopticon', projectPath: '/project/root' });
    mocks.findWorkspacePath.mockReturnValue('/resolved/by/issue/path');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tears down the issue workspace for a specialist without state.workspace', async () => {
    mocks.getAgentStateSync.mockReturnValue({ issueId: 'PAN-1052', role: 'ship', workspace: undefined });

    await killCommand('agent-pan-1052-ship', {});

    expect(mocks.findWorkspacePath).toHaveBeenCalledWith('/project/root', 'pan-1052');
    expect(mocks.stopWorkspaceDocker).toHaveBeenCalledWith('/resolved/by/issue/path', 'pan-1052');
  });

  it('uses the issue-resolved workspace path for work agents instead of state.workspace', async () => {
    mocks.getAgentStateSync.mockReturnValue({ issueId: 'PAN-1052', role: 'work', workspace: '/orchestrator/wrong/path' });
    mocks.findWorkspacePath.mockReturnValue('/resolved/by/issue/path');

    await killCommand('PAN-1052', {});

    expect(mocks.stopWorkspaceDocker).toHaveBeenCalledWith('/resolved/by/issue/path', 'pan-1052');
    expect(mocks.stopWorkspaceDocker).not.toHaveBeenCalledWith('/orchestrator/wrong/path', 'pan-1052');
  });

  it('skips docker teardown when agent state has no issueId', async () => {
    mocks.getAgentStateSync.mockReturnValue({ role: 'work', workspace: '/workspace/path' });

    await killCommand('PAN-1052', {});

    expect(mocks.findWorkspacePath).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceDocker).not.toHaveBeenCalled();
  });
});
