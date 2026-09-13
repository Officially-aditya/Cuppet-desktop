import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnStore } from '../src/runtime/turn-store.mjs';

test('queued turns survive runtime restart in FIFO order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-turn-store-'));
  const path = join(dir, 'turns.sqlite3');
  try {
    let store = new TurnStore(path);
    store.enqueue({ id: 'q1', sessionId: 's1', params: { text: 'one' }, queuedAt: 10 });
    store.enqueue({ id: 'q2', sessionId: 's1', params: { text: 'two' }, queuedAt: 20 });
    store.close();

    store = new TurnStore(path);
    assert.deepEqual(store.queuedSessions(), ['s1']);
    assert.equal(store.countQueued('s1'), 2);
    assert.equal(store.claimNext('s1').id, 'q1');
    store.completeQueue('q1');
    assert.equal(store.claimNext('s1').id, 'q2');
    store.completeQueue('q2');
    assert.equal(store.hasQueued('s1'), false);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run and queue projections are journaled as ordered durable runtime events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-turn-events-'));
  const path = join(dir, 'turns.sqlite3');
  try {
    let store = new TurnStore(path);
    store.startRun({ runId: 'm1', sessionId: 's1', projectId: 'p1', now: 10 });
    store.finishRun('m1', { status: 'complete', now: 20 });
    store.enqueue({ id: 'q1', sessionId: 's1', params: { text: 'secret queued prompt', attachments: [{ name: 'x' }] }, queuedAt: 30 });
    store.claimNext('s1', 40);
    store.completeQueue('q1', 50);

    const beforeRestart = store.listEvents('s1');
    assert.deepEqual(beforeRestart.map((event) => event.type), [
      'run.started',
      'run.finished',
      'queue.queued',
      'queue.started',
      'queue.dispatched',
    ]);
    assert.deepEqual(beforeRestart.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.ok(beforeRestart.every((event) => event.schemaVersion === 1));
    assert.equal(JSON.stringify(beforeRestart).includes('secret queued prompt'), false, 'event log must not duplicate queued prompt content');
    store.close();

    store = new TurnStore(path);
    assert.deepEqual(store.listEvents('s1'), beforeRestart);
    assert.deepEqual(store.listEvents('s1', { afterSequence: 3 }).map((event) => event.sequence), [4, 5]);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run start and finish are idempotent and terminal history is immutable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-turn-events-'));
  const path = join(dir, 'turns.sqlite3');
  try {
    const store = new TurnStore(path);
    const first = store.startRun({ runId: 'm1', sessionId: 's1', projectId: 'p1', now: 10 });
    const duplicateStart = store.startRun({ runId: 'm1', sessionId: 's1', projectId: 'changed', now: 20 });
    assert.deepEqual(duplicateStart, first);

    const completed = store.finishRun('m1', { status: 'complete', now: 30 });
    const lateFailure = store.finishRun('m1', { status: 'error', error: 'late transport close', now: 40 });
    assert.deepEqual(lateFailure, completed);
    assert.equal(store.getRun('m1').status, 'complete');
    assert.deepEqual(store.listEvents('s1').map((event) => event.type), ['run.started', 'run.finished']);
    assert.equal(store.listEvents('s1')[1].payload.status, 'complete');
    assert.throws(
      () => store.startRun({ runId: 'm1', sessionId: 's2', now: 50 }),
      /already belongs to session s1/,
    );
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a queue item interrupted during dispatch is not replayed and records recovery failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-turn-store-'));
  const path = join(dir, 'turns.sqlite3');
  try {
    let store = new TurnStore(path);
    store.enqueue({ id: 'q1', sessionId: 's1', params: { text: 'do not duplicate' } });
    const claimed = store.claimNext('s1');
    assert.equal(claimed.status, 'dispatching');
    store.close();

    store = new TurnStore(path);
    assert.equal(store.hasQueued('s1'), false);
    assert.deepEqual(store.queuedSessions(), []);
    const recovery = store.listEvents('s1').at(-1);
    assert.equal(recovery.type, 'queue.failed');
    assert.equal(recovery.payload.recovery, 'runtime_restart');
    assert.match(recovery.payload.error, /not replayed/i);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('active runs become interrupted after runtime restart and recovery is journaled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-turn-store-'));
  const path = join(dir, 'turns.sqlite3');
  try {
    let store = new TurnStore(path);
    store.startRun({ runId: 'm1', sessionId: 's1', projectId: 'p1' });
    assert.equal(store.getRun('m1').status, 'running');
    store.close();

    store = new TurnStore(path);
    const run = store.getRun('m1');
    assert.equal(run.status, 'interrupted');
    assert.match(run.error, /runtime restart/i);
    const events = store.listEvents('s1');
    assert.deepEqual(events.map((event) => event.type), ['run.started', 'run.finished']);
    assert.equal(events[1].payload.status, 'interrupted');
    assert.equal(events[1].payload.recovery, 'runtime_restart');
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
