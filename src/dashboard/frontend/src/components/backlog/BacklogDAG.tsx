/**
 * BacklogDAG — ReactFlow+dagre DAG for the Backlog Sequencer (PAN-1866)
 *
 * Reuses the same ReactFlow 11 + @dagrejs/dagre stack as PlanDAG.tsx.
 * Custom IssueNode encodes: rank badge, size footprint, importance heat-border,
 * in-pipeline glow ring, PRD/READY chips, condition indicators (⚠ REFINE / ⊘ STALE).
 */

import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  type Node,
  type Edge,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from '@dagrejs/dagre';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SequenceSize = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type SequenceImportance = 'critical' | 'high' | 'medium' | 'low';
export type SequenceCondition = 'ok' | 'needs-refinement' | 'stale';
export type SequenceGate = 'auto' | 'ready' | 'blocked';

export interface BacklogNode {
  issue: string;
  rank: number;
  size: SequenceSize;
  importance: SequenceImportance;
  score: number;
  condition: SequenceCondition;
  gate: SequenceGate;
  planningPolicy: string;
  dependsOn: string[];
  why: string;
  rationale?: string;
  // enriched
  hasDraft?: boolean;
  hasSpec?: boolean;
  inPipeline?: boolean;
  pipelinePhase?: string;
}

export interface BacklogEdge {
  from: string;
  to: string;
  type: 'unblocks' | 'informs';
  source: string;
  confidence?: number;
}

export interface BacklogDAGProps {
  nodes: BacklogNode[];
  edges: BacklogEdge[];
  onNodeClick?: (node: BacklogNode) => void;
}

// ─── Styling ──────────────────────────────────────────────────────────────────

const IMPORTANCE_BORDER: Record<SequenceImportance, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#6b7280',
  low:      '#374151',
};

const IMPORTANCE_BG: Record<SequenceImportance, string> = {
  critical: '#450a0a',
  high:     '#431407',
  medium:   '#1f2937',
  low:      '#111827',
};

const IMPORTANCE_TEXT: Record<SequenceImportance, string> = {
  critical: '#fca5a5',
  high:     '#fdba74',
  medium:   '#d1d5db',
  low:      '#9ca3af',
};

const SIZE_DIMENSIONS: Record<SequenceSize, { w: number; h: number }> = {
  XS: { w: 160, h: 52 },
  S:  { w: 190, h: 58 },
  M:  { w: 220, h: 64 },
  L:  { w: 260, h: 72 },
  XL: { w: 300, h: 80 },
};

const PIPELINE_GLOW_COLORS: Record<string, string> = {
  planning_active:          '#3b82f6',
  planning_done_awaiting_work: '#3b82f6',
  in_progress_work_running: '#22c55e',
  in_progress_work_idle:    '#22c55e',
  in_review_reviewers_running: '#f59e0b',
  in_review_changes_requested: '#ef4444',
  in_review_approved:       '#22c55e',
  testing_running:          '#3b82f6',
  ready_to_merge:           '#22c55e',
  merging:                  '#22c55e',
};

// ─── Layout ───────────────────────────────────────────────────────────────────

