/**
 * BacklogSequencerPage — Backlog Sequencer tab (PAN-1866)
 *
 * Renders the AI-ranked backlog as a tiered ReactFlow+dagre DAG.
 * Top-tier (Now/Next) defaults to full DAG; Later/Someday collapse to a
 * virtualized ranked list when the node count exceeds the ~150-node budget.
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, ListOrdered, Info } from 'lucide-react';
import { BacklogDAG, type BacklogNode, type BacklogEdge, type SequenceImportance, type SequenceCondition, type SequenceGate } from '../components/backlog/BacklogDAG';

// ─── API types ────────────────────────────────────────────────────────────────

interface SequenceResponse {
  ok: boolean;
  project?: string;
  generatedAt?: string;
  model?: string;
  pass?: string;
  openCount?: number;
  nodes?: BacklogNode[];
  edges?: BacklogEdge[];
  error?: string;
}

// ─── Tier logic (derived from rank/score) ────────────────────────────────────

type Tier = 'now' | 'next' | 'later' | 'someday';

const TIER_LABELS: Record<Tier, string> = {
  now: 'Now',
  next: 'Next',
  later: 'Later',
  someday: 'Someday',
};

const NOW_CAPACITY = 10;
const NEXT_CAPACITY = 30;
const LATER_CAPACITY = 100;

function deriveTier(rank: number): Tier {
  if (rank <= NOW_CAPACITY) return 'now';
  if (rank <= NEXT_CAPACITY) return 'next';
  if (rank <= LATER_CAPACITY) return 'later';
  return 'someday';
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

type ImportanceFilter = 'all' | SequenceImportance;
type ConditionFilter = 'all' | SequenceCondition;

const IMPORTANCE_OPTS: { value: ImportanceFilter; label: string }[] = [
  { value: 'all', label: 'All importance' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const CONDITION_OPTS: { value: ConditionFilter; label: string }[] = [
  { value: 'all', label: 'All conditions' },
  { value: 'ok', label: 'OK' },
  { value: 'needs-refinement', label: '⚠ Needs refinement' },
  { value: 'stale', label: '⊘ Stale' },
];

// ─── Gate mutation ────────────────────────────────────────────────────────────

async function setGate(issueId: string, gate: SequenceGate): Promise<{ ok: boolean }> {
  const res = await fetch('/api/backlog/sequence/gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueId, gate }),
  });
  if (!res.ok) throw new Error('Failed to set gate');
  return res.json();
}

async function triggerRegenerate(pass: 'incremental' | 'review'): Promise<{ ok: boolean }> {
  const res = await fetch('/api/backlog/sequence/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass }),
  });
  if (!res.ok) throw new Error('Failed to trigger regenerate');
  return res.json();
}

// ─── Ranked list (Someday / large Later) ─────────────────────────────────────

function RankedList({ nodes, onSelect }: { nodes: BacklogNode[]; onSelect: (n: BacklogNode) => void }) {
  return (
    <div style={{ overflow: 'auto', height: '100%', background: '#0f172a' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'DM Sans, sans-serif', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #1e293b', color: '#6b7280', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px' }}>Rank</th>
            <th style={{ padding: '8px 12px' }}>Issue</th>
            <th style={{ padding: '8px 12px' }}>Size</th>
            <th style={{ padding: '8px 12px' }}>Importance</th>
            <th style={{ padding: '8px 12px' }}>Cond</th>
            <th style={{ padding: '8px 12px' }}>Flags</th>
            <th style={{ padding: '8px 12px' }}>Why</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(n => (
            <tr
              key={n.issue}
              style={{ borderBottom: '1px solid #1e293b', cursor: 'pointer', opacity: n.condition === 'stale' ? 0.5 : 1 }}
              onClick={() => onSelect(n)}
            >
              <td style={{ padding: '6px 12px', color: '#9ca3af', fontFamily: 'monospace' }}>#{n.rank}</td>
              <td style={{ padding: '6px 12px', color: '#e2e8f0', fontWeight: 600, textDecoration: n.condition === 'stale' ? 'line-through' : undefined }}>{n.issue}</td>
              <td style={{ padding: '6px 12px', color: '#9ca3af' }}>{n.size}</td>
              <td style={{ padding: '6px 12px', color: n.importance === 'critical' ? '#fca5a5' : n.importance === 'high' ? '#fdba74' : '#9ca3af' }}>{n.importance}</td>
              <td style={{ padding: '6px 12px', color: n.condition === 'needs-refinement' ? '#fde047' : n.condition === 'stale' ? '#6b7280' : '#86efac' }}>
                {n.condition === 'needs-refinement' ? '⚠ refine' : n.condition === 'stale' ? '⊘ stale' : 'ok'}
              </td>
              <td style={{ padding: '6px 12px' }}>
                {n.hasDraft && <span style={{ fontSize: 9, background: '#1e3a5f', color: '#93c5fd', padding: '1px 4px', borderRadius: 3, marginRight: 3 }}>PRD</span>}
                {n.hasSpec && <span style={{ fontSize: 9, background: '#14532d', color: '#86efac', padding: '1px 4px', borderRadius: 3 }}>✓ READY</span>}
              </td>
              <td style={{ padding: '6px 12px', color: '#9ca3af', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Rationale panel ──────────────────────────────────────────────────────────

function RationalePanel({ node, onClose, onGateChange }: {
  node: BacklogNode;
  onClose: () => void;
  onGateChange: (gate: SequenceGate) => void;
}) {
  return (
    <div style={{
      position: 'absolute', right: 0, top: 0, bottom: 0, width: 360,
      background: '#1e293b', borderLeft: '1px solid #334155', padding: 20, overflow: 'auto',
      fontFamily: 'DM Sans, sans-serif', zIndex: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 15 }}>{node.issue}</div>
        <button onClick={onClose} style={{ color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, background: '#334155', color: '#cbd5e1', padding: '2px 6px', borderRadius: 4 }}>Rank #{node.rank}</span>
        <span style={{ fontSize: 11, background: '#334155', color: '#cbd5e1', padding: '2px 6px', borderRadius: 4 }}>{node.size}</span>
        <span style={{ fontSize: 11, background: '#334155', color: node.importance === 'critical' ? '#fca5a5' : node.importance === 'high' ? '#fdba74' : '#cbd5e1', padding: '2px 6px', borderRadius: 4 }}>{node.importance}</span>
        <span style={{ fontSize: 11, background: '#334155', color: '#cbd5e1', padding: '2px 6px', borderRadius: 4 }}>score {node.score}</span>
      </div>
      {node.condition !== 'ok' && (
        <div style={{ marginBottom: 12, padding: '8px 10px', background: node.condition === 'stale' ? '#1f2937' : '#422006', borderRadius: 6 }}>
          <div style={{ color: node.condition === 'stale' ? '#9ca3af' : '#fde047', fontSize: 12, fontWeight: 600 }}>
            {node.condition === 'stale' ? '⊘ STALE — candidate to close' : '⚠ NEEDS REFINEMENT — too vague to plan'}
          </div>
        </div>
      )}
      <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12 }}>{node.why}</div>
      {node.rationale && (
        <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.6, marginBottom: 16, whiteSpace: 'pre-wrap' }}>{node.rationale}</div>
      )}
      {/* Pickup gate control */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Pickup Gate</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['auto', 'ready', 'blocked'] as SequenceGate[]).map(g => (
            <button
              key={g}
              onClick={() => onGateChange(g)}
              style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: node.gate === g ? (g === 'ready' ? '#166534' : g === 'blocked' ? '#450a0a' : '#334155') : '#1e293b',
                color: node.gate === g ? (g === 'ready' ? '#86efac' : g === 'blocked' ? '#fca5a5' : '#cbd5e1') : '#6b7280',
                border: `1px solid ${node.gate === g ? 'transparent' : '#334155'}`,
              }}
            >
              {g === 'ready' ? '✓ Ready' : g === 'blocked' ? '⛔ Block' : 'Auto'}
            </button>
          ))}
        </div>
      </div>
      {/* Planning policy */}
      <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Planning Policy</div>
      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 16 }}>{node.planningPolicy}</div>
      {node.dependsOn.length > 0 && (
        <div>
          <div style={{ color: '#6b7280', fontSize: 11, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Depends on</div>
          <div style={{ color: '#94a3b8', fontSize: 12 }}>{node.dependsOn.join(', ')}</div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DAG_NODE_BUDGET = 150;

export function BacklogSequencerPage() {
  const queryClient = useQueryClient();
  const [activeTier, setActiveTier] = useState<Tier>('now');
  const [importanceFilter, setImportanceFilter] = useState<ImportanceFilter>('all');
  const [conditionFilter, setConditionFilter] = useState<ConditionFilter>('all');
  const [selectedNode, setSelectedNode] = useState<BacklogNode | null>(null);

  const { data, isLoading, isError, error } = useQuery<SequenceResponse>({
    queryKey: ['backlog-sequence'],
    queryFn: async () => {
      const res = await fetch('/api/backlog/sequence');
      if (res.status === 404) return { ok: false, error: 'No sequence file found' };
      if (!res.ok) throw new Error('Failed to fetch backlog sequence');
      return res.json();
    },
    staleTime: 30_000,
  });

  const regenerateMutation = useMutation({
    mutationFn: (pass: 'incremental' | 'review') => triggerRegenerate(pass),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backlog-sequence'] }),
  });

  const gateMutation = useMutation({
    mutationFn: ({ issueId, gate }: { issueId: string; gate: SequenceGate }) => setGate(issueId, gate),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backlog-sequence'] }),
  });

  const allNodes = data?.nodes ?? [];
  const allEdges = data?.edges ?? [];

  // Derive stale candidates list
  const staleCandidates = useMemo(() => allNodes.filter(n => n.condition === 'stale' && !n.inPipeline), [allNodes]);

  // Apply filters
  const filteredNodes = useMemo(() => {
    return allNodes.filter(n => {
      if (importanceFilter !== 'all' && n.importance !== importanceFilter) return false;
      if (conditionFilter !== 'all' && n.condition !== conditionFilter) return false;
      return true;
    });
  }, [allNodes, importanceFilter, conditionFilter]);

  // Nodes for the active tier (always include pinned/in-pipeline regardless of tier)
  const pinnedNodes = useMemo(() => filteredNodes.filter(n => n.inPipeline), [filteredNodes]);
  const tierNodes = useMemo(() => filteredNodes.filter(n => deriveTier(n.rank) === activeTier), [filteredNodes, activeTier]);
  const visibleNodes = useMemo(() => {
    const combined = [...pinnedNodes, ...tierNodes.filter(n => !n.inPipeline)];
    return combined;
  }, [pinnedNodes, tierNodes]);

  // Edges for visible nodes
  const visibleIssueIds = useMemo(() => new Set(visibleNodes.map(n => n.issue)), [visibleNodes]);
  const visibleEdges = useMemo(() => allEdges.filter(e => visibleIssueIds.has(e.from) && visibleIssueIds.has(e.to)), [allEdges, visibleIssueIds]);

  const useList = visibleNodes.length > DAG_NODE_BUDGET || activeTier === 'someday';

  const tierCounts: Record<Tier, number> = useMemo(() => ({
    now: filteredNodes.filter(n => deriveTier(n.rank) === 'now').length,
    next: filteredNodes.filter(n => deriveTier(n.rank) === 'next').length,
    later: filteredNodes.filter(n => deriveTier(n.rank) === 'later').length,
    someday: filteredNodes.filter(n => deriveTier(n.rank) === 'someday').length,
  }), [filteredNodes]);

  const handleNodeClick = (node: BacklogNode) => setSelectedNode(node);
  const handleGateChange = (gate: SequenceGate) => {
    if (!selectedNode) return;
    gateMutation.mutate({ issueId: selectedNode.issue, gate });
    setSelectedNode(prev => prev ? { ...prev, gate } : null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f172a', color: '#e2e8f0', fontFamily: 'DM Sans, sans-serif' }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <ListOrdered size={18} color="#6b7280" />
        <span style={{ fontWeight: 700, fontSize: 15, color: '#f1f5f9' }}>Backlog Sequencer</span>
        {data?.generatedAt && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {new Date(data.generatedAt).toLocaleString()} · {data.model} · {data.pass} · {data.openCount ?? 0} open
          </span>
        )}
        <div style={{ flex: 1 }} />
        {staleCandidates.length > 0 && (
          <span style={{ fontSize: 11, background: '#1f2937', color: '#9ca3af', padding: '3px 8px', borderRadius: 4 }}>
            ⊘ {staleCandidates.length} stale candidates
          </span>
        )}
        <button
          onClick={() => regenerateMutation.mutate('incremental')}
          disabled={regenerateMutation.isPending}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 5, background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', cursor: 'pointer', fontSize: 12 }}
        >
          <RefreshCw size={12} style={{ animation: regenerateMutation.isPending ? 'spin 1s linear infinite' : undefined }} />
          Incremental
        </button>
        <button
          onClick={() => regenerateMutation.mutate('review')}
          disabled={regenerateMutation.isPending}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 5, background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', cursor: 'pointer', fontSize: 12 }}
        >
          Full review
        </button>
      </div>

      {/* Filter + tier bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        {/* Tier pills */}
        {(['now', 'next', 'later', 'someday'] as Tier[]).map(t => (
          <button
            key={t}
            onClick={() => setActiveTier(t)}
            style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: activeTier === t ? '#3b82f6' : '#1e293b',
              color: activeTier === t ? '#fff' : '#6b7280',
              border: activeTier === t ? 'none' : '1px solid #334155',
            }}
          >
            {TIER_LABELS[t]} <span style={{ opacity: 0.7, fontWeight: 400 }}>{tierCounts[t]}</span>
          </button>
        ))}
        <div style={{ width: 1, background: '#334155', height: 20 }} />
        {/* Filters */}
        <select
          value={importanceFilter}
          onChange={e => setImportanceFilter(e.target.value as ImportanceFilter)}
          style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4, padding: '3px 8px', fontSize: 12, cursor: 'pointer' }}
        >
          {IMPORTANCE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={conditionFilter}
          onChange={e => setConditionFilter(e.target.value as ConditionFilter)}
          style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4, padding: '3px 8px', fontSize: 12, cursor: 'pointer' }}
        >
          {CONDITION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#475569' }}>
          {visibleNodes.length} nodes {useList ? '(list)' : '(DAG)'}
        </span>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', gap: 8 }}>
            <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
            Loading backlog sequence…
          </div>
        )}
        {isError && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#f87171', gap: 8, flexDirection: 'column' }}>
            <AlertTriangle size={24} />
            <div>{error instanceof Error ? error.message : 'Failed to load'}</div>
          </div>
        )}
        {!isLoading && !isError && !data?.ok && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', gap: 12, flexDirection: 'column' }}>
            <Info size={32} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>No backlog sequence yet</div>
              <div style={{ fontSize: 13 }}>Run the Sequencer agent to generate <code>.pan/backlog/sequence.md</code></div>
            </div>
          </div>
        )}
        {!isLoading && !isError && data?.ok && (
          <>
            {useList ? (
              <RankedList nodes={visibleNodes} onSelect={handleNodeClick} />
            ) : (
              <BacklogDAG
                nodes={visibleNodes}
                edges={visibleEdges}
                onNodeClick={handleNodeClick}
              />
            )}
            {selectedNode && (
              <RationalePanel
                node={selectedNode}
                onClose={() => setSelectedNode(null)}
                onGateChange={handleGateChange}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
