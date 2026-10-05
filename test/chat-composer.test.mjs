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
  const states = [], refs = [], effects = [], frames = [], copied = [], sends = [], readers = [];
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
    FileReader: class {
      readAsDataURL() { readers.push(this); }
    },
  });
  function nodes(node = tree) {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap((child) => child == null ? [] : nodes(child));
    return [node, ...nodes(node.props?.children ?? null)];
  }
  function render() {
    stateIndex = refIndex = 0;
    effects.length = 0;
    const sessionId = props.session?.id ?? null;
    tree = exports.ChatPane({ ...props, onSend: async (text, deliveryMode, attachments) => {
      sends.push({ sessionId, text, deliveryMode, attachments });
      return props.onSend ? props.onSend(text, deliveryMode, attachments) : { clear: true };
    } });
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
    props, copied, node, refs, render, nodes, sends, readers,
    value: () => textarea().props.value,
    attachmentNames: () => nodes().filter((item) => item.props?.className === 'composer-attachment-name').map((item) => item.props.children),
    attach(files) { nodes().find((item) => item.type === 'input' && item.props.type === 'file').props.onChange({ currentTarget: { files, value: '' } }); },
    async settle() { await new Promise(setImmediate); flush(); },
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
      props.draft = null;
      render();
      effects.find((effect) => effect.toString().includes('historyRef.current = null'))();
      flush();
    },
    startDraft(projectId = null) {
      props.session = null;
      props.draft = { projectId, mode: 'build' };
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

test('Up and Down recall only sent messages and restore the unsent draft and attachments', async () => {
  const chat = fixture(sent);
  chat.type('draft');
  chat.attach([{ name: 'draft.txt', type: 'text/plain', size: 4 }]);
  await chat.settle();
  assert.equal(chat.key('ArrowUp'), true);
  assert.equal(chat.value(), 'second message');
  assert.deepEqual(chat.attachmentNames(), ['sent.png']);
  chat.key('ArrowUp');
  assert.equal(chat.value(), 'first message');
  chat.key('ArrowUp');
  assert.equal(chat.value(), 'first message');
  chat.key('ArrowDown');
  assert.equal(chat.value(), 'second message');
  chat.key('ArrowDown');
  assert.equal(chat.value(), 'draft');
  assert.deepEqual(chat.attachmentNames(), ['draft.txt']);
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

test('chat drafts and attachments stay isolated and sending clears only the sent chat', async () => {
  const chat = fixture();
  chat.type('first draft');
  chat.attach([{ name: 'first.txt', type: 'text/plain', size: 1 }]);
  await chat.settle();
  chat.resetSession('other');
  assert.equal(chat.value(), '');
  assert.deepEqual(chat.attachmentNames(), []);
  chat.key('Enter');
  assert.equal(chat.sends.length, 0);

  chat.type('second draft');
  chat.attach([{ name: 'second.txt', type: 'text/plain', size: 2 }]);
  await chat.settle();
  chat.resetSession('chat');
  assert.equal(chat.value(), 'first draft');
  assert.deepEqual(chat.attachmentNames(), ['first.txt']);
  chat.key('Enter');
  await chat.settle();
  assert.equal(chat.sends[0].sessionId, 'chat');
  assert.equal(chat.sends[0].text, 'first draft');
  assert.equal(chat.sends[0].attachments[0].name, 'first.txt');
  assert.equal(chat.value(), '');
  assert.deepEqual(chat.attachmentNames(), []);

  chat.resetSession('other');
  assert.equal(chat.value(), 'second draft');
  assert.deepEqual(chat.attachmentNames(), ['second.txt']);
  chat.key('Enter');
  await chat.settle();
  assert.equal(chat.sends[1].sessionId, 'other');
  assert.equal(chat.sends[1].text, 'second draft');
  assert.equal(chat.sends[1].attachments[0].name, 'second.txt');
});

test('new project and general drafts stay separate from existing chats and preserve mode changes', () => {
  const chat = fixture();
  chat.type('existing chat');
  chat.startDraft();
  assert.equal(chat.value(), '');
  chat.type('general draft');
  chat.startDraft('project-a');
  assert.equal(chat.value(), '');
  chat.type('project draft');
  chat.props.draft.mode = 'plan';
  chat.render();
  assert.equal(chat.value(), 'project draft');
  chat.startDraft('project-b');
  assert.equal(chat.value(), '');
  chat.type('other project draft');
  chat.resetSession('chat');
  assert.equal(chat.value(), 'existing chat');
  chat.startDraft();
  assert.equal(chat.value(), 'general draft');
  chat.startDraft('project-a');
  assert.equal(chat.value(), 'project draft');
  chat.startDraft('project-b');
  assert.equal(chat.value(), 'other project draft');
});

test('a send completing after a chat switch clears its original draft without changing the visible chat', async () => {
  const chat = fixture();
  let finishSend;
  chat.props.onSend = () => new Promise((resolve) => { finishSend = resolve; });
  chat.type('first prompt');
  chat.key('Enter');
  chat.resetSession('other');
  chat.type('second draft');
  chat.attach([{ name: 'second.txt', type: 'text/plain', size: 2 }]);
  await chat.settle();
  finishSend({ clear: true, commandResult: { id: 'old-command', title: 'Old command' } });
  await chat.settle();
  assert.equal(chat.sends[0].sessionId, 'chat');
  assert.equal(chat.value(), 'second draft');
  assert.deepEqual(chat.attachmentNames(), ['second.txt']);
  assert.equal(chat.nodes().some((item) => item.type?.name === 'CommandResultView'), false);
  chat.resetSession('chat');
  assert.equal(chat.value(), '');
});

test('a send completing in the same chat preserves edits made while it was pending', async () => {
  const chat = fixture();
  let finishSend;
  chat.props.onSend = () => new Promise((resolve) => { finishSend = resolve; });
  chat.type('submitted prompt');
  chat.key('Enter');
  chat.type('next prompt');
  finishSend({ clear: true });
  await chat.settle();
  assert.equal(chat.value(), 'next prompt');
});

test('image reads that finish after switching chats attach only to their original draft', async () => {
  const chat = fixture();
  chat.type('image prompt');
  chat.attach([{ name: 'first.png', type: 'image/png', size: 3 }]);
  assert.equal(chat.readers.length, 1);
  chat.resetSession('other');
  chat.type('other draft');
  chat.readers[0].result = 'data:image/png;base64,AQID';
  chat.readers[0].onload();
  await chat.settle();
  assert.equal(chat.value(), 'other draft');
  assert.deepEqual(chat.attachmentNames(), []);
  chat.resetSession('chat');
  assert.equal(chat.value(), 'image prompt');
  assert.deepEqual(chat.attachmentNames(), ['first.png']);
  chat.key('Enter');
  await chat.settle();
  assert.equal(chat.sends[0].sessionId, 'chat');
  assert.equal(chat.sends[0].attachments[0].dataUrl, 'data:image/png;base64,AQID');
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
