import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cuppet-session-window-'));
  const path = join(dir, 'db.sqlite3');
  const db = new ConversationDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.createSession({ id: 's1' });
  return { db, path };
}

function append(db, sequence) {
  const message = db.appendMessage({ id: `m${sequence}`, sessionId: 's1', role: 'assistant', content: `message ${sequence}` });
  db.appendMessageActivity({ sessionId: 's1', messageId: message.id, activity: { type: 'activity.reasoning.delta', text: 'Thinking' } });
  db.createToolExecution({ id: `t${sequence}`, sessionId: 's1', messageId: message.id, callId: `c${sequence}`, toolName: 'read_file' });
}

test('session windows return the newest messages in order and page before an exclusive cursor', t => {
  const { db } = fixture(t);
  for (let sequence = 1; sequence <= 5; sequence++) append(db, sequence);
  const latest = db.getSessionWindow('s1', { limit: 2 });
  assert.deepEqual(latest.messages.map(row => row.sequence), [4, 5]);
  assert.deepEqual(latest.history, { hasMore: true, beforeSequence: 4 });
  const earlier = db.getSessionWindow('s1', { limit: 2, beforeSequence: latest.history.beforeSequence });
  assert.deepEqual(earlier.messages.map(row => row.sequence), [2, 3]);
  const first = db.getSessionWindow('s1', { limit: 2, beforeSequence: 2 });
  assert.deepEqual(first.messages.map(row => row.sequence), [1]);
  assert.deepEqual(first.history, { hasMore: false, beforeSequence: 1 });
  assert.deepEqual(db.getSessionWindow('s1', { beforeSequence: 1 }).history, { hasMore: false, beforeSequence: null });
  assert.equal(db.getSessionWindow('missing'), null);
  assert.throws(() => db.getSessionWindow('s1', { limit: -1 }), /limit/);
  assert.throws(() => db.getSessionWindow('s1', { beforeSequence: 0 }), /cursor/);
});

test('activities and tool executions are scoped to the messages in each window', t => {
  const { db } = fixture(t);
  for (let sequence = 1; sequence <= 5; sequence++) append(db, sequence);
  db.createToolExecution({ id: 'unbound', sessionId: 's1', callId: 'unbound', toolName: 'read_file' });
  const window = db.getSessionWindow('s1', { limit: 2, beforeSequence: 4 });
  assert.deepEqual(window.activities.map(row => row.messageId), ['m2', 'm3']);
  assert.deepEqual(window.toolExecutions.map(row => row.id), ['t2', 't3']);
  assert.equal(db.listToolExecutions('s1').length, 6, 'unfiltered internal reads remain complete');
  assert.deepEqual(db.listToolExecutions('s1', { messageIds: [] }), []);
});

test('windowed reads include streaming content that has not been flushed to SQLite', t => {
  const { db } = fixture(t);
  db.appendMessage({ id: 'stream', sessionId: 's1', role: 'assistant', content: 'first', status: 'streaming' });
  db.appendMessageContent('stream', ' pending');
  assert.equal(db.getSessionWindow('s1').messages[0].content, 'first pending');
});

test('session.get passes its window and cursor through to the database', async t => {
  const { db, path } = fixture(t);
  for (let sequence = 1; sequence <= 75; sequence++) append(db, sequence);
  const runtime = new RuntimeService({ databasePath: path });
  try {
    const latest = await runtime.handle('session.get', { sessionId: 's1' });
    assert.equal(latest.messages.length, 60);
    const earlier = await runtime.handle('session.get', { sessionId: 's1', limit: 10, beforeSequence: latest.history.beforeSequence });
    assert.deepEqual(earlier.messages.map(row => row.sequence), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  } finally { await runtime.close(); }
});

test('a 1000-message history with 10000 activities stays under 250 KB per initial window', t => {
  const { db } = fixture(t);
  db.transaction(() => {
    for (let index = 1; index <= 1000; index++) {
      db.appendMessage({ id: `m${index}`, sessionId: 's1', role: index % 2 ? 'user' : 'assistant', content: 'Example message content. '.repeat(12) });
      for (let activity = 0; activity < 10; activity++) db.appendMessageActivity({
        sessionId: 's1', messageId: `m${index}`, activity: { type: 'activity.reasoning.delta', text: 'Inspecting the requested change.' },
      });
    }
  });
  const payload = db.getSessionWindow('s1');
  assert.equal(payload.messages.length, 60);
  assert.equal(payload.activities.length, 600);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 250 * 1024);
  assert.equal(db.getSession('s1').messages.length, 1000, 'provider/internal history is unaffected');
});

test('remote history cursors reach pages older than the desktop initial window', async t => {
  const { RemoteCommandAdapter } = await import('../src/runtime/remote/commands.mjs');
  const { db, path } = fixture(t);
  db.transaction(() => { for (let sequence = 1; sequence <= 100; sequence++) append(db, sequence); });
  const runtime = new RuntimeService({ databasePath: path });
  const remote = new RemoteCommandAdapter({
    call: (method, params) => runtime.handle(method, params),
    identity: { hostId: 'window-host', deviceName: 'Test' }, providerConfig: {},
  });
  try {
    const page = await remote.execute({ deviceID: 'device' }, 'session.snapshot', { sessionID: 's1', limit: 10, beforeSequence: 20 });
    assert.deepEqual(page.session.messages.map(row => row.sequence), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(page.history.hasMore, true);
    const first = await remote.execute({ deviceID: 'device' }, 'session.snapshot', { sessionID: 's1', limit: 10, beforeSequence: 10 });
    assert.deepEqual(first.session.messages.map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(first.history.hasMore, false);
  } finally { await runtime.close(); }
});
