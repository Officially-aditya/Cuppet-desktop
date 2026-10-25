import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as traceSummary from '../src/renderer/react/trace-summary.ts';
import * as tracePresentation from '../src/renderer/react/trace-presentation.ts';
import { formatWorkedDuration, orderedTranscriptItems } from '../src/renderer/react/chat-transcript.ts';

const source = await readFile(new URL('../src/renderer/react/ChatTranscript.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source + '\nexport { TranscriptMessage, MessageView, TraceView, WorkTraceRow, WorkDuration, ToolTraceRow, ToolTraceDetails };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture(component, { deferred = false, now = Date.now() } = {}) {
  const states = [], refs = [], memos = [], parsed = [];
  let stateIndex = 0, refIndex = 0, memoIndex = 0;
  let deferredReady = !deferred;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    Date: class extends Date { static now() { return now; } },
    JSON: { parse(value) { parsed.push(value); return JSON.parse(value); }, stringify: JSON.stringify },
    require(name) {
      if (name === 'react') return {
        memo: (component) => component,
        useState(initial) {
          const slot = stateIndex++;
          if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
          return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
        },
        useRef(initial) {
          const slot = refIndex++;
          return refs[slot] ??= { current: initial };
        },
        useMemo(compute, deps) {
          const slot = memoIndex++;
          const prior = memos[slot];
          if (!prior || deps.some((dep, index) => !Object.is(dep, prior.deps[index]))) memos[slot] = { deps, value: compute() };
          return memos[slot].value;
        },
        useDeferredValue: (value, initial) => deferredReady ? value : initial,
        useEffect: () => {},
        useImperativeHandle: () => {},
      };
      if (name === 'react/jsx-runtime') return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
      if (name === './trace-summary') return { ...traceSummary, parseToolArguments(value) { parsed.push(value); return traceSummary.parseToolArguments(value); } };
      if (name === './trace-presentation') return tracePresentation;
      if (name === './markdown-cache') return { createMarkdownCache: (render) => render };
      return { formatWorkedDuration, orderedTranscriptItems };
    },
  });
  const render = (props) => {
    stateIndex = refIndex = memoIndex = 0;
    return exports[component](props);
  };
  render.flushDeferred = () => { deferredReady = true; };
  render.parsed = parsed;
  return render;
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

test('sent user messages show files alongside image previews and retain the prompt', () => {
  const image = { name: 'screen.png', dataUrl: 'data:image/png;base64,AQID' };
  let preview;
  const tree = fixture('MessageView')({
    message: { id: 'user-files', role: 'user', content: 'Review these files', attachments: [
      { name: 'notes.txt', mime: 'text/plain', size: 42 },
      { name: 'report.pdf', mime: 'application/pdf', size: 1024 },
      { name: 'unreadable.png', mime: 'image/png' },
      image,
    ] },
    onOpenLightbox: (value) => { preview = value; },
  });
  assert.equal(find(tree, (node) => node.props?.className === 'message-text').props.children, 'Review these files');
  assert.equal(find(tree, (node) => node.props?.className === 'message-attachments').props['aria-label'], 'Attached files');
  for (const name of ['notes.txt', 'report.pdf', 'unreadable.png']) {
    assert.ok(find(tree, (node) => node.props?.className === 'message-attachment-name' && node.props.children === name), name);
  }
  assert.equal(find(tree, (node) => node.props?.className === 'message-attachment-name' && node.props.children === image.name), undefined);
  assert.equal(find(tree, (node) => node.type === 'img').props.src, image.dataUrl);
  find(tree, (node) => node.props?.className === 'message-image-thumb-btn').props.onClick();
  assert.equal(preview.src, image.dataUrl);
  assert.equal(preview.name, image.name);
});

test('attachment-only user messages show files; text-only messages have no attachment row', () => {
  const render = fixture('MessageView');
  const message = { id: 'files-only', role: 'user', content: '', attachments: [{ name: 'notes.txt' }] };
  assert.ok(find(render({ message }), (node) => node.props?.className === 'message-attachment-name' && node.props.children === 'notes.txt'));
  assert.equal(find(render({ message: { ...message, content: 'Text only', attachments: [] } }), (node) => node.props?.className === 'message-attachments'), undefined);
  assert.equal(find(render({ message: { id: 'legacy', role: 'user', content: 'Legacy message' } }), (node) => node.props?.className === 'message-attachments'), undefined);
});

test('only the newest five historical messages render immediately', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', content: 'History',
  }));
  const tree = fixture('ChatTranscript')({ session: { id: 'chat', messages }, project: null, transcript: {}, running: false });
  const section = find(tree, (node) => node.type === 'section');
  const rows = Array.from(section.props.children).flat(Infinity).filter((node) => node?.type?.name === 'TranscriptMessage');
  assert.deepEqual(rows.map((node) => node.props.deferred), [true, true, true, false, false, false, false, false]);
  assert.deepEqual(rows.map((node) => node.props.message.id), messages.map((message) => message.id));
});

