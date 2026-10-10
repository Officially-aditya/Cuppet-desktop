import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/TstMemorySidebar.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source + '\nexport { buildScene, drawScene, getGraphView, MemoryGraphCanvas, ROOT_NODE_PATH };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function load(react = {}) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return {
        Fragment: 'fragment',
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
      throw new Error('Unexpected import: ' + name);
    },
  });
  return exports;
}

const { buildScene, drawScene, ROOT_NODE_PATH } = load();
const files = ['src/lib/b.ts', 'README.md', 'docs/api.md', 'src/lib/a.ts', 'src/app.ts'];
const expanded = () => new Set([ROOT_NODE_PATH, 'docs', 'src', 'src/lib']);
const paths = (scene) => Array.from(scene.nodes, (node) => node.path);
const coordinates = (scene) => Array.from(scene.nodes, (node) => [node.path, node.x, node.y]);

function contextFixture() {
  const labels = [], segments = [];
  return {
    labels, segments,
    clearRect() {}, beginPath() {}, stroke() {}, arc() {}, fill() {},
    setLineDash() {}, arcTo() {}, closePath() {},
    moveTo(x, y) { segments.push(['move', x, y]); },
    lineTo(x, y) { segments.push(['line', x, y]); },
    measureText(text) { return { width: text.length * 6 }; },
    fillText(text, x, y) { labels.push({ text, x, y }); },
    createRadialGradient() { return { addColorStop() {} }; },
  };
}

function canvasFixture() {
  const states = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0, scene, tree, selectedPath = null;
  const element = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 760, height: 480 }),
    setPointerCapture() {}, releasePointerCapture() {},
  };
  const api = load({
    useState(initial) {
      const slot = stateIndex++;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
    },
    useRef(initial) {
      const slot = refIndex++;
      return refs[slot] ??= { current: slot === 0 ? element : initial };
    },
    useMemo(compute) { scene = compute(); return scene; },
    useEffect(effect, deps) { if (deps.length) effects.push(effect); },
  });
  return {
    render(path = selectedPath) {
      selectedPath = path;
      stateIndex = refIndex = 0;
      effects.length = 0;
      tree = api.MemoryGraphCanvas({ files, edits: [], selectedPath, onSelect: (path) => { selectedPath = path; } });
      for (const effect of effects) effect();
      const projected = refs.find((ref) => Array.isArray(ref.current));
      const zoom = refs.find((ref) => typeof ref.current === 'number').current;
      const pan = refs.find((ref) => ref.current && Object.keys(ref.current).join(',') === 'x,y').current;
      api.drawScene(contextFixture(), 760, 480, scene, zoom, pan, selectedPath, null, null, projected, 0);
      return projected.current;
    },
    get scene() { return scene; },
    get canvas() { return tree.props.children.find((child) => child.type === 'canvas'); },
    event(x, y) { return { clientX: x, clientY: y, currentTarget: element, pointerId: 1 }; },
    click(target) {
      const event = this.event(target.x + 10 + target.labelWidth / 2, target.y);
      this.canvas.props.onPointerDown(event);
      this.canvas.props.onPointerUp(event);
      return this.render();
    },
  };
}

test('the initial tree shows root folders and files with deeper branches collapsed', () => {
  const scene = buildScene(files, []);
  assert.deepEqual(paths(scene), [ROOT_NODE_PATH, 'docs', 'src', 'README.md']);
  assert.equal(scene.nodes.find((node) => node.path === 'src').expanded, false);
  assert.equal(scene.nodes.find((node) => node.path === 'src').childCount, 2);
});

