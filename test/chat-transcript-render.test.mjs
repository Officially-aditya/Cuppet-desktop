import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { workWords } from '../src/renderer/react/trace-presentation.ts';
import { loadModule } from './helpers/load-tsx.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const parsed = [];
const { ChatTranscript } = loadModule(new URL('../src/renderer/react/ChatTranscript.tsx', import.meta.url).pathname, {
  './markdown': {
    renderMarkdown: (value) => { parsed.push(value); return value; },
  },
  './DiffViewerModal': { CopyIcon: () => null, CheckIcon: () => null },
  './brand': { CUPPET_LOGO_URL: 'logo.png' },
  './reasoning-renderer': { createReasoningRenderer: () => assert.fail('Server rendering must not start a worker') },
});
const render = (props) => renderToStaticMarkup(React.createElement(ChatTranscript, {
  session: null, project: null, running: false, transcript: {}, onInspectDiff() {}, onOpenLightbox() {}, ...props,
}));
const attachments = [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }, { name: 'notes.txt' }];
const message = (id, role, content, status = 'complete') => ({ id, sessionId: 's1', role, content, status, attachments: role === 'user' ? attachments : [] });

test('confirmed and pending prompts show file chips and image previews in history', () => {
  for (const pending of [false, true]) {
    const html = render(pending ? {
      session: { id: 's1', messages: [] },
      pending: [{ id: 'pending_1', sessionId: 's1', kind: 'steer', content: 'review these', attachments, afterSequence: 0 }],
    } : { session: { id: 's1', messages: [message('u1', 'user', 'review these')] } });
    assert.match(html, /review these/);
    assert.match(html, /message-attachment-name[^>]*>notes.txt/);
    assert.match(html, /src="data:image\/png;base64,AAAA"/);
    assert.doesNotMatch(html, /empty-state/);
    if (pending) assert.match(html, /Adding to the current turn/);
  }
});

test('an earlier completed answer stays above the next prompt before its response starts', () => {
  const html = render({ running: true, session: { id: 's1', messages: [
    message('u1', 'user', 'first question'), message('a1', 'assistant', 'first answer'), message('u2', 'user', 'second question'),
  ] } });
  assert.ok(html.indexOf('first answer') < html.indexOf('second question'));
  assert.doesNotMatch(html, /message-preview/);
});

test('steered history and the live response retain their conversation order', () => {
  const html = render({ running: true, session: { id: 's1', messages: [
    message('u1', 'user', 'original task'), message('a1', 'assistant', 'first answer'),
    message('u2', 'user', 'additional guidance'), message('a2', 'assistant', 'continuing now', 'streaming'),
  ] } });
  // Streaming content is rendered by the worker after mount; its message shell keeps its place.
  const order = ['original task', 'first answer', 'additional guidance', 'data-message-id="a2"'].map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal((html.match(/message-preview/g) ?? []).length, 1);
});

test('a long tool loop does not parse any collapsed thinking content', () => {
  parsed.length = 0;
  const items = Array.from({ length: 100 }, (_, i) => i % 2 === 0
    ? { id: `r${i}`, type: 'reasoning', text: `Thought ${i} `.repeat(500), sequence: i, startedAt: 1, completedAt: 2 }
    : { id: `t${i}`, type: 'tool', tool: 'read_file', status: 'complete', argumentsJson: '{"path":"a.ts"}', sequence: i });
  const html = render({ running: true, session: { id: 's1', messages: [message('a1', 'assistant', '', 'streaming')] }, transcript: { a1: { items } } });
  assert.equal((html.match(/message-reasoning-toggle/g) ?? []).length, 0);
  assert.match(html, /message-cuppet-toggle[^>]*aria-expanded="true"/);
  assert.match(html, /Read 1 file/);
  assert.equal(parsed.some((value) => value.includes('Thought')), false);
  assert.doesNotMatch(html, /message-reasoning-content|trace-card/);
});

test('live work disclosures hide reasoning and tools but expose failures', () => {
  const html = render({ running: true, session: { id: 's1', messages: [message('a1', 'assistant', '', 'streaming')] }, transcript: {
    a1: { items: [
      { id: 'r', type: 'reasoning', text: '**Checking the fix**\nHidden detailed thought.', sequence: 1 },
      { id: 'read', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"a.ts"}', status: 'complete', sequence: 2 },
      { id: 'cmd', type: 'tool', tool: 'bash', argumentsJson: '{"command":"npm test"}', status: 'error', sequence: 3 },
    ] },
  } });
  assert.doesNotMatch(html, /Checking the fix/);
  assert.match(html, /Command failed: npm test/);
  assert.match(html, /trace-failure-count[^>]*>1<!-- --> failed|trace-failure-count[^>]*>1 failed/);
  assert.doesNotMatch(html, /Hidden detailed thought|thread-tool-row/);
});

test('a response waiting for its first event shows the live elapsed indicator', () => {
  const html = render({ running: true, session: { id: 's1', messages: [message('a1', 'assistant', '', 'streaming')] } });
  assert.ok(html.includes(workWords('a1').active + ' for '));
  assert.match(html, /message-cuppet-toggle[^>]*aria-expanded="true"/);
});

test('finished cards show stable duration and stopped turns say Stopped after', () => {
  for (const [status, label] of [['complete', workWords('a1').done + ' for 12s'], ['stopped', 'Stopped after 12s'], ['interrupted', 'Stopped after 12s']]) {
    const html = render({ session: { id: 's1', messages: [{ ...message('a1', 'assistant', 'Final answer', status), createdAt: 1000, updatedAt: 13000 }] },
      transcript: { a1: { items: [{ id: 'r', type: 'reasoning', text: 'Detailed thought.', sequence: 1 }] } } });
    assert.ok(html.includes(label));
    assert.match(html, /Final answer/);
    assert.doesNotMatch(html, /Detailed thought/);
  }
});

test('progress text and collapsed work intervals stay in chronological order', () => {
  const html = render({ running: true, session: { id: 's1', messages: [message('a1', 'assistant', '', 'streaming')] }, transcript: { a1: { items: [
    { id: 'first', type: 'reasoning', kind: 'commentary', text: 'Some previous text', sequence: 1, completedAt: 100 },
    { id: 'read', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"secret-tool-target.ts"}', status: 'complete', sequence: 2 },
    { id: 'next', type: 'reasoning', kind: 'commentary', text: 'This should be done like this', sequence: 3, completedAt: 200 },
    { id: 'thinking', type: 'reasoning', text: 'Private reasoning', sequence: 4 },
  ] } } });
  const positions = ['Some previous text', '>' + workWords('work-a1-read').done + ' for ', 'This should be done like this', '>Thinking for '].map(text => html.indexOf(text));
  assert.ok(positions.every(index => index >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal((html.match(/message-work-toggle/g) ?? []).length, 2);
  assert.match(html, /Read secret-tool-target\.ts/);
  assert.doesNotMatch(html, /Private reasoning|trace-card|thread-tool-row/);
});

test('the elapsed indicator also covers the gap before an assistant message exists and clears when idle', () => {
  const session = { id: 's1', messages: [{ ...message('u1', 'user', 'Start'), createdAt: Date.now() - 12000 }] };
  const live = render({ session, running: true });
  assert.match(live, /message-run-status/);
  assert.ok(live.includes(workWords('u1').active + ' for 12s'));
  assert.doesNotMatch(render({ session, running: false }), /message-run-status/);
});
