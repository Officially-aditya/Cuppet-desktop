import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { RunWaitProjection, interactionEvent } from '../src/runtime/run-wait-projection.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-wait-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  const turns = new TurnStore(db.sqlRepository());
  const waits = new RunWaitProjection(db.sqlRepository());
  return {
    dir, db, turns, waits,
    close: async () => {
      turns.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('permission and question events normalize to durable wait identities', () => {
  assert.deepEqual(interactionEvent({ type: 'permission.requested', request: { id: 'p1', sessionId: 's1' } }), {
    phase: 'requested', kind: 'permission', sessionId: 's1', requestId: 'p1',
  });
  assert.deepEqual(interactionEvent({ type: 'question.resolved', requestId: 'q1', sessionId: 's1', accepted: true }), {
    phase: 'resolved', kind: 'question', sessionId: 's1', requestId: 'q1',
  });
  assert.equal(interactionEvent({ type: 'message.delta', sessionId: 's1' }), null);
});

test('run remains waiting until every concurrent interaction resolves', async () => {
  const f = await fixture();
  try {
    f.turns.startRun({ runId: 'run-1', sessionId: 'session-1', now: 10 });
    assert.equal(f.turns.getRun('run-1').status, 'running');

    f.waits.observe({ type: 'permission.requested', request: { id: 'perm-1', sessionId: 'session-1' } }, 20);
    assert.equal(f.turns.getRun('run-1').status, 'waiting');
    assert.equal(f.waits.pending('run-1'), 1);

    f.waits.observe({ type: 'question.requested', request: { id: 'question-1', sessionId: 'session-1' } }, 30);
    assert.equal(f.turns.getRun('run-1').status, 'waiting');
    assert.equal(f.waits.pending('run-1'), 2);

    f.waits.observe({ type: 'permission.resolved', sessionId: 'session-1', requestId: 'perm-1', allowed: true }, 40);
    assert.equal(f.turns.getRun('run-1').status, 'waiting');
    assert.equal(f.waits.pending('run-1'), 1);

    f.waits.observe({ type: 'question.resolved', sessionId: 'session-1', requestId: 'question-1', accepted: true }, 50);
    assert.equal(f.turns.getRun('run-1').status, 'running');
    assert.equal(f.waits.pending('run-1'), 0);

    const events = f.turns.listEvents('session-1').map((event) => ({ type: event.type, payload: event.payload }));
    assert.deepEqual(events.map((event) => event.type), [
      'run.started',
      'run.waiting',
      'run.waiting',
      'run.wait.resolved',
      'run.resumed',
    ]);
    assert.equal(events[1].payload.pending, 1);
    assert.equal(events[2].payload.pending, 2);
    assert.equal(events[3].payload.pending, 1);
    assert.equal(events[4].payload.pending, 0);
  } finally {
    await f.close();
  }
});

test('duplicate requested events are idempotent and cannot inflate pending count', async () => {
  const f = await fixture();
  try {
    f.turns.startRun({ runId: 'run-2', sessionId: 'session-2', now: 10 });
    const request = { type: 'permission.requested', request: { id: 'perm-dup', sessionId: 'session-2' } };
    f.waits.observe(request, 20);
    f.waits.observe(request, 21);
    assert.equal(f.waits.pending('run-2'), 1);
    assert.equal(f.turns.listEvents('session-2').filter((event) => event.type === 'run.waiting').length, 1);
  } finally {
    await f.close();
  }
});

test('terminal run cleanup prevents late interaction resolution from resurrecting generation', async () => {
  const f = await fixture();
  try {
    f.turns.startRun({ runId: 'run-3', sessionId: 'session-3', now: 10 });
    f.waits.observe({ type: 'question.requested', request: { id: 'question-late', sessionId: 'session-3' } }, 20);
    assert.equal(f.turns.getRun('run-3').status, 'waiting');

    // run.finished is observed before TurnStore terminal projection in runtime/main.mjs.
    f.waits.observe({ type: 'run.finished', sessionId: 'session-3', messageId: 'run-3' }, 30);
    f.turns.finishRun('run-3', { status: 'stopped', now: 30 });
    assert.equal(f.waits.pending('run-3'), 0);
    assert.equal(f.turns.getRun('run-3').status, 'stopped');

    assert.equal(f.waits.observe({ type: 'question.resolved', sessionId: 'session-3', requestId: 'question-late' }, 40), null);
    assert.equal(f.turns.getRun('run-3').status, 'stopped');
  } finally {
    await f.close();
  }
});

test('1000 streaming deltas enter one transaction and prepare no new statements, with cache invalidation across waits and tools', async () => {
  const f = await fixture();
  try {
    const repository = f.db.sqlRepository();
    let transactions = 0, prepares = 0;
    const waits = new RunWaitProjection({
      exec: (sql) => repository.exec(sql),
      prepare(sql) { prepares++; return repository.prepare(sql); },
      transaction(callback) { transactions++; return repository.transaction(callback); },
    });
    f.turns.startRun({ runId: 'r', sessionId: 's' });
    prepares = 0;
    const stream = () => { for (let i = 0; i < 1000; i++) waits.observe({ type: 'message.delta', sessionId: 's', messageId: 'r', delta: 'x' }); };
    stream();
    assert.equal(transactions, 1);
    assert.equal(prepares, 0);
    waits.beginWait({ sessionId: 's', requestId: 'p' });
    waits.observe({ type: 'message.delta', sessionId: 's', messageId: 'r', delta: 'x' });
    assert.equal(f.turns.getRun('r').phase, 'waiting_for_user');
    waits.endWait('p');
    const before = transactions;
    stream();
    assert.equal(transactions, before + 1);
    waits.observe({ type: 'tool.started', sessionId: 's', messageId: 'r', callId: 'c', tool: 'read' });
    assert.equal(f.turns.getRun('r').phase, 'tool_running');
    waits.observe({ type: 'tool.finished', sessionId: 's', messageId: 'r', callId: 'c', tool: 'read', success: true });
    stream();
    assert.equal(f.turns.getRun('r').phase, 'streaming');
    waits.observe({ type: 'run.finished', sessionId: 's', messageId: 'r' });
    f.turns.finishRun('r', { status: 'complete' });
    stream();
    assert.equal(f.turns.getRun('r').phase, 'complete');
  } finally { await f.close(); }
});
