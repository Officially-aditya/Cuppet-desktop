import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/load-tsx.mjs';

function loadStore() {
  return loadModule(new URL('../src/renderer/react/client-session-state.ts', import.meta.url).pathname);
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const attachments = [{ name: 'shot.png', mime: 'image/png', dataUrl: PNG, size: 8 }];
const message = (id, sequence, role, content, extra = {}) => ({ id, sessionId: 's1', sequence, role, content, status: 'complete', updatedAt: sequence, ...extra });

function seeded(messages) {
  const store = loadStore();
  store.upsertClientSession({ id: 's1', updatedAt: 1, messages });
  return store;
}

test('a stale snapshot cannot drop a prompt created after it was read', () => {
  const store = seeded([message('u1', 1, 'user', 'first'), message('a1', 2, 'assistant', 'done'), message('u2', 3, 'user', 'steer this', { attachments })]);
  // Read before u2 existed, delivered after its message.created event.
  store.upsertClientSession({ id: 's1', updatedAt: 2, messages: [message('u1', 1, 'user', 'first'), message('a1', 2, 'assistant', 'done')] });
  const messages = store.clientSessionSnapshot('s1').messages;
  assert.deepEqual(plain(messages.map((item) => item.id)), ['u1', 'a1', 'u2']);
  assert.equal(messages[2].attachments[0].dataUrl, PNG, 'the prompt keeps its attachments');
});

test('a stale snapshot cannot roll a finished or longer message back', () => {
  const store = seeded([message('u1', 1, 'user', 'go'), message('a1', 2, 'assistant', 'final answer', { status: 'complete' })]);
  store.upsertClientSession({ id: 's1', updatedAt: 2, messages: [message('u1', 1, 'user', 'go'), message('a1', 2, 'assistant', 'fin', { status: 'streaming' })] });
  const reply = store.clientSessionSnapshot('s1').messages[1];
  assert.equal(reply.content, 'final answer');
  assert.equal(reply.status, 'complete');

  const streaming = seeded([message('a1', 2, 'assistant', 'partial text so far', { status: 'streaming' })]);
  streaming.upsertClientSession({ id: 's1', updatedAt: 2, messages: [message('a1', 2, 'assistant', 'partial', { status: 'streaming' })] });
  assert.equal(streaming.clientSessionSnapshot('s1').messages[0].content, 'partial text so far');
});

test('a snapshot still fills in older messages, advances streaming ones, and drops removed ones', () => {
  const store = seeded([message('u1', 1, 'user', 'go'), message('a1', 2, 'assistant', 'par', { status: 'streaming' }), message('gone', 3, 'user', 'removed upstream')]);
  store.upsertClientSession({ id: 's1', updatedAt: 5, messages: [
    message('u0', 0, 'user', 'earlier'),
    message('u1', 1, 'user', 'go'),
    message('a1', 2, 'assistant', 'partial answer', { status: 'complete' }),
    message('u9', 4, 'user', 'later'),
  ] });
  const messages = store.clientSessionSnapshot('s1').messages;
  assert.deepEqual(plain(messages.map((item) => item.id)), ['u0', 'u1', 'a1', 'u9']);
  assert.equal(messages[2].content, 'partial answer');
  assert.equal(messages[2].status, 'complete');
});

test('unchanged messages keep their object identity across refreshes', () => {
  const store = seeded([message('u1', 1, 'user', 'first', { attachments }), message('a1', 2, 'assistant', 'done')]);
  const before = store.clientSessionSnapshot('s1').messages;
  store.upsertClientSession({ id: 's1', updatedAt: 2, messages: plain(before) });
  const after = store.clientSessionSnapshot('s1').messages;
  assert.equal(after[0], before[0], 'user prompt with attachments is reused, not re-created');
  assert.equal(after[1], before[1]);
  assert.equal(after, before, 'an identical snapshot leaves the message list untouched');
});

test('a summary without messages leaves the loaded messages alone', () => {
  const store = seeded([message('u1', 1, 'user', 'first', { attachments })]);
  store.upsertClientSession({ id: 's1', updatedAt: 9, title: 'Renamed' });
  const session = store.clientSessionSnapshot('s1');
  assert.equal(session.title, 'Renamed');
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].attachments[0].name, 'shot.png');
});

test('window pages preserve loaded messages and merge activities and tools by key', () => {
  const store = loadStore();
  const activity = (messageId, sequence, text) => ({ messageId, sequence, source: 'provider', activity: { text } });
  const latest = {
    id: 's1', messages: [message('m3', 3, 'assistant', 'three'), message('m4', 4, 'assistant', 'four')],
    activities: [activity('m3', 1, 'three')], toolExecutions: [{ id: 't3', status: 'running' }],
    history: { hasMore: true, beforeSequence: 3 },
  };
  store.upsertClientSession(latest);
  store.upsertClientSession({
    id: 's1', messages: [message('m1', 1, 'user', 'one'), message('m2', 2, 'assistant', 'two')],
    activities: [activity('m2', 1, 'two')], toolExecutions: [{ id: 't2', status: 'complete' }],
    history: { hasMore: false, beforeSequence: 1 },
  });
  store.upsertClientSession({ ...latest, toolExecutions: [{ id: 't3', status: 'complete' }] });
  const session = store.clientSessionSnapshot('s1');
  assert.deepEqual(plain(session.messages.map(row => row.id)), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(session.activities.length, 2, 'refreshes do not duplicate or drop earlier activity');
  assert.deepEqual(plain(session.toolExecutions.map(row => [row.id, row.status])), [['t3', 'complete'], ['t2', 'complete']]);
  assert.deepEqual(plain(session.history), { hasMore: false, beforeSequence: 1 });
});

test('event refreshes request enough messages to retain the expanded window', async t => {
  const previous = globalThis.window;
  t.after(() => { globalThis.window = previous; });
  const store = loadStore();
  const messages = Array.from({ length: 120 }, (_, i) => message(`m${i}`, i + 1, 'assistant', 'text'));
  store.upsertClientSession({ id: 's1', messages, history: { hasMore: true, beforeSequence: 1 } });
  const calls = [];
  globalThis.window = { cuppet: { sessions: { get: async (id, options) => {
    calls.push(options);
    return { id, messages, history: { hasMore: true, beforeSequence: 1 } };
  } } } };
  store.reduceClientSessionEvent({ type: 'run.finished', sessionId: 's1' });
  await store.refreshClientSession('s1');
  assert.equal(calls[0].limit, 140);
  await store.refreshClientSession('s1', { limit: 60, beforeSequence: 80 });
  assert.deepEqual(plain(calls[1]), { limit: 60, beforeSequence: 80 });
});
