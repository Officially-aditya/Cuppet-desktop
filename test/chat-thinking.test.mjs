import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { formatWorkedDuration, orderedTranscriptItems } from '../src/renderer/react/chat-transcript.ts';

const source = await readFile(new URL('../src/renderer/react/ChatTranscript.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source + '\nexport { MessageView, TraceView, ReasoningTraceRow };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture(component) {
  const states = [], refs = [];
  let stateIndex = 0, refIndex = 0;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return {
        useState(initial) {
          const slot = stateIndex++;
          if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
          return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
        },
        useRef(initial) {
          const slot = refIndex++;
          return refs[slot] ??= { current: initial };
        },
        useMemo: (compute) => compute(),
        useEffect: () => {},
      };
      if (name === 'react/jsx-runtime') return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
      return { formatWorkedDuration, orderedTranscriptItems };
    },
  });
  return (props) => {
    stateIndex = refIndex = 0;
    return exports[component](props);
  };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

const thought = { id: 'reason-1', type: 'reasoning', text: 'Inspecting the code.', sequence: 1, startedAt: 1000 };
const tool = { id: 'read-1', type: 'tool', tool: 'read', label: 'Read file', argumentsJson: '{}', sequence: 2, status: 'complete' };

test('thinking is collapsed while streaming, expands on click, and becomes a timed thought', () => {
  const render = fixture('ReasoningTraceRow');
  const props = { item: thought, contentId: 'thought-content', live: true };
  let tree = render(props);
  let button = find(tree, (node) => node.type === 'button');
  assert.equal(button.props.children[0].props.children, 'Thinking…');
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(find(tree, (node) => node.props.content), undefined);

  button.props.onClick();
  tree = render(props);
  button = find(tree, (node) => node.type === 'button');
  assert.equal(button.props['aria-expanded'], true);
  assert.equal(button.props['aria-controls'], 'thought-content');
  assert.equal(find(tree, (node) => node.props.content)?.props.content, thought.text);

  tree = render({ ...props, item: { ...thought, text: `${thought.text} Found it.`, completedAt: 86000 } });
  button = find(tree, (node) => node.type === 'button');
  assert.equal(button.props.children[0].props.children, 'Thought for 1m 25s');
  assert.equal(find(tree, (node) => node.props.content)?.props.content, 'Inspecting the code. Found it.');
  button.props.onClick();
  assert.equal(find(render(props), (node) => node.props.content), undefined);
});

test('history and interrupted thoughts use a stable end time; missing timestamps show no invented duration', () => {
  const render = fixture('ReasoningTraceRow');
  const props = { item: thought, contentId: 'thought-content', live: false, completedAt: 13000 };
  assert.equal(find(render(props), (node) => node.type === 'button').props.children[0].props.children, 'Thought for 12s');
  assert.equal(find(render({ ...props, item: { ...thought, startedAt: undefined } }), (node) => node.type === 'button').props.children[0].props.children, 'Thoughts');
});

test('pre-tool narration is labelled as progress rather than provider thinking', () => {
  const tree = fixture('ReasoningTraceRow')({
    item: { ...thought, kind: 'commentary', completedAt: 4000 }, contentId: 'progress-content', live: true,
  });
  assert.equal(find(tree, (node) => node.type === 'button').props.children[0].props.children, 'Worked for 3s');
});

test('expanded activity includes thoughts and tools with unique thought controls per message', () => {
  const render = fixture('TraceView');
  const props = { trace: [thought, tool], messageId: 'message-1', live: false };
  let tree = render(props);
  assert.ok(find(tree, (node) => node.type?.name === 'ReasoningTraceRow'));
  assert.ok(find(tree, (node) => node.type?.name === 'ToolTraceRow'));
  const firstId = find(tree, (node) => node.type?.name === 'ReasoningTraceRow').props.contentId;
  tree = render({ ...props, messageId: 'message-2' });
  assert.notEqual(find(tree, (node) => node.type?.name === 'ReasoningTraceRow').props.contentId, firstId);
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
  assert.ok(find(traceTree, (node) => node.type?.name === 'ToolTraceRow'));
  const plain = fixture('MessageView')({ message: { id: 'plain', role: 'assistant', status: 'complete', content: 'Answer.' } });
  assert.equal(find(plain, (node) => node.type?.name === 'TraceView'), undefined);
});
