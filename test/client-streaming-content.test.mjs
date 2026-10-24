import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/load-tsx.mjs';

function fixture(t, get) {
  const previous = globalThis.window;
  const live = loadModule(new URL('../src/renderer/react/client-transcript.ts', import.meta.url).pathname);
  const store = loadModule(new URL('../src/renderer/react/client-session-state.ts', import.meta.url).pathname, { './client-transcript': live });
  globalThis.window = { cuppet: { sessions: { get, list: async () => [] } } };
  t.after(() => { store.resetClientSessionStateStore(); globalThis.window = previous; });
  return { live, store };
}
const message = (content, status = 'streaming') => ({ id: 'm', sessionId: 's', sequence: 1, role: 'assistant', content, status, updatedAt: 10 });
const snapshot = (content, status) => ({ id: 's', messages: [message(content, status)] });
const delta = (text, seq) => ({ type: 'message.delta', sessionId: 's', messageId: 'm', delta: text, seq });

test('1000 deltas update the live content cursor without publishing a new sessions array', (t) => {
  const { live, store } = fixture(t, async () => assert.fail('contiguous deltas must not refetch'));
  store.upsertClientSession(snapshot('Hi 👋'));
  const sessions = store.clientSessionsSnapshot();
  let seq = 'Hi 👋'.length;
  for (let i = 0; i < 1000; i++) store.reduceClientSessionEvent(delta('x', ++seq));
  store.reduceClientSessionEvent(delta('x', seq));
  assert.equal(live.clientTranscriptSnapshot('s').m.content, 'Hi 👋' + 'x'.repeat(1000));
  assert.equal(store.clientSessionsSnapshot(), sessions);
  assert.equal(store.clientSessionSnapshot('s').messages[0].content, 'Hi 👋');
  store.reduceClientSessionEvent({ type: 'message.completed', message: message('Final answer', 'complete') });
  assert.equal(store.clientSessionSnapshot('s').messages[0].content, 'Final answer');
  assert.equal(live.clientTranscriptSnapshot('s').m.content, undefined);
  store.reduceClientSessionEvent(delta('late', seq + 4));
  assert.equal(live.clientTranscriptSnapshot('s').m.content, undefined);
});

test('gaps resync once and stale snapshots cannot roll back live content or resurrect a completed message', async (t) => {
  const response = Promise.withResolvers();
  let gets = 0;
  const { live, store } = fixture(t, () => { gets++; return response.promise; });
  store.upsertClientSession(snapshot('H'));
  store.reduceClientSessionEvent(delta('world', 11));
  store.reduceClientSessionEvent(delta('world', 11));
  assert.equal(gets, 1);
  response.resolve(snapshot('Hello world'));
  await store.refreshClientSession('s');
  store.reduceClientSessionEvent(delta('lo world!', 12));
  store.upsertClientSession(snapshot('He'));
  assert.equal(live.clientTranscriptSnapshot('s').m.content, 'Hello world!');
  store.reduceClientSessionEvent({ type: 'message.completed', message: message('Final', 'complete') });
  store.upsertClientSession(snapshot('Old streaming snapshot'));
  store.reduceClientSessionEvent(delta('late', 100));
  assert.equal(store.clientSessionSnapshot('s').messages[0].status, 'complete');
  assert.equal(live.clientTranscriptSnapshot('s').m.content, undefined);
});

test('50 tool calls reconcile the session once at run finish', async (t) => {
  let gets = 0;
  const { store } = fixture(t, async () => { gets++; return snapshot('Done', 'complete'); });
  store.upsertClientSession(snapshot(''));
  for (let i = 0; i < 50; i++) {
    store.reduceClientSessionEvent({ type: 'tool.started', sessionId: 's', messageId: 'm', callId: `c${i}` });
    store.reduceClientSessionEvent({ type: 'tool.finished', sessionId: 's', messageId: 'm', callId: `c${i}`, success: true });
  }
  assert.equal(gets, 0);
  store.reduceClientSessionEvent({ type: 'message.completed', message: message('Done', 'complete') });
  store.reduceClientSessionEvent({ type: 'run.finished', sessionId: 's', messageId: 'm' });
  await store.refreshClientSession('s');
  assert.equal(gets, 1);
});

test('terminal snapshots complete reloaded reasoning even when no text follows it', (t) => {
  const { live, store } = fixture(t, async () => snapshot('Done', 'complete'));
  store.upsertClientSession(snapshot('Done', 'complete'));
  live.hydrateClientTranscript('s', [{ messageId: 'm', sessionId: 's', source: 'provider', sequence: 1, createdAt: 5,
    activity: { type: 'activity.reasoning.delta', text: 'Finished thinking.' } }]);
  assert.equal(live.clientTranscriptSnapshot('s').m.items[0].completedAt, 10);
});
