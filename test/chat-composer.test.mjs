import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture(messages = []) {
  const states = [], refs = [], effects = [], frames = [], copied = [];
  let stateIndex = 0, refIndex = 0, tree, selection = null;
  const listeners = new Map();
  const props = { session: { id: 'chat', messages }, draft: null, project: null, commands: [], running: false };
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useRef(initial) { return refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }); },
    useMemo: (compute) => compute(),
    useEffect: (effect) => effects.push(effect),
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './client-transcript') return { useClientTranscript: () => ({}) };
      if (name === './chat-transcript') return { orderedTranscriptItems: (items) => items };
      if (name === './behavior-preferences') return { readSendBehavior: () => 'queue' };
      return {};
    },
    window: {
      innerWidth: 800, innerHeight: 600, getSelection: () => selection,
      addEventListener: () => {}, removeEventListener: () => {},
      cuppet: { native: { copyText: async (text) => { copied.push(text); } } },
    },
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
    },
    requestAnimationFrame: (frame) => { frames.push(frame); return frames.length; },
    cancelAnimationFrame: () => {},
  });
  function nodes(node = tree) {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap((child) => child == null ? [] : nodes(child));
    return [node, ...nodes(node.props?.children ?? null)];
  }
  function render() {
    stateIndex = refIndex = 0;
    effects.length = 0;
    tree = exports.ChatPane(props);
    return tree;
  }
  render();
  const node = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 54,
    focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  refs[0].current = node;
  refs[3].current = { contains: (child) => child?.inside === true };
  const textarea = () => nodes().find((item) => item.type === 'textarea');
  function flush() {
    render();
    node.value = textarea().props.value;
    while (frames.length) frames.shift()();
  }
  return {
    props, copied, node, refs, states, render, nodes,
    value: () => textarea().props.value,
    type(text) { node.value = text; node.setSelectionRange(text.length, text.length); textarea().props.onChange({ target: node }); flush(); },
    key(key, extra = {}) {
      let prevented = false;
      textarea().props.onKeyDown({ key, currentTarget: node, nativeEvent: {}, preventDefault: () => { prevented = true; }, ...extra });
      flush();
      return prevented;
    },
    select(text, inside = true) {
      effects[0]();
      selection = { isCollapsed: false, rangeCount: 1, anchorNode: { inside }, focusNode: { inside },
        toString: () => text, getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 750, top: 570, bottom: 590 }) }),
        removeAllRanges: () => { selection = null; } };
      listeners.get('selectionchange')();
      flush();
    },
    click(label) { nodes().find((item) => item.type === 'button' && item.props.children === label).props.onClick(); flush(); },
    resetSession(id) {
      props.session = { id, messages: [] };
      render();
      effects.find((effect) => effect.toString().includes('historyRef.current = null'))();
      flush();
    },
  };
}

const sent = [
  { id: 'first', role: 'user', content: 'first message' },
  { id: 'response', role: 'assistant', content: 'answer' },
  { id: 'second', role: 'user', content: 'second message', attachments: [{ name: 'sent.png', dataUrl: 'data:image/png;base64,AQID' }] },
];

test('Up and Down recall only sent messages and restore the unsent draft and attachments', () => {
  const chat = fixture(sent);
  chat.type('draft');
  const draftAttachments = [{ name: 'draft.png', dataUrl: 'data:image/png;base64,BAUG' }];
  chat.states[1] = draftAttachments;
  chat.render();
  assert.equal(chat.key('ArrowUp'), true);
  assert.equal(chat.value(), 'second message');
  assert.equal(chat.states[1][0].name, 'sent.png');
  chat.key('ArrowUp');
  assert.equal(chat.value(), 'first message');
  chat.key('ArrowUp');
  assert.equal(chat.value(), 'first message');
  chat.key('ArrowDown');
  assert.equal(chat.value(), 'second message');
  chat.key('ArrowDown');
  assert.equal(chat.value(), 'draft');
  assert.equal(chat.states[1], draftAttachments);
  assert.equal(chat.key('ArrowDown'), false);
});

test('history recall leaves multiline cursor movement, selected text, and composing input alone', () => {
  const chat = fixture(sent);
  chat.type('line one\nline two\nline three');
  chat.node.setSelectionRange(12, 12);
  assert.equal(chat.key('ArrowUp'), false);
  assert.equal(chat.key('ArrowDown'), false);
  chat.node.setSelectionRange(0, 3);
  assert.equal(chat.key('ArrowUp'), false);
  chat.node.setSelectionRange(0, 0);
  assert.equal(chat.key('ArrowUp', { nativeEvent: { isComposing: true } }), false);
  assert.equal(chat.key('ArrowUp', { shiftKey: true }), false);
});

test('changing chats resets recalled history', () => {
  const chat = fixture(sent);
  chat.key('ArrowUp');
  chat.resetSession('other');
  assert.equal(chat.key('ArrowDown'), false);
  assert.equal(chat.refs[4].current, null);
});

test('selected chat text can be copied or appended to the draft, and outside selections are ignored', async () => {
  const chat = fixture(sent);
  chat.type('existing draft');
  chat.select('selected text');
  const menu = chat.nodes().find((item) => item.props?.className === 'chat-selection-menu');
  assert.ok(menu);
  assert.ok(menu.props.style.left < 750 && menu.props.style.top < 570);
  chat.click('Copy');
  await Promise.resolve();
  assert.deepEqual(chat.copied, ['selected text']);
  chat.select('selected text');
  chat.click('Add to chat');
  assert.equal(chat.value(), 'existing draft\n\nselected text');
  assert.equal(chat.nodes().some((item) => item.props?.className === 'chat-selection-menu'), false);
  chat.select('outside text', false);
  assert.equal(chat.nodes().some((item) => item.props?.className === 'chat-selection-menu'), false);
});
