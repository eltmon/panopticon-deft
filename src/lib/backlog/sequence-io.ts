import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { queueAutoCommit } from '../pan-dir/auto-commit.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SequenceSize = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type SequenceImportance = 'critical' | 'high' | 'medium' | 'low';
export type SequenceCondition = 'ok' | 'needs-refinement' | 'stale';
export type SequencePass = 'creation' | 'incremental' | 'review';
export type SequenceGate = 'auto' | 'ready' | 'blocked';
export type SequencePlanningPolicy = 'skip' | 'auto' | 'interactive';
export type SequenceEdgeType = 'unblocks' | 'informs';
export type SequenceEdgeSource = 'github-ref' | 'operator' | 'ai-inferred';

export interface SequenceNode {
  issue: string;
  rank: number;
  size: SequenceSize;
  importance: SequenceImportance;
  score: number;
  condition: SequenceCondition;
  gate: SequenceGate;
  planningPolicy: SequencePlanningPolicy;
  dependsOn: string[];
  why: string;
  rationale?: string;
}

export interface SequenceEdge {
  from: string;
  to: string;
  type: SequenceEdgeType;
  source: SequenceEdgeSource;
  confidence?: number;
}

export interface SequenceDoc {
  version: number;
  project: string;
  generatedAt: string;
  model: string;
  pass: SequencePass;
  lastReviewPass?: string;
  openCount: number;
  nodes: SequenceNode[];
  edges: SequenceEdge[];
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export const BACKLOG_DIR = '.pan/backlog';
export const SEQUENCE_FILENAME = 'sequence.md';

export function sequencePath(projectRoot: string): string {
  return join(projectRoot, BACKLOG_DIR, SEQUENCE_FILENAME);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const FENCED_JSON_RE = /```json\r?\n([\s\S]*?)\r?\n```/;

export function parseSequence(md: string): SequenceDoc | null {
  const match = FENCED_JSON_RE.exec(md);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return validateSequenceDoc(parsed);
  } catch {
    return null;
  }
}

function validateSequenceDoc(raw: unknown): SequenceDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;
  if (doc['version'] !== 1) return null;
  if (typeof doc['project'] !== 'string') return null;
  if (typeof doc['generatedAt'] !== 'string') return null;
  if (typeof doc['model'] !== 'string') return null;
  if (!Array.isArray(doc['nodes'])) return null;
  if (!Array.isArray(doc['edges'])) return null;

  const nodes = (doc['nodes'] as unknown[]).map(coerceNode).filter((n): n is SequenceNode => n !== null);
  const edges = (doc['edges'] as unknown[]).map(coerceEdge).filter((e): e is SequenceEdge => e !== null);

  return {
    version: 1,
    project: doc['project'] as string,
    generatedAt: doc['generatedAt'] as string,
    model: doc['model'] as string,
    pass: coercePass(doc['pass']),
    lastReviewPass: typeof doc['lastReviewPass'] === 'string' ? doc['lastReviewPass'] : undefined,
    openCount: typeof doc['openCount'] === 'number' ? doc['openCount'] : nodes.length,
    nodes,
    edges,
  };
}

function coerceNode(raw: unknown): SequenceNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  if (typeof n['issue'] !== 'string' || typeof n['rank'] !== 'number') return null;
  return {
    issue: n['issue'] as string,
    rank: n['rank'] as number,
    size: coerceSize(n['size']),
    importance: coerceImportance(n['importance']),
    score: typeof n['score'] === 'number' ? n['score'] : 50,
    condition: coerceCondition(n['condition']),
    gate: coerceGate(n['gate']),
    planningPolicy: coercePlanningPolicy(n['planningPolicy']),
    dependsOn: Array.isArray(n['dependsOn']) ? (n['dependsOn'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    why: typeof n['why'] === 'string' ? n['why'] : '',
    rationale: typeof n['rationale'] === 'string' ? n['rationale'] : undefined,
  };
}

function coerceEdge(raw: unknown): SequenceEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') return null;
  return {
    from: e['from'] as string,
    to: e['to'] as string,
    type: (e['type'] === 'informs' ? 'informs' : 'unblocks') as SequenceEdgeType,
    source: coerceEdgeSource(e['source']),
    confidence: typeof e['confidence'] === 'number' ? e['confidence'] : undefined,
  };
}

