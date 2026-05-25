import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

const agentMocks = vi.hoisted(() => ({
  getAgentStateSync: vi.fn(),
  setAgentPausedSync: vi.fn(),
  stopAgentSync: vi.fn(),
}));

const tmuxMocks = vi.hoisted(() => ({
  sessionExistsSync: vi.fn(),
}));

const issueIdMocks = vi.hoisted(() => ({
  resolveIssueIdSync: vi.fn(),
}));

const interventionMocks = vi.hoisted(() => ({
  appendOperatorInterventionEvent: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  stopWorkspaceDocker: vi.fn(),
}));

vi.mock('../../../lib/agents.js', () => ({
  getAgentStateSync: agentMocks.getAgentStateSync,
  setAgentPausedSync: agentMocks.setAgentPausedSync,
  stopAgentSync: agentMocks.stopAgentSync,
}));

vi.mock('../../../lib/tmux.js', () => ({
  sessionExistsSync: tmuxMocks.sessionExistsSync,
}));

vi.mock('../../../lib/issue-id.js', () => ({
  resolveIssueIdSync: issueIdMocks.resolveIssueIdSync,
}));

vi.mock('../../../lib/operator-interventions.js', () => ({
  appendOperatorInterventionEvent: interventionMocks.appendOperatorInterventionEvent,
}));

vi.mock('../../../lib/workspace-manager.js', () => ({
  stopWorkspaceDocker: workspaceMocks.stopWorkspaceDocker,
}));

import { pauseCommand } from '../pause.js';

const runningAgentState = {
  id: 'agent-pan-1316',
  issueId: 'PAN-1316',
  workspace: '/tmp/workspaces/feature-pan-1316',
  role: 'work',
  model: 'claude-opus-4-7',
  status: 'running',
  startedAt: '2026-05-25T16:00:00.000Z',
};

describe('pauseCommand Docker teardown', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    issueIdMocks.resolveIssueIdSync.mockReturnValue('PAN-1316');
    agentMocks.getAgentStateSync.mockReturnValue(runningAgentState);
    tmuxMocks.sessionExistsSync.mockReturnValue(true);
    interventionMocks.appendOperatorInterventionEvent.mockResolvedValue(undefined);
    workspaceMocks.stopWorkspaceDocker.mockReturnValue(Effect.succeed({ containersFound: true, steps: ['compose down'] }));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('stops the workspace Docker stack when pause stops an active agent', async () => {
    await pauseCommand('PAN-1316', { reason: 'maintenance' });

    expect(agentMocks.stopAgentSync).toHaveBeenCalledWith('agent-pan-1316');
    expect(workspaceMocks.stopWorkspaceDocker).toHaveBeenCalledOnce();
    expect(workspaceMocks.stopWorkspaceDocker).toHaveBeenCalledWith('/tmp/workspaces/feature-pan-1316', 'pan-1316');
  });

  it('does not stop Docker when pause only sets the pause gate', async () => {
    agentMocks.getAgentStateSync.mockReturnValue({ ...runningAgentState, status: 'stopped' });
    tmuxMocks.sessionExistsSync.mockReturnValue(false);

    await pauseCommand('PAN-1316', {});

    expect(agentMocks.stopAgentSync).not.toHaveBeenCalled();
    expect(workspaceMocks.stopWorkspaceDocker).not.toHaveBeenCalled();
  });

  it('warns on Docker teardown failure and still prints the paused confirmation', async () => {
    workspaceMocks.stopWorkspaceDocker.mockReturnValue(Effect.fail(new Error('docker unavailable')));

    await pauseCommand('PAN-1316', { reason: 'maintenance' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Docker teardown warning: docker unavailable'));
    expect(interventionMocks.appendOperatorInterventionEvent).toHaveBeenCalledWith({
      issueId: 'PAN-1316',
      kind: 'pause',
      source: 'pan pause',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Paused and stopped agent: agent-pan-1316'));
  });
});
