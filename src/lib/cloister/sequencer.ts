/**
 * Backlog Sequencer agent spawn (PAN-1866)
 *
 * Spawns a sequencer-orchestrator agent that ranks the open backlog and writes
 * .pan/backlog/sequence.md. Follows the same spawn pattern as spawnFlywheelAgent.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Effect } from 'effect';
import type { AgentState } from '../agents.js';
import { spawnRun } from '../agents.js';
import { getAgent } from '../database/agents-db.js';
import { listProjectsSync, resolveProjectFromIssueSync } from '../projects.js';
import { sequencePath } from '../backlog/sequence-io.js';
import { renderPrompt } from './prompts.js';

export const SEQUENCER_AGENT_ID = 'sequencer-orchestrator';

export interface SpawnSequencerOptions {
  projectRoot?: string;
  projectKey?: string;
  passType?: 'creation' | 'incremental' | 'review';
  model?: string;
  harness?: 'claude-code' | 'pi' | 'codex';
}

function resolveProjectRoot(options: SpawnSequencerOptions): string {
  if (options.projectRoot) return options.projectRoot;
  if (options.projectKey) {
    const fakeIssueId = `${options.projectKey}-1`;
    const resolved = resolveProjectFromIssueSync(fakeIssueId);
    if (resolved) return resolved.projectPath;
    const projects = listProjectsSync();
    const match = projects.find(p => p.key.toUpperCase() === options.projectKey!.toUpperCase());
    if (match) return match.config.path;
  }
  const projects = listProjectsSync();
  if (projects.length > 0 && projects[0]) return projects[0].config.path;
  return process.cwd();
}

function resolveProjectKey(projectRoot: string, options: SpawnSequencerOptions): string {
  if (options.projectKey) return options.projectKey.toUpperCase();
  const projects = listProjectsSync();
  const match = projects.find(p => p.config.path === projectRoot);
  if (match) return match.key.toUpperCase();
  return basename(projectRoot).toUpperCase();
}

async function readPriorSequence(projectRoot: string): Promise<string | undefined> {
  const path = sequencePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

export async function spawnSequencer(options: SpawnSequencerOptions = {}): Promise<AgentState> {
  const existing = getAgent(SEQUENCER_AGENT_ID);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    throw new Error(`Sequencer agent is already ${existing.status}. Stop it before starting a new pass.`);
  }

  const projectRoot = resolveProjectRoot(options);
  const projectKey = resolveProjectKey(projectRoot, options);
  const priorSequence = await readPriorSequence(projectRoot);
  const passType = options.passType ?? (priorSequence ? 'incremental' : 'creation');

  const vars: Record<string, unknown> = {
    PASS_TYPE: passType,
    PROJECT_KEY: projectKey,
    PROJECT_ROOT: projectRoot,
  };
  if (priorSequence) {
    vars['PRIOR_SEQUENCE_SECTION'] = priorSequence;
  }

  const prompt = await Effect.runPromise(
    renderPrompt({ name: 'sequencer', vars }),
  );

  return spawnRun(SEQUENCER_AGENT_ID, 'sequencer', {
    agentId: SEQUENCER_AGENT_ID,
    workspace: projectRoot,
    prompt,
    model: options.model,
    harness: options.harness,
    allowHost: true,
    registerConversation: false,
  });
}