function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const data = node.data as BacklogNode;
    const dims = SIZE_DIMENSIONS[data.size] ?? SIZE_DIMENSIONS['M'];
    g.setNode(node.id, { width: dims.w, height: dims.h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  return nodes.map(node => {
    const data = node.data as BacklogNode;
    const dims = SIZE_DIMENSIONS[data.size] ?? SIZE_DIMENSIONS['M'];
    const { x, y } = g.node(node.id);
    return { ...node, position: { x: x - dims.w / 2, y: y - dims.h / 2 } };
  });
}

// ─── Custom node ──────────────────────────────────────────────────────────────

function IssueNode({ data }: { data: BacklogNode }) {
  const border = IMPORTANCE_BORDER[data.importance];
  const bg = IMPORTANCE_BG[data.importance];
  const text = IMPORTANCE_TEXT[data.importance];
  const dims = SIZE_DIMENSIONS[data.size] ?? SIZE_DIMENSIONS['M'];
  const isStale = data.condition === 'stale';
  const needsRefine = data.condition === 'needs-refinement';
  const glowColor = data.pipelinePhase ? PIPELINE_GLOW_COLORS[data.pipelinePhase] : null;
  const isBlocked = data.gate === 'blocked';
  const isReady = data.gate === 'ready';

  return (
    <div
      style={{
        width: dims.w,
        height: dims.h,
        background: isStale ? '#1a1a1a' : bg,
        border: `2px solid ${border}`,
        borderRadius: 6,
        padding: '6px 8px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        opacity: isStale ? 0.6 : 1,
        boxShadow: glowColor ? `0 0 0 3px ${glowColor}55, 0 0 10px ${glowColor}44` : undefined,
        fontFamily: 'DM Sans, sans-serif',
      }}
    >
      {/* Top row: rank + gate badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#9ca3af', fontSize: 10, fontFamily: 'monospace', fontWeight: 600 }}>#{data.rank}</span>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          {isReady && (
            <span style={{ fontSize: 9, background: '#166534', color: '#86efac', padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}>📌 PROMOTED</span>
          )}
          {isBlocked && (
            <span style={{ fontSize: 9, background: '#450a0a', color: '#fca5a5', padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}>⛔ HELD</span>
          )}
        </div>
      </div>

      {/* Issue ID */}
      <div style={{ color: text, fontWeight: 600, fontSize: 12, textDecoration: isStale ? 'line-through' : undefined }}>
        {data.issue}
      </div>

      {/* Chips row */}
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {data.hasDraft && (
          <span style={{ fontSize: 9, background: '#1e3a5f', color: '#93c5fd', padding: '1px 4px', borderRadius: 3 }}>PRD</span>
        )}
        {data.hasSpec && (
          <span style={{ fontSize: 9, background: '#14532d', color: '#86efac', padding: '1px 4px', borderRadius: 3 }}>✓ READY</span>
        )}
        {needsRefine && (
          <span style={{ fontSize: 9, background: '#422006', color: '#fde047', padding: '1px 4px', borderRadius: 3 }}>⚠ REFINE</span>
        )}
        {isStale && (
          <span style={{ fontSize: 9, background: '#1f2937', color: '#9ca3af', padding: '1px 4px', borderRadius: 3 }}>⊘ STALE</span>
        )}
        <span style={{ fontSize: 9, background: '#374151', color: '#9ca3af', padding: '1px 4px', borderRadius: 3 }}>{data.size}</span>
      </div>
    </div>
  );
}

const nodeTypes = { issueNode: IssueNode };

// ─── Main component ────────────────────────────────────────────────────────────

export function BacklogDAG({ nodes: propNodes, edges: propEdges, onNodeClick }: BacklogDAGProps) {
  const rfNodes: Node[] = useMemo(() => propNodes.map(n => ({
    id: n.issue,
    type: 'issueNode',
    position: { x: 0, y: 0 },
    data: n,
  })), [propNodes]);

  const rfEdges: Edge[] = useMemo(() => propEdges.map((e, i) => ({
    id: `e-${i}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    style: { stroke: e.type === 'informs' ? '#6b7280' : '#3b82f6', strokeWidth: 1.5, strokeDasharray: e.type === 'informs' ? '4 2' : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.type === 'informs' ? '#6b7280' : '#3b82f6' },
  })), [propEdges]);

  const layouted = useMemo(() => {
    if (rfNodes.length === 0) return rfNodes;
    return applyDagreLayout(rfNodes, rfEdges);
  }, [rfNodes, rfEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layouted);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  useEffect(() => {
    setNodes(layouted);
    setEdges(rfEdges);
  }, [layouted, rfEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback((_: MouseEvent, node: Node) => {
    if (onNodeClick) onNodeClick(node.data as BacklogNode);
  }, [onNodeClick]);

  return (
    <div style={{ width: '100%', height: '100%', background: '#0f172a' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Background color="#1e293b" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
