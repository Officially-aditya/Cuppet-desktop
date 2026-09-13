import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { RunWaitProjection, durableRuntimeProjection } from '../src/runtime/run-wait-projection.mjs';

test('tool and mutation lifecycle events are durably journaled before client publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-event-projection-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  const store = new TurnStore(db.sqlRepository());
  const projection = new RunWaitProjection(db.sqlRepository());
  try {
    db.createSession({ id: 's1', now: 1 });
    db.transaction(() => {
      db.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'change it', now: 2 });
      db.appendMessage({ id: 'm1', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', now: 3 });
    });
    store.startRun({ runId: 'm1', sessionId: 's1', now: 4 });

    projection.observe({ type: 'tool.started', sessionId: 's1', messageId: 'm1', executionId: 'tool1', callId: 'call1', tool: 'tst_edit_batch', argumentsJson: '{"secret":"must-not-be-copied"}' }, 5);
    projection.observe({ type: 'edit.batch.prepared', sessionId: 's1', batchId: 'batch1', paths: ['src/a.ts'], diffDigest: 'abc123', diff: 'sensitive full diff' }, 6);
    projection.observe({ type: 'edit.batch.applied', sessionId: 's1', batchId: 'batch1', paths: ['src/a.ts'], diffDigest: 'abc123', graphReady: true }, 7);
    projection.observe({ type: 'tool.finished', sessionId: 's1', messageId: 'm1', executionId: 'tool1', callId: 'call1', tool: 'tst_edit_batch', success: true, mutation: true, paths: ['src/a.ts'], output: 'sensitive tool output' }, 8);

    const events = store.listEvents('s1');
    assert.deepEqual(events.map((event) => event.type), [
      'run.started',
      'run.phase',
      'run.phase',
      'tool.started',
      'edit.batch.prepared',
      'edit.batch.applied',
      'run.phase',
      'tool.finished',
    ]);
    assert.deepEqual(events.filter((event) => event.type === 'run.phase').map((event) => event.payload.phase), [
      'provider_starting',
      'tool_running',
      'waiting_for_provider',
    ]);
    assert.ok(events.slice(1).every((event) => event.runId === 'm1'));
    const encoded = JSON.stringify(events);
    assert.equal(encoded.includes('must-not-be-copied'), false);
    assert.equal(encoded.includes('sensitive full diff'), false);
    assert.equal(encoded.includes('sensitive tool output'), false);
    assert.equal(events.at(-1).payload.mutation, true);
    assert.deepEqual(events.at(-1).payload.paths, ['src/a.ts']);
  } finally {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutation recovery events can be durably attached to a session without an active run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-recovery-event-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  const store = new TurnStore(db.sqlRepository());
  const projection = new RunWaitProjection(db.sqlRepository());
  try {
    db.createSession({ id: 's1', now: 1 });
    projection.observe({ type: 'mutation.recovered', sessionId: 's1', mutationId: 'mutation_x', restoredFiles: 2 }, 2);
    projection.observe({ type: 'mutation.recovery.conflict', sessionId: 's1', mutationId: 'mutation_y', path: 'src/b.ts', message: 'preserved unknown external edit' }, 3);
    const events = store.listEvents('s1');
    assert.deepEqual(events.map((event) => event.type), ['mutation.recovered', 'mutation.recovery.conflict']);
    assert.equal(events[0].runId, null);
    assert.equal(events[0].payload.restoredFiles, 2);
    assert.equal(events[1].payload.path, 'src/b.ts');
  } finally {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable event projection deliberately excludes raw prompts, tool output, and diffs', () => {
  const projected = durableRuntimeProjection({
    type: 'tool.finished', sessionId: 's1', messageId: 'm1', executionId: 'tool1', callId: 'call1', tool: 'bash',
    success: false, rejected: false, message: 'contains provider detail', output: 'SECRET OUTPUT', argumentsJson: 'SECRET ARGS',
  });
  assert.deepEqual(projected.payload, {
    executionId: 'tool1',
    callId: 'call1',
    tool: 'bash',
    status: 'error',
    success: false,
    rejected: false,
    mutation: false,
  });
});
