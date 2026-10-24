import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';
import { loadModule } from './helpers/load-tsx.mjs';

test('streaming text is live immediately, persisted in batches, and flushed on terminalization and close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-stream-'));
  const path = join(dir, 'chat.sqlite3');
  let db = new ConversationDatabase(path);
  try {
    db.createSession({ id: 's' });
    db.appendMessage({ id: 'm', sessionId: 's', role: 'assistant', status: 'streaming' });
    const sql = db.sqlRepository();
    sql.exec('CREATE TEMP TABLE writes (n INTEGER); INSERT INTO writes VALUES (0); CREATE TEMP TRIGGER count_content AFTER UPDATE OF content ON messages BEGIN UPDATE writes SET n=n+1; END;');
    const count = () => sql.prepare('SELECT n FROM writes').get().n;
    for (let i = 0; i < 8000; i++) db.appendMessageContent('m', 'word');
    assert.equal(count(), 1, 'only the first text needs an immediate durable lifecycle transition');
    assert.equal(db.getMessage('m').content.length, 32000);
    assert.equal(db.getSession('s').messages[0].content.length, 32000, 'snapshots include pending text');
    assert.equal(sql.prepare('SELECT length(content) AS n FROM messages').get().n, 4);
    t.mock.timers.tick(250);
    assert.equal(count(), 2);
    assert.equal(sql.prepare('SELECT length(content) AS n FROM messages').get().n, 32000);
    db.appendMessageContent('m', ' final');
    assert.equal(db.updateMessage('m', { status: 'stopped' }).content, 'word'.repeat(8000) + ' final');
    db.appendMessage({ id: 'm2', sessionId: 's', role: 'assistant', status: 'streaming' });
    db.appendMessageContent('m2', 'first');
    db.appendMessageContent('m2', ' pending');
    db.close();
    db = new ConversationDatabase(path);
    assert.equal(db.getMessage('m2').content, 'first pending');
    assert.equal(db.getMessage('m2').status, 'interrupted');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('runtime coalesces deltas without cumulative payloads and publishes the full final message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-deltas-'));
  const events = [];
  const done = Promise.withResolvers();
  const runtime = new RuntimeService({
    databasePath: join(dir, 'chat.sqlite3'),
    providerFactory: () => ({ async stream(_messages, { onDelta }) { for (let i = 0; i < 8000; i++) await onDelta('word'); return { text: 'word'.repeat(8000) }; } }),
    emit(event) { events.push(event); if (event.type === 'run.finished') done.resolve(); },
  });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'stream' });
    await done.promise;
    const deltas = events.filter((event) => event.type === 'message.delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].seq, 32000);
    assert.equal(deltas[0].delta, 'word'.repeat(8000));
    assert.equal('content' in deltas[0], false);
    const final = events.find((event) => event.type === 'message.completed').message;
    assert.equal(final.content, deltas[0].delta);
    assert.equal(final.status, 'complete');
    assert.ok(events.indexOf(deltas[0]) < events.findIndex((event) => event.type === 'message.completed'));
    const previews = events.filter((event) => event.type === 'message.preview');
    assert.equal(previews.length, 2, 'the real provider path sends the first preview and a final reset');
    assert.equal(previews[0].content, 'word');
    assert.equal(previews.at(-1).content, '');
    assert.ok(previews.reduce((bytes, event) => bytes + (event.delta ?? event.content).length, 0) <= 3 * final.content.length);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('client deltas tolerate duplicates and overlapping snapshots, and resync missing text', async () => {
  const previousWindow = globalThis.window;
  let refreshes = 0;
  const message = (content, status = 'streaming') => ({ id: 'm', sessionId: 's', role: 'assistant', content, status });
  globalThis.window = { cuppet: { sessions: { async get() { refreshes++; return { id: 's', messages: [message('Hello world')] }; } } } };
  const live = loadModule(resolve('src/renderer/react/client-transcript.ts'));
  const store = loadModule(resolve('src/renderer/react/client-session-state.ts'), { './client-transcript': live });
  try {
    store.hydrateClientSessions([{ id: 's', messages: [message('Hello')] }]);
    const delta = { type: 'message.delta', sessionId: 's', messageId: 'm', delta: 'lo world', seq: 11 };
    store.reduceClientSessionEvent(delta);
    store.reduceClientSessionEvent(delta);
    assert.equal(live.clientTranscriptSnapshot('s').m.content, 'Hello world');
    assert.equal(store.clientSessionSnapshot('s').messages[0].content, 'Hello', 'live content does not mutate the session collection');
    store.hydrateClientSessions([{ id: 's', messages: [message('H')] }]);
    store.reduceClientSessionEvent({ ...delta, delta: 'world' });
    await store.refreshClientSession('s');
    assert.equal(refreshes, 1);
    assert.equal(store.clientSessionSnapshot('s').messages[0].content, 'Hello world');
    store.upsertClientMessage(message('Done', 'complete'));
    store.reduceClientSessionEvent(delta);
    assert.equal(store.clientSessionSnapshot('s').messages[0].content, 'Done');
  } finally { store.resetClientSessionStateStore(); globalThis.window = previousWindow; }
});

test('streaming markdown matches full parsing through partial fences, lists, quotes and tables', () => {
  const { createStreamingMarkdownRenderer, renderMarkdown } = loadModule(resolve('src/renderer/react/markdown.ts'));
  const source = '# Header\n\nFirst paragraph.\n\n- one\n\n- two\n  continued\n\n> quote\n> next\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~~js\nconst a = 1;\n\nconst b = 2;\n~~~\n\nFinal paragraph.';
  const render = createStreamingMarkdownRenderer();
  let previousBlocks = [];
  for (let i = 1; i <= source.length; i++) {
    const { blocks, tail } = render(source.slice(0, i));
    assert.equal([...blocks, tail].filter(Boolean).join('\n'), renderMarkdown(source.slice(0, i)), `prefix ${i}`);
    previousBlocks.forEach((html, index) => assert.equal(blocks[index], html));
    previousBlocks = blocks;
  }
  assert.ok(previousBlocks.length >= 5, 'completed blocks leave the live parse path');
  const reset = render('Replacement');
  assert.deepEqual(reset.blocks, []);
  assert.equal(reset.tail, renderMarkdown('Replacement'));
});
