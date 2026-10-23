import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
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
  assert.equal((html.match(/message-reasoning-toggle/g) ?? []).length, 50);
  assert.equal(parsed.some((value) => value.includes('Thought')), false);
  assert.doesNotMatch(html, /message-reasoning-content/);
});
