import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/load-tsx.mjs';

function fixture() {
  const api = loadModule(new URL('../src/renderer/react/client-session-state.ts', import.meta.url).pathname);
  api.hydrateClientSessions([{ id: 's1', messages: [] }]);
  return api;
}
const attachments = [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }, { name: 'notes.txt', path: '/tmp/notes.txt' }];
const add = (api, content = 'look here', kind = 'steer') => api.addPendingUserMessage({ sessionId: 's1', kind, content, attachments });
const message = (id, sequence = 1, content = 'look here') => ({ id, sessionId: 's1', role: 'user', content, attachments, sequence });

test('pending prompts retain attachments, stable snapshots, and their session', () => {
  const api = fixture();
  add(api);
  const pending = api.pendingUserMessagesSnapshot('s1');
  assert.equal(pending, api.pendingUserMessagesSnapshot('s1'));
  assert.equal(pending[0].attachments, attachments);
  assert.equal(api.pendingUserMessagesSnapshot('other').length, 0);
});

test('runtime confirmation replaces its matching pending prompt without losing attachments', () => {
  const api = fixture();
  add(api);
  add(api, 'also run the tests');
  api.reduceClientSessionEvent({ type: 'message.created', message: message('u1') });
  assert.deepEqual(api.pendingUserMessagesSnapshot('s1').map((item) => item.content), ['also run the tests']);
  assert.deepEqual(api.clientSessionSnapshot('s1').messages[0].attachments, attachments);
});

test('repeated snapshots cannot acknowledge a second identical pending prompt', () => {
  const api = fixture();
  add(api);
  add(api);
  const first = message('u1');
  api.reduceClientSessionEvent({ type: 'message.created', message: first });
  api.upsertClientSession({ id: 's1', messages: [first] });
  assert.equal(api.pendingUserMessagesSnapshot('s1').length, 1);
  api.upsertClientSession({ id: 's1', messages: [first, message('u2', 2)] });
  assert.equal(api.pendingUserMessagesSnapshot('s1').length, 0);
});

test('old history, another session, and different attachments cannot acknowledge a new prompt', () => {
  const api = fixture();
  const old = message('old');
  api.upsertClientSession({ id: 's1', messages: [old] });
  add(api);
  api.upsertClientSession({ id: 's1', messages: [old] });
  api.reduceClientSessionEvent({ type: 'message.created', message: { ...message('other', 2), sessionId: 's2' } });
  api.reduceClientSessionEvent({ type: 'message.created', message: { ...message('different', 3), attachments: [{ name: 'other.txt' }] } });
  assert.equal(api.pendingUserMessagesSnapshot('s1').length, 1);
});

test('failed sends and finished runs release pending prompts; routing only clears source sends', () => {
  const api = fixture();
  const id = add(api);
  api.removePendingUserMessage(id);
  assert.equal(api.pendingUserMessagesSnapshot('s1').length, 0);
  add(api);
  add(api, 'new task', 'send');
  api.reduceClientSessionEvent({ type: 'run.started', sessionId: 'routed', sourceSessionId: 's1' });
  assert.deepEqual(api.pendingUserMessagesSnapshot('s1').map((item) => item.kind), ['steer']);
  api.reduceClientSessionEvent({ type: 'run.finished', sessionId: 's1' });
  assert.equal(api.pendingUserMessagesSnapshot('s1').length, 0);
});
