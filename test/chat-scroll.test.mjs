import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const transcriptCode = await compile('../src/renderer/react/ChatTranscript.tsx');
const followerCode = await compile('../src/renderer/react/scroll-follow.ts');

function fixture(savedValue = null) {
  const effects = [], refs = [], frames = new Map(), timers = new Map(), saved = new Map();
  const observers = {}, handle = {}, exports = {};
  let nextId = 0;
  if (savedValue !== null) saved.set('cuppet.desktop.scroll.chat', savedValue);
  const react = {
    memo: (component) => component,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (compute) => compute(),
    useImperativeHandle: (_ref, factory) => { handle.current = factory(); },
    useRef: (current) => { const ref = { current }; refs.push(ref); return ref; },
    useEffect: (effect) => effects.push(effect),
  };
  const context = vm.createContext({
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      if (name === './markdown-cache') return { createMarkdownCache: (render) => render };
      if (name === './scroll-follow') {
        const module = {};
        vm.runInContext(`(function (exports) {${followerCode}\n})`, context)(module);
        return module;
      }
      return {};
    },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    requestAnimationFrame: (frame) => { frames.set(++nextId, frame); return nextId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => { timers.set(++nextId, callback); return nextId; },
    clearTimeout: (id) => timers.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.resize = this; }
      observe(node) { this.targets.add(node); }
      unobserve(node) { this.targets.delete(node); }
      disconnect() { this.targets.clear(); }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.mutation = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  });
  vm.runInContext(transcriptCode, context);
  exports.ChatTranscript({ session: { id: 'chat', messages: [] }, project: null, transcript: {}, running: true });
  let scrollTop = 0;
  const listeners = new Map();
  const node = {
    clientHeight: 500, scrollHeight: 2000, children: [],
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  refs[0].current = node;
  const cleanup = effects.find((effect) => effect.toString().includes('createScrollFollower'))();
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  return {
    node, saved, handle, cleanup, listeners, observers, frames,
    update: effects.find((effect) => effect.toString().includes('.schedule()')),
    flush,
    resize: () => { observers.resize.callback(); flush(); },
    flushTimers: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    scrollTo: (top) => { node.scrollTop = top; listeners.get('scroll')(); },
  };
}

test('small upward scroll survives pending frames and streaming updates', () => {
  const chat = fixture();
  chat.update();
  chat.scrollTo(1470);
  chat.flush();
  assert.equal(chat.node.scrollTop, 1470);
  chat.node.scrollHeight += 100;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1470);
  assert.equal(chat.saved.has('cuppet.desktop.scroll.chat'), false, 'storage writes stay off the scroll path');
  chat.flushTimers();
  assert.equal(chat.saved.get('cuppet.desktop.scroll.chat'), '1470');
});

test('scrolling down to the latest messages resumes auto-follow', () => {
  const chat = fixture();
  chat.scrollTo(1200);
  chat.node.scrollHeight += 100;
  chat.resize();
  assert.equal(chat.node.scrollTop, 1200);
  chat.scrollTo(1600);
  chat.node.scrollHeight += 100;
  chat.resize();
  assert.equal(chat.node.scrollTop, 1700);
});

test('a delayed programmatic scroll event during rapid tool growth never disables following', () => {
  const chat = fixture();
  chat.node.scrollHeight += 400;
  chat.resize();
  assert.equal(chat.node.scrollTop, 1900);
  chat.node.scrollHeight += 600;
  chat.listeners.get('scroll')();
  chat.resize();
  assert.equal(chat.node.scrollTop, 2500);
});

test('new live and pending rows are observed after they mount and removed rows are released', () => {
  const chat = fixture();
  const row = {};
  chat.node.children.push(row);
  chat.observers.mutation.callback();
  assert.equal(chat.observers.resize.targets.has(row), true);
  chat.node.scrollHeight += 800;
  chat.resize();
  assert.equal(chat.node.scrollTop, 2300);
  chat.node.children = [];
  chat.observers.mutation.callback();
  assert.equal(chat.observers.resize.targets.has(row), false);
});

test('wheel-up stops a queued pin immediately and sending resumes following', () => {
  const chat = fixture();
  chat.listeners.get('wheel')({ deltaY: -40 });
  chat.node.scrollHeight += 300;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1500);
  chat.handle.current.followLatest();
  assert.equal(chat.node.scrollTop, 1800);
});

test('content shrinking is not interpreted as the user scrolling upward', () => {
  const chat = fixture();
  chat.node.scrollHeight -= 800;
  chat.scrollTo(700);
  chat.node.scrollHeight += 100;
  chat.resize();
  assert.equal(chat.node.scrollTop, 800);
});

test('a saved top position is restored and leaving a chat releases all work', () => {
  const chat = fixture('0');
  assert.equal(chat.node.scrollTop, 0);
  chat.node.scrollHeight += 300;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 0);
  chat.handle.current.followLatest();
  chat.cleanup();
  assert.equal(chat.saved.get('cuppet.desktop.scroll.chat'), '1800');
  assert.equal(chat.listeners.size, 0);
  assert.equal(chat.frames.size, 0);
  assert.equal(chat.observers.resize.targets.size, 0);
  assert.equal(chat.observers.mutation.disconnected, true);
});

test('leaving a chat saves the position the user was at, not the next chat\'s layout', () => {
  // React commits the next chat into the same scroll node before it runs this chat's cleanup, so
  // reading node.scrollTop at cleanup time would store the wrong number under this chat's key.
  const chat = fixture();
  chat.scrollTo(900);
  chat.node.scrollHeight = 600; // the next chat is much shorter...
  chat.node.scrollTop = 100; // ...and the browser has already clamped the scroll position
  chat.cleanup();
  assert.equal(chat.saved.get('cuppet.desktop.scroll.chat'), '900');
});

test('a pin that follows new content is what gets saved while the user is at the bottom', () => {
  const chat = fixture();
  chat.node.scrollHeight += 400;
  chat.update();
  chat.flush();
  chat.node.scrollHeight = 300; // next chat committed before cleanup...
  chat.node.scrollTop = 0; // ...and the browser clamped the position
  chat.cleanup();
  assert.equal(chat.saved.get('cuppet.desktop.scroll.chat'), '1900');
});
