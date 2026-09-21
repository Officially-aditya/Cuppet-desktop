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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const MAX_GRAPH_FILES = 180;
const ACTIVE_EDIT_MS = 12_000;
const MIN_GRAPH_ZOOM = 0.65;
const MAX_GRAPH_ZOOM = 2.5;
const NODE_CLICK_RADIUS = 13;
const DRAG_THRESHOLD = 6;
const ROOT_NODE_PATH = '__cuppet_root__';

export function TstMemorySidebar({ sessionId, projectName, running = false, open: openProp, onOpenChange }: Props) {
  const [snapshot, setSnapshot] = useState<MemoryGraphSnapshot | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(true);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(openProp ?? uncontrolledOpen) : value;
    if (onOpenChange) onOpenChange(next);
    else setUncontrolledOpen(next);
  }, [onOpenChange, openProp, uncontrolledOpen]);
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
  const selected = selectedPath && selectedPath !== ROOT_NODE_PATH ? edits.find((item) => normalizePath(item.path) === normalizePath(selectedPath)) : null;
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
        <button
          type="button"
          className="memory-floating-close-button"
          aria-label="Close project graph"
          title="Close project graph"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
        {snapshot?.available === false && !edits.length ? (
          <div className="memory-graph-empty">
            <MemoryIcon />
            <strong>TST graph unavailable</strong>
            <span>{snapshot.reason || 'Open a project-bound chat to visualize memory.'}</span>
            <button type="button" className="memory-dismiss-btn" onClick={() => setOpen(false)}>Close graph</button>
          </div>
        ) : files.length || edits.length ? (
          <MemoryGraphCanvas files={files.length > 0 ? files : edits.map((e) => e.path)} edits={edits} selectedPath={selectedPath} onSelect={setSelectedPath} />
        ) : (
          <div className="memory-graph-empty">
            <MemoryIcon />
            <strong>{loading ? 'Loading project memory…' : 'Building project memory…'}</strong>
            <span>Nodes appear as TST indexes files and Cuppet touches the workspace.</span>
            <button type="button" className="memory-dismiss-btn" onClick={() => setOpen(false)}>Close graph</button>
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
          <strong title={displayGraphPath(selectedPath)}>{displayGraphPath(selectedPath)}</strong>
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
  const zoomRef = useRef(1);
  const pointerRef = useRef({ x: 0, y: 0, startX: 0, startY: 0, dragging: false, moved: false });
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
      drawScene(context, width, height, sceneRef.current, rotationRef.current, zoomRef.current, selectedRef.current, projectedRef, now);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      dragging: true,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.dragging) return;
    const dx = event.clientX - pointerRef.current.x;
    const dy = event.clientY - pointerRef.current.y;
    const totalDistance = Math.hypot(event.clientX - pointerRef.current.startX, event.clientY - pointerRef.current.startY);
    if (!pointerRef.current.moved && totalDistance <= DRAG_THRESHOLD) {
      pointerRef.current.x = event.clientX;
      pointerRef.current.y = event.clientY;
      return;
    }
    pointerRef.current.moved = true;
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
      let hit: { node: GraphNode; x: number; y: number; r: number } | null = null;
      let bestDistance = Infinity;
      for (const item of [...projectedRef.current].reverse()) {
        const distance = Math.hypot(item.x - x, item.y - y);
        const hitRadius = Math.max(NODE_CLICK_RADIUS, item.r + 7);
        if (distance <= hitRadius && distance < bestDistance) {
          hit = item;
          bestDistance = distance;
        }
      }
      onSelect(hit?.node.path ?? null);
    }
    pointerRef.current.dragging = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
  };
  const wheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
    const delta = event.deltaY * deltaUnit;
    const next = zoomRef.current * Math.exp(-delta * 0.0016);
    zoomRef.current = Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, next));
  };

  return <canvas ref={canvasRef} className="memory-graph-canvas" onWheel={wheel} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointerRef.current.dragging = false; }} />;
}

