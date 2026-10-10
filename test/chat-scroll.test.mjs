import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture() {
  const effects = [];
  const refs = [];
  const frames = [];
  const saved = new Map();
  const exports = {};
  const react = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (compute) => compute(),
    useRef: (current) => { const ref = { current }; refs.push(ref); return ref; },
    useEffect: (effect) => effects.push(effect),
  };
  vm.runInNewContext(compiled, {
    exports,
    navigator: { onLine: true },
    require: (name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      if (name === './client-transcript') return { useClientTranscript: () => ({}) };
      if (name === './behavior-preferences') return { readSendBehavior: () => 'queue' };
      return {};
    },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    requestAnimationFrame: (frame) => { frames.push(frame); return frames.length; },
    cancelAnimationFrame: () => {},
  });
  exports.ChatPane({ session: { id: 'chat', messages: [] }, draft: null, project: null, commands: [], running: true });
  let scrollTop = 0;
  const listeners = new Map();
  const node = {
    clientHeight: 500,
    scrollHeight: 2000,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
  refs[2].current = node;
  const scrollEffects = effects.filter((effect) => effect.toString().includes('messagesRef.current'));
  scrollEffects[0]();
  return {
    node,
    saved,
    update: scrollEffects[1],
    flush: () => { while (frames.length) frames.shift()(); },
    scrollTo: (top) => { node.scrollTop = top; listeners.get('scroll')(); },
  };
}

test('small upward scroll survives pending frames and streaming updates', () => {
  const chat = fixture();
  chat.update();
  chat.scrollTo(1470);
  chat.flush();
  assert.equal(chat.node.scrollTop, 1470, 'pending auto-scroll must respect manual scrolling');
  chat.node.scrollHeight += 100;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1470, 'streaming must preserve the position while reading history');
  assert.equal(chat.saved.get('cuppet.desktop.scroll.chat'), '1470');
});

test('scrolling down to the latest messages resumes auto-follow', () => {
  const chat = fixture();
  chat.scrollTo(1200);
  chat.node.scrollHeight += 100;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1200);
  chat.scrollTo(1600);
  chat.node.scrollHeight += 100;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1700);
});

test('new messages still follow automatically before manual scrolling', () => {
  const chat = fixture();
  chat.node.scrollHeight += 100;
  chat.update();
  chat.flush();
  assert.equal(chat.node.scrollTop, 1600);
});
