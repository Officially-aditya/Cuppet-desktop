import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type EditedFile = {
  path: string;
  tool?: string;
  updatedAt?: number;
  mutationId?: string | null;
  executionId?: string | null;
};

type GraphStats = {
  files?: number;
  modules?: number;
  symbols?: number;
  edges?: number;
  progress?: { discovered?: number; indexed?: number; skipped?: number; complete?: boolean };
};

type MemoryGraphSnapshot = {
  available?: boolean;
  reason?: string;
  root?: string;
  graph?: GraphStats;
  files?: string[];
  editedFiles?: EditedFile[];
};

type GraphNode = {
  id: string;
  path: string;
  label: string;
  kind: 'file' | 'group';
  x: number;
  y: number;
  z: number;
  editedAt: number;
  tool?: string;
};

type GraphEdge = { from: string; to: string };

type Props = {
  sessionId: string | null;
  projectName?: string | null;
  running?: boolean;
};

const MAX_GRAPH_FILES = 180;
const ACTIVE_EDIT_MS = 12_000;

export function TstMemorySidebar({ sessionId, projectName, running = false }: Props) {
  const [snapshot, setSnapshot] = useState<MemoryGraphSnapshot | null>(null);
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const graph = await window.cuppet.cognitive.memoryGraph(sessionId).catch((error: unknown) => ({ available: false, reason: cleanError(error), files: [], editedFiles: [] }));
      setSnapshot(graph && typeof graph === 'object' ? graph : { available: false, reason: 'TST graph returned an invalid snapshot', files: [], editedFiles: [] });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSelectedPath(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sessionId) return;
    const interval = window.setInterval(() => void refresh(true), running ? 1800 : 7500);
    return () => window.clearInterval(interval);
  }, [refresh, running, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let timer: number | null = null;
    const unsubscribe = window.cuppet.onEvent((event: any) => {
      if (!event || (event.sessionId && event.sessionId !== sessionId)) return;
      const type = String(event.type ?? '');
      if (!type.includes('tool') && !type.includes('mutation') && !type.includes('graph') && type !== 'message.completed') return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(true), 180);
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [refresh, sessionId]);

  if (!sessionId) return null;

  if (!open) {
    return (
      <button type="button" className="memory-sidebar-rail" title="Show TST memory" aria-label="Show TST memory" onClick={() => setOpen(true)}>
        <MemoryIcon />
        <span>Memory</span>
      </button>
    );
  }

  const files = Array.isArray(snapshot?.files) ? snapshot!.files! : [];
  const edits = Array.isArray(snapshot?.editedFiles) ? snapshot!.editedFiles! : [];
  const recent = [...edits].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0)).slice(0, 5);
  const selected = selectedPath ? edits.find((item) => normalizePath(item.path) === normalizePath(selectedPath)) : null;
  const indexing = snapshot?.graph?.progress;

  return (
    <aside className="memory-sidebar" aria-label="TST memory graph">
      <header className="memory-sidebar-header">
        <div className="memory-sidebar-title-wrap">
          <div className="memory-sidebar-icon"><MemoryIcon /></div>
          <div>
            <div className="memory-sidebar-title">TST memory</div>
            <div className="memory-sidebar-subtitle">{projectName || 'Project graph'}</div>
          </div>
        </div>
        <div className="memory-sidebar-actions">
          <button type="button" className="memory-icon-button" title="Refresh memory graph" aria-label="Refresh memory graph" onClick={() => void refresh()}>
            <RefreshIcon spinning={loading} />
          </button>
          <button type="button" className="memory-icon-button" title="Hide memory sidebar" aria-label="Hide memory sidebar" onClick={() => setOpen(false)}>
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="memory-sidebar-stats" aria-label="Memory graph status">
        <span><strong>{snapshot?.graph?.files ?? files.length}</strong> files</span>
        <span><strong>{snapshot?.graph?.symbols ?? 0}</strong> symbols</span>
        <span className={indexing?.complete ? 'ready' : 'indexing'}>{indexing?.complete ? 'Indexed' : 'Indexing'}</span>
      </div>

      <div className="memory-graph-stage">
        {snapshot?.available === false ? (
          <div className="memory-graph-empty">
            <MemoryIcon />
            <strong>TST graph unavailable</strong>
            <span>{snapshot.reason || 'Open a project-bound chat to visualize memory.'}</span>
          </div>
        ) : files.length || edits.length ? (
          <MemoryGraphCanvas files={files} edits={edits} selectedPath={selectedPath} onSelect={setSelectedPath} />
        ) : (
          <div className="memory-graph-empty">
            <MemoryIcon />
            <strong>{loading ? 'Loading project memory…' : 'Building project memory…'}</strong>
            <span>Nodes appear as TST indexes files and Cuppet touches the workspace.</span>
          </div>
        )}
        <div className="memory-graph-legend" aria-hidden="true">
          <span><i className="memory-dot file" />file</span>
          <span><i className="memory-dot edited" />edited</span>
          <span><i className="memory-dot group" />folder</span>
        </div>
      </div>

      {selectedPath && (
        <div className="memory-node-inspector">
          <div className="memory-inspector-label">Selected node</div>
          <strong title={selectedPath}>{selectedPath}</strong>
          <div className="memory-inspector-meta">
            {selected?.updatedAt ? <span>Edited {relativeTime(selected.updatedAt)}</span> : <span>Indexed by TST</span>}
            {selected?.tool ? <span>{humanTool(selected.tool)}</span> : null}
          </div>
        </div>
      )}

      <section className="memory-activity-section">
        <div className="memory-section-heading">
          <span>Workspace activity</span>
          {running ? <span className="memory-live"><i /> live</span> : null}
        </div>
        {recent.length ? (
          <div className="memory-activity-list">
            {recent.map((item, index) => (
              <button type="button" key={`${item.mutationId ?? item.path}:${index}`} className="memory-activity-item" onClick={() => setSelectedPath(item.path)}>
                <span className="memory-activity-pulse" />
                <span className="memory-activity-copy">
                  <strong title={item.path}>{leafName(item.path)}</strong>
                  <small>{humanTool(item.tool || 'edit')} · {relativeTime(item.updatedAt ?? 0)}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="memory-activity-empty">No file mutations in this chat yet.</div>
        )}
      </section>
    </aside>
  );
}

function MemoryGraphCanvas({ files, edits, selectedPath, onSelect }: { files: string[]; edits: EditedFile[]; selectedPath: string | null; onSelect: (path: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scene = useMemo(() => buildScene(files, edits), [files, edits]);
  const sceneRef = useRef(scene);
  const selectedRef = useRef(selectedPath);
  const rotationRef = useRef({ x: -0.16, y: 0.1 });
  const pointerRef = useRef({ x: 0, y: 0, dragging: false, moved: false });
  const projectedRef = useRef<Array<{ node: GraphNode; x: number; y: number; r: number }>>([]);

  useEffect(() => { sceneRef.current = scene; }, [scene]);
  useEffect(() => { selectedRef.current = selectedPath; }, [selectedPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    let last = performance.now();
    let width = 1;
    let height = 1;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const pxWidth = Math.round(width * dpr);
      const pxHeight = Math.round(height * dpr);
      if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
        canvas.width = pxWidth;
        canvas.height = pxHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (now: number) => {
      const elapsed = Math.min(48, now - last);
      last = now;
      if (!pointerRef.current.dragging) rotationRef.current.y += elapsed * 0.000055;
      drawScene(context, width, height, sceneRef.current, rotationRef.current, selectedRef.current, projectedRef, now);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointerRef.current = { x: event.clientX, y: event.clientY, dragging: true, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.dragging) return;
    const dx = event.clientX - pointerRef.current.x;
    const dy = event.clientY - pointerRef.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointerRef.current.moved = true;
    rotationRef.current.y += dx * 0.0065;
    rotationRef.current.x = Math.max(-1.1, Math.min(1.1, rotationRef.current.x + dy * 0.005));
    pointerRef.current.x = event.clientX;
    pointerRef.current.y = event.clientY;
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = [...projectedRef.current].reverse().find((item) => Math.hypot(item.x - x, item.y - y) <= Math.max(8, item.r + 3));
      onSelect(hit?.node.kind === 'file' ? hit.node.path : null);
    }
    pointerRef.current.dragging = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  };

  return <canvas ref={canvasRef} className="memory-graph-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointerRef.current.dragging = false; }} />;
}

function buildScene(filesInput: string[], edits: EditedFile[]) {
  const editByPath = new Map(edits.map((item) => [normalizePath(item.path), item]));
  const uniqueFiles = [...new Set([...filesInput, ...edits.map((item) => item.path)].map(normalizePath).filter(Boolean))];
  const prioritized = uniqueFiles
    .map((path) => ({ path, editedAt: Number(editByPath.get(path)?.updatedAt ?? 0) }))
    .sort((a, b) => b.editedAt - a.editedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_GRAPH_FILES);
  const groups = [...new Set(prioritized.map(({ path }) => topGroup(path)))];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  groups.forEach((group, index) => {
    const angle = (index / Math.max(groups.length, 1)) * Math.PI * 2;
    const radius = groups.length <= 1 ? 0 : 0.48;
    nodes.push({ id: `group:${group}`, path: group, label: group, kind: 'group', x: Math.cos(angle) * radius, y: Math.sin(angle * 1.7) * 0.22, z: Math.sin(angle) * radius, editedAt: 0 });
  });

  prioritized.forEach(({ path }, index) => {
    const edit = editByPath.get(path);
    const group = topGroup(path);
    const groupIndex = Math.max(0, groups.indexOf(group));
    const baseAngle = (groupIndex / Math.max(groups.length, 1)) * Math.PI * 2;
    const seed = hashNumber(path);
    const localAngle = ((seed % 1000) / 1000) * Math.PI * 2;
    const ring = 0.2 + (((seed >>> 10) % 1000) / 1000) * 0.42;
    const gx = Math.cos(baseAngle) * (groups.length <= 1 ? 0 : 0.48);
    const gz = Math.sin(baseAngle) * (groups.length <= 1 ? 0 : 0.48);
    const yJitter = (((seed >>> 20) % 1000) / 1000 - 0.5) * 0.95;
    nodes.push({
      id: `file:${path}`,
      path,
      label: leafName(path),
      kind: 'file',
      x: gx + Math.cos(localAngle) * ring,
      y: yJitter,
      z: gz + Math.sin(localAngle) * ring,
      editedAt: Number(edit?.updatedAt ?? 0),
      tool: edit?.tool,
    });
    edges.push({ from: `group:${group}`, to: `file:${path}` });
    if (index > 0 && topGroup(prioritized[index - 1].path) === group && index % 3 === 0) edges.push({ from: `file:${prioritized[index - 1].path}`, to: `file:${path}` });
  });
  return { nodes, edges };
}

function drawScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: { nodes: GraphNode[]; edges: GraphEdge[] },
  rotation: { x: number; y: number },
  selectedPath: string | null,
  projectedRef: React.MutableRefObject<Array<{ node: GraphNode; x: number; y: number; r: number }>>,
  now: number,
) {
  context.clearRect(0, 0, width, height);
  const centerX = width / 2;
  const centerY = height / 2 - 4;
  const scale = Math.min(width, height) * 0.54;
  const projected = scene.nodes.map((node) => ({ node, ...project(node, rotation, centerX, centerY, scale) })).sort((a, b) => a.depth - b.depth);
  const byId = new Map(projected.map((item) => [item.node.id, item]));

  for (const edge of scene.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const highlighted = selectedPath && (from.node.path === selectedPath || to.node.path === selectedPath);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = highlighted ? 'rgba(153, 199, 255, .42)' : 'rgba(132, 146, 171, .12)';
    context.lineWidth = highlighted ? 1.1 : 0.65;
    context.stroke();
  }

  const clickTargets: Array<{ node: GraphNode; x: number; y: number; r: number }> = [];
  for (const item of projected) {
    const { node, x, y, depth } = item;
    const depthScale = Math.max(0.55, Math.min(1.35, 1.03 - depth * 0.24));
    const selected = node.kind === 'file' && node.path === selectedPath;
    const age = node.editedAt ? Math.max(0, Date.now() - node.editedAt) : Infinity;
    const active = age < ACTIVE_EDIT_MS;
    const baseRadius = node.kind === 'group' ? 4.2 : active ? 4.8 : 2.6;
    const radius = baseRadius * depthScale;

    if (active) {
      const wave = 0.5 + 0.5 * Math.sin(now * 0.006 + hashNumber(node.path));
      const glow = context.createRadialGradient(x, y, radius * 0.3, x, y, radius * (3.3 + wave));
      glow.addColorStop(0, 'rgba(111, 209, 255, .65)');
      glow.addColorStop(1, 'rgba(111, 209, 255, 0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * (3.3 + wave), 0, Math.PI * 2);
      context.fill();
    }
    if (selected) {
      context.strokeStyle = 'rgba(226, 243, 255, .9)';
      context.lineWidth = 1.2;
      context.beginPath();
      context.arc(x, y, radius + 5, 0, Math.PI * 2);
      context.stroke();
    }

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = node.kind === 'group'
      ? 'rgba(168, 177, 198, .72)'
      : active
        ? 'rgba(128, 219, 255, .96)'
        : selected
          ? 'rgba(230, 245, 255, .96)'
          : `rgba(181, 198, 224, ${Math.max(.28, .66 - Math.abs(depth) * .2)})`;
    context.fill();
    clickTargets.push({ node, x, y, r: radius });

    if (selected) {
      context.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const text = node.label.length > 34 ? `${node.label.slice(0, 31)}…` : node.label;
      const metrics = context.measureText(text);
      const boxX = Math.min(width - metrics.width - 18, Math.max(8, x + 10));
      const boxY = Math.max(18, y - 17);
      context.fillStyle = 'rgba(8, 10, 14, .88)';
      roundedRect(context, boxX - 5, boxY - 12, metrics.width + 10, 20, 5);
      context.fill();
      context.fillStyle = 'rgba(235, 241, 249, .96)';
      context.fillText(text, boxX, boxY + 2);
    }
  }
  projectedRef.current = clickTargets;
}

function project(node: GraphNode, rotation: { x: number; y: number }, cx: number, cy: number, scale: number) {
  const cosy = Math.cos(rotation.y); const siny = Math.sin(rotation.y);
  const cosx = Math.cos(rotation.x); const sinx = Math.sin(rotation.x);
  const x1 = node.x * cosy - node.z * siny;
  const z1 = node.x * siny + node.z * cosy;
  const y1 = node.y * cosx - z1 * sinx;
  const z2 = node.y * sinx + z1 * cosx;
  const perspective = 1 / Math.max(0.45, 1.7 + z2 * 0.38);
  return { x: cx + x1 * scale * perspective, y: cy + y1 * scale * perspective, depth: z2 };
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function normalizePath(value: unknown) { return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, ''); }
function topGroup(path: string) { return normalizePath(path).split('/').filter(Boolean)[0] || 'root'; }
function leafName(path: string) { return normalizePath(path).split('/').filter(Boolean).at(-1) || normalizePath(path); }
function hashNumber(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function relativeTime(value: number) { const delta = Date.now() - Number(value || 0); if (!value) return 'recently'; if (delta < 5_000) return 'just now'; if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; return `${Math.floor(delta / 3_600_000)}h ago`; }
function humanTool(value: string) { return value.replace(/^cuppet_/, '').replace(/^tst_/, 'TST ').replace(/^workspace_/, '').replaceAll('_', ' ').replace(/\b\w/g, (match) => match.toUpperCase()); }
function cleanError(error: unknown) { return error instanceof Error ? error.message : String(error ?? 'TST graph unavailable'); }

function MemoryIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.15" fill="currentColor"/><circle cx="4" cy="6" r="1.3" fill="currentColor"/><circle cx="15.5" cy="4.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="4.5" cy="14.5" r="1.3" fill="currentColor"/><path d="m5.1 6.8 3.1 2M11.7 8.4l2.8-2.9M11.8 11.4l2.7 2.9M8.2 11.3l-2.7 2.4" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round"/></svg>; }
function RefreshIcon({ spinning }: { spinning: boolean }) { return <svg className={spinning ? 'spin' : ''} viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.4 7.1A5.8 5.8 0 1 0 14 11.8M14.4 3.9v3.3h-3.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function CloseIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m5.3 5.3 7.4 7.4m0-7.4-7.4 7.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/></svg>; }