function buildScene(filesInput: string[], edits: EditedFile[]) {
  const editByPath = new Map(edits.map((item) => [normalizePath(item.path), item]));
  const uniqueFiles = [...new Set([...filesInput, ...edits.map((item) => item.path)].map(normalizePath).filter(Boolean))];
  const prioritized = uniqueFiles
    .map((path) => ({ path, editedAt: Number(editByPath.get(path)?.updatedAt ?? 0) }))
    .sort((a, b) => b.editedAt - a.editedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_GRAPH_FILES);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const folderPaths = new Set<string>();

  for (const { path } of prioritized) {
    const segments = pathSegments(path);
    for (let depth = 1; depth < segments.length; depth += 1) {
      folderPaths.add(segments.slice(0, depth).join('/'));
    }
  }

  const branchNames = [...new Set(prioritized.map(({ path }) => pathSegments(path)[0]).filter(Boolean))].sort();
  const branchAngle = new Map(branchNames.map((name, index) => [name, (index / Math.max(branchNames.length, 1)) * Math.PI * 2]));
  const maxDepth = Math.max(1, ...prioritized.map(({ path }) => pathSegments(path).length));

  nodes.push({ id: `group:${ROOT_NODE_PATH}`, path: ROOT_NODE_PATH, label: 'root', kind: 'group', x: 0, y: 0, z: 0, editedAt: 0 });

  const sortedFolders = [...folderPaths].sort((a, b) => pathSegments(a).length - pathSegments(b).length || a.localeCompare(b));
  for (const folderPath of sortedFolders) {
    const segments = pathSegments(folderPath);
    const depth = segments.length;
    const baseAngle = branchAngle.get(segments[0]) ?? 0;
    const seed = hashNumber(folderPath);
    const spread = 0.1 + (depth / maxDepth) * 0.34;
    const angle = baseAngle + ((((seed >>> 8) % 1000) / 1000) - 0.5) * spread;
    const radius = 0.78 * (depth / maxDepth);
    const y = ((((seed >>> 20) % 1000) / 1000) - 0.5) * (0.18 + 0.34 * (depth / maxDepth));
    nodes.push({
      id: `group:${folderPath}`,
      path: folderPath,
      label: segments.at(-1) || folderPath,
      kind: 'group',
      x: Math.cos(angle) * radius,
      y,
      z: Math.sin(angle) * radius,
      editedAt: 0,
    });
    const parentPath = segments.slice(0, -1).join('/');
    edges.push({ from: parentPath ? `group:${parentPath}` : `group:${ROOT_NODE_PATH}`, to: `group:${folderPath}` });
  }

  for (const { path } of prioritized) {
    const edit = editByPath.get(path);
    const segments = pathSegments(path);
    const depth = Math.max(1, segments.length);
    const parentPath = segments.slice(0, -1).join('/');
    const baseAngle = branchAngle.get(segments[0]) ?? 0;
    const seed = hashNumber(path);
    const spread = 0.16 + (depth / maxDepth) * 0.48;
    const angle = baseAngle + ((((seed >>> 8) % 1000) / 1000) - 0.5) * spread;
    const radius = 0.88 * (depth / maxDepth);
    const y = ((((seed >>> 20) % 1000) / 1000) - 0.5) * (0.24 + 0.46 * (depth / maxDepth));
    nodes.push({
      id: `file:${path}`,
      path,
      label: leafName(path),
      kind: 'file',
      x: Math.cos(angle) * radius,
      y,
      z: Math.sin(angle) * radius,
      editedAt: Number(edit?.updatedAt ?? 0),
      tool: edit?.tool,
    });
    edges.push({ from: parentPath ? `group:${parentPath}` : `group:${ROOT_NODE_PATH}`, to: `file:${path}` });
  }

  return { nodes, edges };
}

function drawScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  scene: { nodes: GraphNode[]; edges: GraphEdge[] },
  rotation: { x: number; y: number },
  zoom: number,
  selectedPath: string | null,
  projectedRef: React.MutableRefObject<Array<{ node: GraphNode; x: number; y: number; r: number }>>,
  now: number,
) {
  context.clearRect(0, 0, width, height);
  const centerX = width / 2;
  const centerY = height / 2 - 4;
  const scale = Math.min(width, height) * 0.54 * zoom;
  const projected = scene.nodes.map((node) => ({ node, ...project(node, rotation, centerX, centerY, scale) })).sort((a, b) => a.depth - b.depth);
  const byId = new Map(projected.map((item) => [item.node.id, item]));
  const selectedTrace = selectedPath ? graphTracePaths(selectedPath) : null;

  for (const edge of scene.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const highlighted = Boolean(selectedTrace?.has(from.node.path) && selectedTrace?.has(to.node.path));
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.strokeStyle = highlighted ? 'rgba(153, 199, 255, .68)' : 'rgba(145, 161, 190, .24)';
    context.lineWidth = highlighted ? 1.35 : 0.85;
    context.stroke();
  }

  const clickTargets: Array<{ node: GraphNode; x: number; y: number; r: number }> = [];
  for (const item of projected) {
    const { node, x, y, depth } = item;
    const depthScale = Math.max(0.55, Math.min(1.35, 1.03 - depth * 0.24));
    const selected = node.path === selectedPath;
    const age = node.editedAt ? Math.max(0, Date.now() - node.editedAt) : Infinity;
    const active = age < ACTIVE_EDIT_MS;
    const baseRadius = node.path === ROOT_NODE_PATH ? 5.2 : node.kind === 'group' ? 4.2 : active ? 4.8 : 2.6;
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
      ? selected
        ? 'rgba(218, 229, 246, .96)'
        : node.path === ROOT_NODE_PATH
          ? 'rgba(193, 205, 226, .9)'
          : 'rgba(168, 177, 198, .78)'
      : active
        ? 'rgba(128, 219, 255, .96)'
        : selected
          ? 'rgba(230, 245, 255, .96)'
          : `rgba(181, 198, 224, ${Math.max(.32, .7 - Math.abs(depth) * .2)})`;
    context.fill();
    clickTargets.push({ node, x, y, r: radius });

    if (selected) {
      context.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const text = displayGraphPath(node.path);
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
function pathSegments(path: string) { return normalizePath(path).split('/').filter(Boolean); }
function leafName(path: string) { return pathSegments(path).at(-1) || normalizePath(path); }
function displayGraphPath(path: string) { return path === ROOT_NODE_PATH ? 'root' : `root/${normalizePath(path)}`; }
function graphTracePaths(path: string) {
  const trace = new Set<string>([ROOT_NODE_PATH]);
  if (path === ROOT_NODE_PATH) return trace;
  const segments = pathSegments(path);
  for (let depth = 1; depth <= segments.length; depth += 1) trace.add(segments.slice(0, depth).join('/'));
  return trace;
}
function hashNumber(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function relativeTime(value: number) { const delta = Date.now() - Number(value || 0); if (!value) return 'recently'; if (delta < 5_000) return 'just now'; if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`; return `${Math.floor(delta / 3_600_000)}h ago`; }
function humanTool(value: string) { return value.replace(/^cuppet_/, '').replace(/^tst_/, 'TST ').replace(/^workspace_/, '').replaceAll('_', ' ').replace(/\b\w/g, (match) => match.toUpperCase()); }
function cleanError(error: unknown) { return error instanceof Error ? error.message : String(error ?? 'TST graph unavailable'); }

function MemoryIcon() { return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.15" fill="currentColor"/><circle cx="4" cy="6" r="1.3" fill="currentColor"/><circle cx="15.5" cy="4.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="4.5" cy="14.5" r="1.3" fill="currentColor"/><path d="m5.1 6.8 3.1 2M11.7 8.4l2.8-2.9M11.8 11.4l2.7 2.9M8.2 11.3l-2.7 2.4" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round"/></svg>; }
function RefreshIcon({ spinning }: { spinning: boolean }) { return <svg className={spinning ? 'spin' : ''} viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M14.4 7.1A5.8 5.8 0 1 0 14 11.8M14.4 3.9v3.3h-3.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function CloseIcon() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m5.3 5.3 7.4 7.4m0-7.4-7.4 7.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/></svg>; }