test('branches run left to right with separate leaf rows and centered parents', () => {
  const scene = buildScene([...files, 'src\\lib\\a.ts'], [], expanded());
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  assert.equal(new Set(paths(scene)).size, scene.nodes.length);
  for (const edge of scene.edges) assert.ok(byId.get(edge.to).x > byId.get(edge.from).x);
  const leaves = Array.from(scene.nodes).filter((node) => node.kind === 'file');
  for (let index = 1; index < leaves.length; index++) assert.ok(leaves[index].y - leaves[index - 1].y >= 30);
  for (const parent of scene.nodes.filter((node) => node.kind === 'group')) {
    const children = scene.edges.filter((edge) => edge.from === parent.id).map((edge) => byId.get(edge.to));
    assert.equal(parent.y, (children[0].y + children[children.length - 1].y) / 2);
  }
});

test('file order and edit refreshes keep the same branch layout', () => {
  const initial = buildScene(files, [], expanded());
  const refreshed = buildScene([...files].reverse(), [{ path: 'src/lib/b.ts', updatedAt: 100, tool: 'tst_edit_batch' }], expanded());
  assert.deepEqual(coordinates(refreshed), coordinates(initial));
  assert.equal(refreshed.nodes.find((node) => node.path === 'src/lib/b.ts').tool, 'tst_edit_batch');
});

test('folder labels expand and collapse their children on click', () => {
  const view = canvasFixture();
  let targets = view.render();
  targets = view.click(targets.find((target) => target.node.path === 'src'));
  assert.ok(paths(view.scene).includes('src/lib'));
  assert.ok(paths(view.scene).includes('src/app.ts'));
  assert.ok(!paths(view.scene).includes('src/lib/a.ts'));
  view.click(targets.find((target) => target.node.path === 'src'));
  assert.ok(!paths(view.scene).includes('src/lib'));
});

test('selecting a file reveals every folder on its path', () => {
  const view = canvasFixture();
  view.render('src/lib/b.ts');
  const targets = view.render('src/lib/b.ts');
  assert.ok(targets.some((target) => target.node.path === 'src/lib/b.ts'));
  assert.equal(view.scene.nodes.find((node) => node.path === 'src/lib').expanded, true);
});

test('the canvas shows labels and orthogonal connectors without moving between frames', () => {
  const scene = buildScene(files, [], expanded());
  const context = contextFixture(), targets = { current: [] };
  drawScene(context, 760, 480, scene, 1, { x: 0, y: 0 }, null, null, null, targets, 0);
  assert.equal(context.labels.length, scene.nodes.length);
  assert.ok(context.labels.some((label) => label.text === 'a.ts'));
  assert.equal(context.segments.length, scene.edges.length * 4);
  for (const target of targets.current) {
    assert.ok(target.x >= 20 && target.x + 10 + target.labelWidth < 760);
    assert.ok(target.y > 30 && target.y < 450);
  }
  const initial = Array.from(targets.current, (target) => [target.node.path, target.x, target.y]);
  drawScene(contextFixture(), 760, 480, scene, 1, { x: 0, y: 0 }, null, null, null, targets, 100000);
  assert.deepEqual(Array.from(targets.current, (target) => [target.node.path, target.x, target.y]), initial);
});

test('pan and pointer-centered zoom preserve the flat tree coordinates', () => {
  const view = canvasFixture();
  const before = view.render().find((target) => target.node.path === 'src');
  view.canvas.props.onPointerDown(view.event(740, 400));
  view.canvas.props.onPointerMove(view.event(780, 420));
  view.canvas.props.onPointerUp(view.event(780, 420));
  const panned = view.render().find((target) => target.node.path === 'src');
  assert.equal(panned.x, before.x + 40);
  assert.equal(panned.y, before.y + 20);
  let prevented = false;
  view.canvas.props.onWheel({ ...view.event(panned.x, panned.y), deltaY: -180, deltaMode: 0, preventDefault() { prevented = true; } });
  const zoomed = view.render().find((target) => target.node.path === 'src');
  assert.ok(prevented);
  assert.ok(Math.abs(zoomed.x - panned.x) < 0.001);
  assert.ok(Math.abs(zoomed.y - panned.y) < 0.001);
});
