import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { durableRuntimeEvent, persistDurableRuntimeEvent } from '../src/runtime/runtime-event-durability.mjs';

test('durable mutation event mapper keeps metadata and drops content-bearing fields', () => {
  const event = durableRuntimeEvent({
    type: 'edit.batch.prepared',
    sessionId: 's1',
    batchId: 'batch_1',
    paths: ['src/a.ts', 'src/a.ts', 'src/b.ts'],
    diffDigest: 'a'.repeat(64),
    diff: 'SECRET DIFF CONTENT',
    argumentsJson: '{"token":"SECRET"}',
    apiKey: 'SECRET',
  });

  assert.deepEqual(event, {
    sessionId: 's1',
    type: 'edit.batch.prepared',
    payload: {
      batchId: 'batch_1',
      paths: ['src/a.ts', 'src/b.ts'],
      diffDigest: 'a'.repeat(64),
    },
  });
  assert.equal(JSON.stringify(event).includes('SECRET'), false);
});

test('durable mutation event mapper redacts bearer credentials from recovery diagnostics', () => {
  const event = durableRuntimeEvent({
    type: 'mutation.recovery.conflict',
    sessionId: 's1',
    mutationId: 'mutation_1',
    path: 'src/a.ts',
    message: 'failed with Bearer top.secret-token',
  });

  assert.equal(event.payload.message, 'failed with Bearer [redacted]');
});

test('unapproved runtime events are not persisted through the mutation durability boundary', () => {
  assert.equal(durableRuntimeEvent({ type: 'message.delta', sessionId: 's1', delta: 'private response text' }), null);
  assert.equal(durableRuntimeEvent({ type: 'tool.started', sessionId: 's1', argumentsJson: '{"secret":true}' }), null);
  assert.equal(durableRuntimeEvent({ type: 'edit.batch.applied', sessionId: '' }), null);
});

test('TurnStore records whitelisted mutation metadata in canonical per-session sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-event-durability-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  const store = new TurnStore(db.sqlRepository());
  try {
    db.createSession({ id: 's1' });
    persistDurableRuntimeEvent({
      type: 'mutation.recovered',
      sessionId: 's1',
      mutationId: 'mutation_1',
      restoredFiles: 2,
    }, store);
    persistDurableRuntimeEvent({
      type: 'mutation.undone',
      sessionId: 's1',
      mutationId: 'mutation_2',
      projectId: 'p1',
      tool: 'workspace_edit',
      paths: ['src/a.ts'],
    }, store);

    const events = store.listEvents('s1');
    assert.deepEqual(events.map((event) => [event.sequence, event.type]), [
      [1, 'mutation.recovered'],
      [2, 'mutation.undone'],
    ]);
    assert.deepEqual(events[0].payload, { mutationId: 'mutation_1', restoredFiles: 2 });
    assert.deepEqual(events[1].payload, { mutationId: 'mutation_2', projectId: 'p1', tool: 'workspace_edit', paths: ['src/a.ts'] });
  } finally {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
