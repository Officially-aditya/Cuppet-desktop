import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('../src/renderer/react/client-session-state.ts', import.meta.url), 'utf8'))
  .replace(/import \{ useSyncExternalStore \} from 'react';/, '');

async function fixture(t, saved = null) {
  const previousStorage = globalThis.localStorage;
  let value = saved;
  globalThis.localStorage = {
    getItem() { return value; },
    setItem(_key, next) { value = next; },
  };
  const store = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  store.resetClientSessionStateStore();
  t.after(() => {
    store.resetClientSessionStateStore();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  return { store, saved: () => value };
}

function completed(sessionId, role = 'assistant') {
  return { type: 'message.completed', message: { id: `reply-${sessionId}`, sessionId, role, content: 'Work finished.', status: 'complete' } };
}

test('agent completion marks background chats unread and viewing each chat clears only its marker', async (t) => {
  const { store, saved } = await fixture(t);
  store.setViewedClientSession('current');
  store.reduceClientSessionEvent(completed('current'));
  assert.equal(store.clientUnreadSessionsSnapshot().size, 0);
  store.reduceClientSessionEvent(completed('background'));
  store.reduceClientSessionEvent(completed('general'));
  assert.deepEqual([...store.clientUnreadSessionsSnapshot()], ['background', 'general']);
  assert.deepEqual(JSON.parse(saved()), ['background', 'general']);
  store.setViewedClientSession('background');
  assert.deepEqual([...store.clientUnreadSessionsSnapshot()], ['general']);
  store.reduceClientSessionEvent(completed('background'));
  assert.deepEqual([...store.clientUnreadSessionsSnapshot()], ['general']);
  store.setViewedClientSession('general');
  assert.equal(store.clientUnreadSessionsSnapshot().size, 0);
});

test('work finishing while the app is not viewed remains unread until returning to the chat', async (t) => {
  const { store } = await fixture(t);
  store.setViewedClientSession('current');
  store.setViewedClientSession(null);
  store.reduceClientSessionEvent(completed('current'));
  assert.equal(store.clientUnreadSessionsSnapshot().has('current'), true);
  store.setViewedClientSession('current');
  assert.equal(store.clientUnreadSessionsSnapshot().has('current'), false);
});

test('streaming, user messages, and session metadata updates do not create unread agent work', async (t) => {
  const { store } = await fixture(t);
  store.reduceClientSessionEvent(completed('user-chat', 'user'));
  store.reduceClientSessionEvent(completed('system-chat', 'system'));
  store.reduceClientSessionEvent({ type: 'message.delta', sessionId: 'streaming', messageId: 'partial', content: 'Working…' });
  store.reduceClientSessionEvent({ type: 'session.updated', session: { id: 'renamed', title: 'Renamed chat', messages: [] } });
  assert.equal(store.clientUnreadSessionsSnapshot().size, 0);
});

test('unread markers survive reload, viewing persists acknowledgement, and purging removes markers', async (t) => {
  const { store, saved } = await fixture(t, JSON.stringify(['previous-work']));
  assert.equal(store.clientUnreadSessionsSnapshot().has('previous-work'), true);
  store.reduceClientSessionEvent(completed('new-work'));
  store.resetClientSessionStateStore();
  assert.deepEqual([...store.clientUnreadSessionsSnapshot()], ['previous-work', 'new-work']);
  store.setViewedClientSession('previous-work');
  assert.deepEqual(JSON.parse(saved()), ['new-work']);
  store.reduceClientSessionEvent({ type: 'session.purged', sessionId: 'new-work' });
  assert.deepEqual(JSON.parse(saved()), []);
});

test('invalid saved unread state falls back to an empty marker set', async (t) => {
  const { store } = await fixture(t, '{invalid JSON');
  assert.equal(store.clientUnreadSessionsSnapshot().size, 0);
});
