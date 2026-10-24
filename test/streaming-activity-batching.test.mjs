import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { hydrateTranscript, reduceTranscriptEvent } from '../src/renderer/react/chat-transcript.ts';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-activity-batching-'));
  const path = join(dir, 'chat.sqlite3');
  const db = new ConversationDatabase(path);
  db.createSession({ id: 's' });
  db.appendMessage({ id: 'm', sessionId: 's', role: 'assistant', status: 'streaming' });
  const events = [];
  const runtime = new JournaledToolRuntime({ db, journal: null, emit: (event) => events.push(event), tst: { configured: false } });
  t.after(async () => { await runtime.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, events, path, run: (adapter) => runtime.run({ adapter, sessionId: 's', messages: [], onDelta: async (delta) => db.appendMessageContent('m', delta) }) };
}

test('5000 ACP-style text chunks persist and emit a single text boundary and preserve the answer', async (t) => {
  const f = await fixture(t);
  await f.run({ async stream(_messages, options) {
    for (let i = 0; i < 5000; i++) {
      options.onDelta('word');
      await options.onActivity({ type: 'activity.text.delta', text: 'word' });
    }
    return { text: 'word'.repeat(5000) };
  } });
  assert.equal(f.db.getMessage('m').content, 'word'.repeat(5000));
  assert.equal(f.db.listMessageActivities('s').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'runtime.activity').length, 1);
});

test('reasoning coalesces every 50ms with its first start and last completion, then flushes at boundaries and run end', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = Promise.withResolvers(), finish = Promise.withResolvers();
  let activity;
  const running = f.run({ async stream(_messages, options) {
    activity = options.onActivity;
    await activity({ type: 'activity.reasoning.delta', text: 'First ', startedAt: 100 });
    await activity({ type: 'activity.reasoning.delta', text: 'thought.', startedAt: 150, completedAt: 200 });
    ready.resolve();
    await finish.promise;
    await activity({ type: 'activity.reasoning.delta', text: 'Last thought.' });
    return { text: '' };
  } });
  await ready.promise;
  assert.equal(f.db.listMessageActivities('s').length, 0);
  t.mock.timers.tick(50);
  const first = f.db.listMessageActivities('s')[0].activity;
  assert.equal(first.text, 'First thought.');
  assert.equal(first.startedAt, 100);
  assert.equal(first.completedAt, 200);
  await activity({ type: 'activity.reasoning.delta', text: 'Next thought.' });
  await activity({ type: 'activity.text.delta', text: 'Answer' });
  await activity({ type: 'activity.text.delta', text: ' continuation' });
  await activity({ type: 'activity.tool.opened', tool: 'read', callId: 'c' });
  await activity({ type: 'activity.text.delta', text: 'New text run' });
  finish.resolve();
  await running;
  assert.deepEqual(f.db.listMessageActivities('s').map(({ activity: row }) => [row.type, row.text ?? row.callId]), [
    ['activity.reasoning.delta', 'First thought.'], ['activity.reasoning.delta', 'Next thought.'],
    ['activity.text.delta', 'Answer'], ['activity.tool.opened', 'c'], ['activity.text.delta', 'New text run'],
    ['activity.reasoning.delta', 'Last thought.'],
  ]);
  const count = f.events.length;
  t.mock.timers.tick(100);
  assert.equal(f.events.length, count);
});

test('reloading an ACP session reconstructs completed reasoning using the retained text boundary', async (t) => {
  const f = await fixture(t);
  await f.run({ async stream(_messages, options) {
    await options.onActivity({ type: 'activity.reasoning.delta', text: 'Inspecting ' });
    await options.onActivity({ type: 'activity.reasoning.delta', text: 'the project.' });
    for (let i = 0; i < 100; i++) {
      options.onDelta('answer ');
      await options.onActivity({ type: 'activity.text.delta', text: 'answer ' });
    }
    return { text: 'answer '.repeat(100) };
  } });
  f.db.updateMessage('m', { status: 'complete' });
  const reopened = new ConversationDatabase(f.path);
  try {
    const snapshot = reopened.getSession('s');
    const transcript = hydrateTranscript(snapshot.activities);
    assert.equal(snapshot.activities.length, 2);
    assert.equal(transcript.m.items[0].text, 'Inspecting the project.');
    assert.ok(transcript.m.items[0].completedAt);
  } finally { reopened.close(); }
});

test('reasoning still flushes durably when the provider fails', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ async stream(_messages, options) {
    await options.onActivity({ type: 'activity.reasoning.delta', text: 'Partial reasoning.' });
    throw new Error('Provider disconnected');
  } }), /Provider disconnected/);
  assert.equal(f.db.listMessageActivities('s')[0].activity.text, 'Partial reasoning.');
});

test('identical reasoning batches remain literal deltas after live reduction and reload', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = Promise.withResolvers(), finish = Promise.withResolvers();
  let activity;
  const running = f.run({ async stream(_messages, options) {
    activity = options.onActivity;
    await activity({ type: 'activity.reasoning.delta', text: 'think ' });
    ready.resolve();
    await finish.promise;
    await activity({ type: 'activity.text.delta', text: 'Done' });
    return { text: '' };
  } });
  await ready.promise;
  t.mock.timers.tick(50);
  await activity({ type: 'activity.reasoning.delta', text: 'think ' });
  t.mock.timers.tick(50);
  finish.resolve();
  await running;
  const reloaded = hydrateTranscript(f.db.listMessageActivities('s'));
  const live = f.events.reduce(reduceTranscriptEvent, {});
  assert.equal(reloaded.m.items[0].text, 'think think ');
  assert.equal(live.m.items[0].text, 'think think ');
});