test('historical content is deferred without losing attachments, tool activity, or its scroll target', () => {
  const render = fixture('TranscriptMessage', { deferred: true });
  const message = { id: 'old-message', role: 'user', content: 'Review the attachment', attachments: [{ name: 'notes.txt' }] };
  const items = [{ id: 'call', type: 'tool', tool: 'tst_read', argumentsJson: '{"path":"notes.txt"}', sequence: 1, status: 'complete' }];
  const props = { message, items, deferred: true, projectId: 'project' };
  let tree = render(props);
  assert.equal(find(tree, (node) => node.props['data-message-id'] === message.id).props['aria-busy'], 'true');
  assert.equal(find(tree, (node) => node.type?.name === 'MessageView'), undefined);
  assert.equal(render.parsed.length, 0);
  render.flushDeferred();
  tree = render(props);
  const view = find(tree, (node) => node.type?.name === 'MessageView');
  assert.equal(view.props.message.attachments, message.attachments);
  assert.equal(view.props.items, items);
  assert.equal(find(render(props), (node) => node.type?.name === 'MessageView'), view, 'unchanged history reuses the rendered element');
});

test('expanded activity defers tools older than the newest five and keeps running tools immediate', () => {
  const trace = Array.from({ length: 9 }, (_, index) => ({
    id: `call-${index}`, type: 'tool', tool: 'tst_read', argumentsJson: '{}',
    sequence: index + 1, status: index === 0 ? 'running' : 'complete',
  }));
  const groups = fixture('TraceView')({ trace, messageId: 'message', live: true });
  const groupProps = find(groups, (node) => node.type?.name === 'WorkTraceRow').props;
  const render = fixture('WorkTraceRow');
  assert.equal(find(render(groupProps), (node) => node.type?.name === 'ToolTraceRow'), undefined);
  find(render(groupProps), (node) => node.type === 'button').props.onClick();
  const rows = find(render(groupProps), (node) => node.props.className === 'message-work-details').props.children;
  assert.ok(rows.every((node) => node.type?.name === 'ToolTraceRow'), 'tool rows keep their component type as they age');
  assert.deepEqual(rows.filter((node) => !node.props.deferred).map((node) => node.props.item.id), ['call-0', 'call-4', 'call-5', 'call-6', 'call-7', 'call-8']);
  assert.deepEqual(rows.filter((node) => node.props.deferred).map((node) => node.props.item.id), ['call-1', 'call-2', 'call-3']);
});

test('earlier tool details load in the background or immediately when requested', () => {
  const item = { id: 'earlier', type: 'tool', tool: 'tst_read', argumentsJson: '{"path":"notes.txt"}', details: 'Stored output', sequence: 1, status: 'complete' };
  const render = fixture('ToolTraceRow', { deferred: true });
  assert.equal(find(render({ item, deferred: true }), (node) => node.type?.name === 'ToolTraceDetails'), undefined);
  render.flushDeferred();
  assert.equal(find(render({ item, deferred: true }), (node) => node.type?.name === 'ToolTraceDetails').props.item, item);

  const onDemand = fixture('ToolTraceRow', { deferred: true });
  find(onDemand({ item, deferred: true }), (node) => node.type === 'button').props.onClick();
  const props = find(onDemand({ item, deferred: true }), (node) => node.type?.name === 'ToolTraceDetails').props;
  assert.equal(props.initialOpen, true);
  assert.ok(find(fixture('ToolTraceDetails')(props), (node) => node.props.className === 'thread-tool-detail'));
});

test('diff extraction waits for background rendering and preserves modified files', () => {
  const render = fixture('MessageView', { deferred: true });
  const props = {
    message: { id: 'edits', role: 'assistant', status: 'complete', content: 'Done' },
    items: [{ id: 'edit', type: 'tool', tool: 'workspace_edit', argumentsJson: '{"path":"notes.txt","old_text":"old","new_text":"new"}', sequence: 1, status: 'complete' }],
  };
  assert.equal(find(render(props), (node) => node.props.className === 'turn-diff-card'), undefined);
  assert.equal(render.parsed.length, 0, 'diff extraction must not parse old tool arguments on the urgent render');
  render.flushDeferred();
  const tree = render(props);
  assert.ok(find(tree, (node) => node.props.className === 'turn-diff-card'));
  assert.ok(render.parsed.length > 0);
});

