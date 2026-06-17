/**
 * Backlog Sequencer routes (PAN-1866)
 *
 *   GET  /api/backlog/sequence            — parsed sequence joined with live state
 *   POST /api/backlog/sequence/regenerate — trigger sequencer agent
 *   POST /api/backlog/sequence/gate       — set per-issue pickup gate
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServerRequest } from 'effect/unstable/http';
import { jsonResponse } from '../http-helpers.js';
import { httpHandler } from './http-handler.js';
import { rejectUnauthorizedDashboardRequest, rejectUnsafeDashboardMutationRequest } from './dashboard-auth.js';
import { listProjectsSync, resolveProjectFromIssueSync } from '../../../lib/projects.js';
import { readSequence, updateNodeGate, type SequenceDoc, type SequenceGate, type SequenceNode } from '../../../lib/backlog/sequence-io.js';
import { listAllAgents } from '../../../lib/database/agents-db.js';
import { spawnSequencer } from '../../../lib/cloister/sequencer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProjectPath(projectKey?: string): string {
  if (projectKey) {
    // try to resolve via issue-prefix lookup (e.g. "PAN" → project path)
    const fakeIssueId = `${projectKey}-1`;
    const resolved = resolveProjectFromIssueSync(fakeIssueId);
    if (resolved) return resolved.projectPath;
    // fall through to first project match
    const projects = listProjectsSync();
    const match = projects.find(p => p.key.toUpperCase() === projectKey.toUpperCase());
    if (match) return match.config.path;
  }
  // Default: first configured project or cwd
  const projects = listProjectsSync();
  if (projects.length > 0 && projects[0]) return projects[0].config.path;
  return process.cwd();
}

function hasDraftForIssue(projectRoot: string, issueId: string): boolean {
  return existsSync(join(projectRoot, '.pan', 'drafts', `${issueId}.md`));
}

async function hasSpecForIssue(projectRoot: string, issueId: string): Promise<boolean> {
  const specsDir = join(projectRoot, '.pan', 'specs');
  if (!existsSync(specsDir)) return false;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(specsDir);
    return entries.some(f => f.toUpperCase().includes(issueId.toUpperCase()) && f.endsWith('.json'));
  } catch {
    return false;
  }
}

const ACTIVE_STATUSES = new Set(['running', 'starting', 'paused']);

function roleToPipelinePhase(role: string): string {
  switch (role) {
    case 'plan': return 'planning_active';
    case 'work': return 'in_progress_work_running';
    case 'review': return 'in_review_reviewers_running';
    case 'ship': return 'merging';
    case 'test': return 'testing_running';
    case 'flywheel': return 'in_progress_work_running';
    default: return 'generic';
  }
}

interface SequenceNodeEnriched extends SequenceNode {
  hasDraft: boolean;
  hasSpec: boolean;
  inPipeline: boolean;
  pipelinePhase: string | null;
}

async function enrichNodes(projectRoot: string, nodes: SequenceNode[]): Promise<SequenceNodeEnriched[]> {
  const allAgents = listAllAgents();
  const activeByIssue = new Map<string, { role: string }>();
  for (const agent of allAgents) {
    if (ACTIVE_STATUSES.has(agent.status) && agent.issueId) {
      const key = agent.issueId.toUpperCase();
      if (!activeByIssue.has(key)) {
        activeByIssue.set(key, { role: agent.role });
      }
    }
  }

  return Promise.all(
    nodes.map(async n => {
      const activeAgent = activeByIssue.get(n.issue.toUpperCase());
      return {
        ...n,
        hasDraft: hasDraftForIssue(projectRoot, n.issue),
        hasSpec: await hasSpecForIssue(projectRoot, n.issue),
        inPipeline: activeAgent != null,
        pipelinePhase: activeAgent ? roleToPipelinePhase(activeAgent.role) : null,
      };
    })
  );
}

// ─── Route handlers ───────────────────────────────────────────────────────────

const getBacklogSequenceRoute = HttpRouter.add(
  'GET',
  '/api/backlog/sequence',
  rejectUnauthorizedDashboardRequest(
    httpHandler(Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const projectKey = HttpServerRequest.toURL(request).pipe(Option.match({
        onNone: () => undefined,
        onSome: (url) => url.searchParams.get('project') ?? undefined,
      }));
      const projectRoot = getProjectPath(projectKey);

      const doc: SequenceDoc | null = yield* Effect.promise(() => readSequence(projectRoot));

      if (!doc) {
        return jsonResponse({ ok: false, error: 'No sequence file found', projectRoot }, { status: 404 });
      }

      const enriched = yield* Effect.promise(() => enrichNodes(projectRoot, doc.nodes));

      return jsonResponse({
        ok: true,
        projectRoot,
        project: doc.project,
        generatedAt: doc.generatedAt,
        model: doc.model,
        pass: doc.pass,
        lastReviewPass: doc.lastReviewPass,
        openCount: doc.openCount,
        nodes: enriched,
        edges: doc.edges,
      });
    }))
  )
);

const postBacklogRegenerateRoute = HttpRouter.add(
  'POST',
  '/api/backlog/sequence/regenerate',
  rejectUnsafeDashboardMutationRequest(
    rejectUnauthorizedDashboardRequest(
      httpHandler(Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text;
        let body: Record<string, unknown> = {};
        try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* ignore */ }
        const projectKey = typeof body?.['project'] === 'string' ? body['project'] : undefined;
        const passType = body?.['pass'] === 'review' ? 'review' : 'incremental';
        const projectRoot = getProjectPath(projectKey);

        const agent = yield* Effect.promise(() =>
          spawnSequencer({
            projectRoot,
            projectKey: projectKey,
            passType: passType as 'creation' | 'incremental' | 'review',
          })
        );

        return jsonResponse({
          ok: true,
          message: `Sequencer ${passType} pass started`,
          projectRoot,
          pass: passType,
          agentId: agent.id,
        });
      }))
    )
  )
);

const postBacklogGateRoute = HttpRouter.add(
  'POST',
  '/api/backlog/sequence/gate',
  rejectUnsafeDashboardMutationRequest(
    rejectUnauthorizedDashboardRequest(
      httpHandler(Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text;
        let body: Record<string, unknown> = {};
        try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* ignore */ }
        const issueId = typeof body?.['issueId'] === 'string' ? body['issueId'] : null;
        const gate = typeof body?.['gate'] === 'string' ? body['gate'] as SequenceGate : null;
        const projectKey = typeof body?.['project'] === 'string' ? body['project'] : undefined;

        if (!issueId || !gate || !(['auto', 'ready', 'blocked'] as SequenceGate[]).includes(gate)) {
          return jsonResponse({ ok: false, error: 'issueId and gate (auto|ready|blocked) are required' }, { status: 400 });
        }

        const projectRoot = getProjectPath(projectKey);
        const result = yield* Effect.promise(() => updateNodeGate(projectRoot, issueId, gate));

        if (!result.ok) {
          return jsonResponse({ ok: false, error: result.error }, { status: 404 });
        }

        return jsonResponse({ ok: true, issueId, gate });
      }))
    )
  )
);

// ─── Layer export ─────────────────────────────────────────────────────────────

export const backlogRouteLayer = Layer.mergeAll(
  getBacklogSequenceRoute,
  postBacklogRegenerateRoute,
  postBacklogGateRoute,
);

export default backlogRouteLayer;