function coerceSize(v: unknown): SequenceSize {
  return (['XS', 'S', 'M', 'L', 'XL'] as const).includes(v as SequenceSize) ? (v as SequenceSize) : 'M';
}
function coerceImportance(v: unknown): SequenceImportance {
  return (['critical', 'high', 'medium', 'low'] as const).includes(v as SequenceImportance) ? (v as SequenceImportance) : 'medium';
}
function coerceCondition(v: unknown): SequenceCondition {
  return (['ok', 'needs-refinement', 'stale'] as const).includes(v as SequenceCondition) ? (v as SequenceCondition) : 'ok';
}
function coercePass(v: unknown): SequencePass {
  return (['creation', 'incremental', 'review'] as const).includes(v as SequencePass) ? (v as SequencePass) : 'incremental';
}
function coerceGate(v: unknown): SequenceGate {
  return (['auto', 'ready', 'blocked'] as const).includes(v as SequenceGate) ? (v as SequenceGate) : 'auto';
}
function coercePlanningPolicy(v: unknown): SequencePlanningPolicy {
  return (['skip', 'auto', 'interactive'] as const).includes(v as SequencePlanningPolicy) ? (v as SequencePlanningPolicy) : 'auto';
}
function coerceEdgeSource(v: unknown): SequenceEdgeSource {
  return (['github-ref', 'operator', 'ai-inferred'] as const).includes(v as SequenceEdgeSource) ? (v as SequenceEdgeSource) : 'ai-inferred';
}

// ─── Writer ───────────────────────────────────────────────────────────────────

const SIZE_SYMBOLS: Record<SequenceSize, string> = { XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL' };
const IMPORTANCE_SYMBOLS: Record<SequenceImportance, string> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low',
};
const CONDITION_SYMBOLS: Record<SequenceCondition, string> = {
  ok: 'ok', 'needs-refinement': '⚠ refine', stale: '⊘ stale',
};

function renderTable(nodes: SequenceNode[]): string {
  const rows = nodes.map(n => {
    const deps = n.dependsOn.length ? n.dependsOn.join(', ') : '—';
    const cond = CONDITION_SYMBOLS[n.condition];
    return `| ${n.rank} | ${n.issue} | ${SIZE_SYMBOLS[n.size]} | ${IMPORTANCE_SYMBOLS[n.importance]} | ${cond} | ${deps} | ${n.why} |`;
  });
  return [
    '| Rank | Issue | Size | Importance | Cond | Depends on | Why (one line) |',
    '|------|-------|------|-----------|------|-----------|----------------|',
    ...rows,
  ].join('\n');
}

function renderRationale(nodes: SequenceNode[]): string {
  const withRationale = nodes.filter(n => n.rationale);
  if (withRationale.length === 0) return '';
  const sections = withRationale.map(n => `### ${n.issue} — rank ${n.rank}\n${n.rationale}`);
  return `\n## Rationale detail (top tier only)\n${sections.join('\n\n')}\n`;
}

export async function writeSequence(projectRoot: string, doc: SequenceDoc): Promise<void> {
  const dir = join(projectRoot, BACKLOG_DIR);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const filePath = join(dir, SEQUENCE_FILENAME);
  const sorted = [...doc.nodes].sort((a, b) => a.rank - b.rank);
  const ts = new Date(doc.generatedAt).toISOString();
  const header = `# Backlog Sequence — ${doc.project}\n_Last sequenced: ${ts} · model: ${doc.model} · pass: ${doc.pass} · ${doc.openCount} open_\n`;
  const table = renderTable(sorted);
  const rationale = renderRationale(sorted);
  const json = JSON.stringify({ ...doc, nodes: sorted }, null, 2);
  const content = `${header}\n${table}\n${rationale}\n<!-- machine-readable; do not hand-edit below this line -->\n\`\`\`json\n${json}\n\`\`\`\n`;
  await writeFile(filePath, content, 'utf-8');
  queueAutoCommit({
    projectRoot,
    paths: [filePath],
    subject: `chore(state): update backlog sequence (${doc.project})`,
  });
}

export async function readSequence(projectRoot: string): Promise<SequenceDoc | null> {
  const filePath = sequencePath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    const md = await readFile(filePath, 'utf-8');
    return parseSequence(md);
  } catch {
    return null;
  }
}

export function readSequenceSync(projectRoot: string): SequenceDoc | null {
  const filePath = sequencePath(projectRoot);
  if (!existsSync(filePath)) return null;
  try {
    const md = readFileSync(filePath, 'utf-8');
    return parseSequence(md);
  } catch {
    return null;
  }
}

export async function updateNodeGate(
  projectRoot: string,
  issueId: string,
  gate: SequenceGate,
): Promise<{ ok: boolean; error?: string }> {
  const doc = await readSequence(projectRoot);
  if (!doc) return { ok: false, error: 'No sequence file found' };
  const node = doc.nodes.find(n => n.issue.toUpperCase() === issueId.toUpperCase());
  if (!node) return { ok: false, error: `Issue ${issueId} not found in sequence` };
  node.gate = gate;
  doc.generatedAt = new Date().toISOString();
  await writeSequence(projectRoot, doc);
  return { ok: true };
}