const thought = { id: 'reason-1', type: 'reasoning', text: 'Inspecting the code.', sequence: 1, startedAt: 1000 };
const tool = { id: 'read-1', type: 'tool', tool: 'read', label: 'Read file', argumentsJson: '{}', sequence: 2, status: 'complete' };

test('thinking opens its reasoning and tool calls in one disclosure and retains parsed content when closed', () => {
  const render = fixture('WorkTraceRow');
  const props = { group: { id: thought.id, type: 'work-group', items: [thought, tool] }, contentId: 'work-content', live: true };
  let tree = render(props);
  let button = find(tree, (node) => node.type === 'button');
  assert.equal(find(tree, node => node.type?.name === 'WorkDuration').props.active, true);
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(find(tree, (node) => node.props.content), undefined);
  button.props.onClick();
  tree = render(props);
  assert.equal(find(tree, (node) => node.type === 'button').props['aria-controls'], 'work-content');
  assert.equal(find(tree, (node) => node.props.content)?.props.content, thought.text);
  assert.ok(find(tree, (node) => node.type?.name === 'ToolTraceRow'));
  find(tree, (node) => node.type === 'button').props.onClick();
  tree = render(props);
  assert.equal(find(tree, (node) => node.props.content)?.props.open, false);
  assert.equal(find(tree, (node) => node.props.className === 'message-work-details').props.hidden, true);
});

test('completed tools keep their activity live until the agent finishes, and stale tools cannot keep it live afterward', () => {
  const render = fixture('WorkTraceRow');
  const props = { group: { id: tool.id, type: 'work-group', items: [{ ...tool, status: 'running' }] }, contentId: 'work', live: true };
  const duration = tree => find(tree, node => node.type?.name === 'WorkDuration').props;
  assert.equal(duration(render(props)).active, true);
  assert.equal(duration(render({ ...props, group: { ...props.group, items: [tool] } })).active, true);
  const tree = render({ ...props, live: false });
  assert.equal(duration(tree).active, false);
  assert.doesNotMatch(find(tree, node => node.type === 'button').props.title, /Reading|Running/);
  assert.equal(find(tree, (node) => node.type?.name === 'ToolTraceRow'), undefined);
});

test('only the latest work interval is active while the agent continues', () => {
  const trace = [{ ...tool, status: 'running' }, { ...thought, id: 'progress', kind: 'commentary', sequence: 3, startedAt: 5000, completedAt: 6000 }, { ...tool, id: 'latest', sequence: 4 }];
  const props = { trace, messageId: 'm', live: true, startedAt: 1000 };
  const render = fixture('TraceView');
  const rows = tree => Array.from(tree.props.children).filter(node => node.type?.name === 'WorkTraceRow');
  assert.deepEqual(rows(render(props)).map(node => node.props.live), [false, true]);
  assert.deepEqual(rows(render({ ...props, live: false })).map(node => node.props.live), [false, false]);
});

test('elapsed work labels use seconds, minutes and hours and retain the matching past tense', () => {
  const words = tracePresentation.workWords('timed');
  const text = tree => tree.props.children.flat().join('');
  for (const [duration, expected] of [[12000, '12s'], [85000, '1m 25s'], [7200000, '2h 0m']]) {
    const props = { id: 'timed', active: true, startedAt: 1000, completedAt: 1000 + duration };
    assert.equal(text(fixture('WorkDuration', { now: 1000 + duration })(props)), `${words.active} for ${expected}`);
    assert.equal(text(fixture('WorkDuration', { now: 99999999 })({ ...props, active: false })), `${words.done} for ${expected}`);
  }
});

test('progress is rendered inline and work controls keep unique IDs per message', () => {
  const render = fixture('TraceView');
  const progress = { ...thought, id: 'commentary', kind: 'commentary', completedAt: 4000 };
  const props = { trace: [progress, tool], messageId: 'message-1', live: false };
  let tree = render(props);
  assert.equal(find(tree, (node) => node.props.className?.includes('message-commentary')).props.content, thought.text);
  const firstId = find(tree, (node) => node.type?.name === 'WorkTraceRow').props.contentId;
  tree = render({ ...props, messageId: 'message-2' });
  assert.notEqual(find(tree, (node) => node.type?.name === 'WorkTraceRow').props.contentId, firstId);
});

