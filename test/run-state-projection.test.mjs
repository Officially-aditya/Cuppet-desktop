import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { RunStateProjection } from '../src/runtime/run-state-projection.mjs';

test('durable run projection is the active-session authority across starting, running, settling, and terminal phases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-state-'));
  const path = join(dir, 'conversations.sqlite3');
  const db = new ConversationDatabase(path);
  const repository = db.sqlRepository();
  const store = new TurnStore(repository);
  const state = new RunStateProjection(repository);

  try {
    db.createSession({ id: 's1', now: 1 });
    db.transaction(() => {
      db.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'hello', now: 2 });
      db.appendMessage({ id: 'm1', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', now: 3 });
    });

    assert.equal(state.isActive('s1'), true);
    assert.equal(state.activeRun('s1')?.status, 'starting');

    store.startRun({ runId: 'm1', sessionId: 's1', projectId: 'p1', now: 4 });
    assert.equal(state.isActive('s1'), true);
    assert.equal(state.activeRun('s1')?.status, 'running');

    db.transaction(() => {
      db.updateMessage('m1', { status: 'complete', content: 'done', now: 5 });
    });
    assert.equal(state.isActive('s1'), true);
    assert.equal(state.activeRun('s1')?.status, 'settling');

    store.finishRun('m1', { status: 'complete', now: 6 });
    assert.equal(state.isActive('s1'), false);
    assert.equal(state.activeRun('s1'), null);
  } finally {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('run projection fails closed for missing or invalid session ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-state-'));
  const path = join(dir, 'conversations.sqlite3');
  const db = new ConversationDatabase(path);
  const store = new TurnStore(db.sqlRepository());
  const state = new RunStateProjection(db.sqlRepository());

  try {
    assert.equal(state.isActive(''), false);
    assert.equal(state.isActive(null), false);
    assert.equal(state.activeRun('missing'), null);
  } finally {
    store.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
