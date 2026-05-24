import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  clearStuckRemediationState,
  readStuckRemediationState,
  type StuckRemediationState,
  writeStuckRemediationState,
} from '../stuck-remediation-state.js';

const originalPanopticonHome = process.env.PANOPTICON_HOME;
let testHome: string;

function stateFile(agentId: string): string {
  return join(testHome, 'agents', agentId, 'stuck-remediation.json');
}

describe('stuck-remediation state helpers', () => {
  beforeEach(() => {
    testHome = join(process.cwd(), `.tmp-stuck-remediation-${process.pid}-${Date.now()}`);
    process.env.PANOPTICON_HOME = testHome;
  });

  afterEach(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
    if (originalPanopticonHome === undefined) {
      delete process.env.PANOPTICON_HOME;
    } else {
      process.env.PANOPTICON_HOME = originalPanopticonHome;
    }
    vi.restoreAllMocks();
  });

  it('returns null when the state file is missing', async () => {
    await expect(readStuckRemediationState('agent-missing')).resolves.toBeNull();
  });

  it('returns null and logs a warning when the state file contains corrupt JSON', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const filePath = stateFile('agent-corrupt');
    mkdirSync(join(testHome, 'agents', 'agent-corrupt'), { recursive: true });
    writeFileSync(filePath, '{not-json', 'utf-8');

    await expect(readStuckRemediationState('agent-corrupt')).resolves.toBeNull();
    expect(warning).toHaveBeenCalledOnce();
  });

  it('creates the parent directory and writes pretty-printed JSON', async () => {
    const state: StuckRemediationState = {
      lastStage: 2,
      lastStageAt: '2026-05-23T12:00:00.000Z',
      firstStuckAt: '2026-05-23T11:15:00.000Z',
    };

    await writeStuckRemediationState('agent-write', state);

    expect(JSON.parse(readFileSync(stateFile('agent-write'), 'utf-8'))).toEqual(state);
    expect(readFileSync(stateFile('agent-write'), 'utf-8')).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });

  it('reads a previously written state file', async () => {
    const state: StuckRemediationState = {
      lastStage: 1,
      lastStageAt: '2026-05-23T12:00:00.000Z',
      firstStuckAt: '2026-05-23T11:40:00.000Z',
    };

    await writeStuckRemediationState('agent-read', state);

    await expect(readStuckRemediationState('agent-read')).resolves.toEqual(state);
  });

  it('is a no-op when clearing a missing state file', async () => {
    await expect(clearStuckRemediationState('agent-missing')).resolves.toBeUndefined();
  });

  it('clears an existing state file', async () => {
    await writeStuckRemediationState('agent-clear', {
      lastStage: 3,
      lastStageAt: '2026-05-23T12:00:00.000Z',
      firstStuckAt: '2026-05-23T10:30:00.000Z',
    });

    await clearStuckRemediationState('agent-clear');

    expect(existsSync(stateFile('agent-clear'))).toBe(false);
  });
});
