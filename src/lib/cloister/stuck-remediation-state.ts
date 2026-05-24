import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { getPanopticonHome } from '../paths.js';

export type StuckRemediationStage = 0 | 1 | 2 | 3;

export interface StuckRemediationState {
  lastStage: StuckRemediationStage;
  lastStageAt: string;
  firstStuckAt: string;
}

function agentStateDir(agentId: string): string {
  return join(getPanopticonHome(), 'agents', agentId);
}

function statePath(agentId: string): string {
  return join(agentStateDir(agentId), 'stuck-remediation.json');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function readStuckRemediationState(agentId: string): Promise<StuckRemediationState | null> {
  const filePath = statePath(agentId);

  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as StuckRemediationState;
  } catch (error) {
    if (isMissingFile(error)) return null;
    console.warn(`Failed to read stuck-remediation state for ${agentId}:`, error);
    return null;
  }
}

export async function writeStuckRemediationState(agentId: string, state: StuckRemediationState): Promise<void> {
  await mkdir(agentStateDir(agentId), { recursive: true });
  await writeFile(statePath(agentId), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export async function clearStuckRemediationState(agentId: string): Promise<void> {
  try {
    await unlink(statePath(agentId));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