test('collapsing a completed turn hides every thought and tool while keeping its summary visible', () => {
  const render = fixture('MessageView');
  const props = {
    message: { id: 'completed-turn', role: 'assistant', status: 'complete', content: 'The final summary.', createdAt: 1000, updatedAt: 13000 },
    trace: [thought, tool, { ...thought, id: 'reason-2', sequence: 3 }, { ...thought, id: 'reason-3', sequence: 4 }],
  };
  let tree = render(props);
  const summary = (node) => node.props.className === 'message-content markdown-rendered';
  const toggle = (node) => node.props.className?.startsWith('message-cuppet-toggle');
  assert.equal(find(tree, (node) => node.type?.name === 'TraceView'), undefined);
  assert.equal(find(tree, summary).props.content, 'The final summary.');
  assert.equal(find(tree, toggle).props['aria-expanded'], false);

  find(tree, toggle).props.onClick();
  tree = render(props);
  const traceProps = find(tree, (node) => node.type?.name === 'TraceView').props;
  assert.equal(traceProps.trace.length, 4);
  assert.equal(find(tree, summary).props.content, 'The final summary.');
  assert.equal(find(tree, toggle).props['aria-expanded'], true);

  find(tree, toggle).props.onClick();
  tree = render(props);
  assert.equal(find(tree, (node) => node.type?.name === 'TraceView'), undefined);
  assert.equal(find(tree, summary).props.content, 'The final summary.');
});

test('reasoning-only turns can collapse their whole trace', () => {
  const render = fixture('MessageView');
  const props = {
    message: { id: 'thought-only', role: 'assistant', status: 'complete', content: 'Summary.' },
    trace: [thought],
  };
  let tree = render(props);
  const toggle = (node) => node.props.className?.startsWith('message-cuppet-toggle');
  assert.equal(find(tree, (node) => node.type?.name === 'TraceView'), undefined);
  find(tree, toggle).props.onClick();
  tree = render(props);
  assert.ok(find(tree, (node) => node.type?.name === 'TraceView'));
  find(tree, toggle).props.onClick();
  assert.equal(find(render(props), (node) => node.type?.name === 'TraceView'), undefined);
});

test('streamed reasoning preserves a manually opened or closed Cuppet disclosure', () => {
  const render = fixture('MessageView');
  const props = { message: { id: 'live', role: 'assistant', status: 'streaming', content: '' }, live: true, trace: [thought] };
  const toggle = (tree) => find(tree, (node) => node.props.className?.startsWith('message-cuppet-toggle'));
  assert.equal(toggle(render(props)).props['aria-expanded'], true);
  toggle(render(props)).props.onClick();
  assert.equal(toggle(render(props)).props['aria-expanded'], false);
  toggle(render(props)).props.onClick();
  const updated = { ...props, trace: [{ ...thought, text: '**Checking tests**\nMore detail.' }, tool] };
  assert.equal(toggle(render(updated)).props['aria-expanded'], true);
  toggle(render(updated)).props.onClick();
  assert.equal(toggle(render({ ...updated, trace: [...updated.trace, { ...tool, id: 'another' }] })).props['aria-expanded'], false);
});

test('growing tool groups preserve the open state and show failures while folded', () => {
  const render = fixture('WorkTraceRow');
  const props = { group: { id: tool.id, type: 'work-group', items: [tool] }, contentId: 'group-content' };
  find(render(props), (node) => node.type === 'button').props.onClick();
  const updated = { ...props, group: { ...props.group, items: [tool, { ...tool, id: 'failed', status: 'error' }] } };
  let tree = render(updated);
  assert.equal(find(tree, (node) => node.type === 'button').props['aria-expanded'], true);
  assert.equal(find(tree, (node) => node.props.className === 'message-work-details').props.children.length, 2);
  find(tree, (node) => node.type === 'button').props.onClick();
  tree = render(updated);
  assert.equal(find(tree, (node) => node.props.className === 'message-work-details').props.hidden, true);
  assert.ok(find(tree, (node) => node.props.className === 'trace-failure-count'));
});

test('providers without thoughts retain their answer and tool activity without an empty thinking control', () => {
  const render = fixture('MessageView');
  const props = {
    message: { id: 'codex-style', role: 'assistant', status: 'complete', content: 'The final answer.', createdAt: 1000, updatedAt: 13000 },
    trace: [tool],
  };
  let tree = render(props);
  assert.equal(find(tree, (node) => node.props.className === 'message-content markdown-rendered').props.content, 'The final answer.');
  assert.equal(find(tree, (node) => node.type?.name === 'TraceView'), undefined);
  find(tree, (node) => node.props.className?.startsWith('message-cuppet-toggle')).props.onClick();
  tree = render(props);
  const traceProps = find(tree, (node) => node.type?.name === 'TraceView').props;
  const traceTree = fixture('TraceView')(traceProps);
  assert.equal(find(traceTree, (node) => node.type?.name === 'ReasoningTraceRow'), undefined);
  assert.ok(find(traceTree, (node) => node.type?.name === 'WorkTraceRow'));
  const plain = fixture('MessageView')({ message: { id: 'plain', role: 'assistant', status: 'complete', content: 'Answer.' } });
  assert.equal(find(plain, (node) => node.type?.name === 'TraceView'), undefined);
});
