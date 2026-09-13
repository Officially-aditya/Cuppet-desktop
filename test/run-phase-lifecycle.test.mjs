import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { RunStateProjection } from '../src/runtime/run-state-projection.mjs';
import { RunWaitProjection } from '../src/runtime/run-wait-projection.mjs';

test('detailed turn phase advances durably while coarse status remains compatible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-phase-'));
  const path = join(dir, 'conversations.sqlite3');
  const db = new ConversationDatabase(path);
  const repository = db.sqlRepository();
  const turns = new TurnStore(repository);
  const runs = new RunStateProjection(repository);
  const waits = new RunWaitProjection(repository);

  try {
    db.createSession({ id: 's1', now: 1 });
    db.transaction(() => {
      db.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'change it', now: 2 });
      db.appendMessage({ id: 'm1', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', now: 3 });
    });
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'starting', phase: 'preparing' });

    turns.startRun({ runId: 'm1', sessionId: 's1', now: 4 });
    assert.deepEqual(pick(runs.activeRun('s1')), { status: 'running', phase: 'provider_starting' });

    waits.observe({ type: 'message.delta', sessionId: 's1', messageId: 'm1', delta: 'h' }, 5);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'running', phase: 'streaming' });

    waits.observe({ type: 'tool.started', sessionId: 's1', messageId: 'm1', executionId: 'e1', callId: 'c1', tool: 'workspace_edit' }, 6);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'running', phase: 'tool_running' });

    waits.observe({ type: 'tool.finished', sessionId: 's1', messageId: 'm1', executionId: 'e1', callId: 'c1', tool: 'workspace_edit', success: true }, 7);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'running', phase: 'waiting_for_provider' });

    waits.observe({ type: 'permission.requested', request: { id: 'p1', sessionId: 's1' } }, 8);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'waiting', phase: 'waiting_for_user' });

    // Provider activity cannot make a waiting run appear resumed.
    waits.observe({ type: 'message.delta', sessionId: 's1', messageId: 'm1', delta: 'ignored-for-phase' }, 9);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'waiting', phase: 'waiting_for_user' });

    waits.observe({ type: 'permission.resolved', sessionId: 's1', requestId: 'p1', allowed: true }, 10);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'running', phase: 'waiting_for_provider' });

    waits.observe({ type: 'runtime.activity', sessionId: 's1', messageId: 'm1', activity: { type: 'activity.reasoning.delta', text: 'thinking' } }, 11);
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'running', phase: 'streaming' });

    db.transaction(() => db.updateMessage('m1', { status: 'complete', content: 'done', now: 12 }));
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'settling', phase: 'settling' });

    turns.finishRun('m1', { status: 'complete', now: 13 });
    assert.deepEqual(pick(turns.getRun('m1')), { status: 'complete', phase: 'complete' });
    assert.equal(runs.isActive('s1'), false);

    const events = turns.listEvents('s1');
    const phases = events
      .filter((event) => ['run.started', 'run.phase', 'run.waiting', 'run.resumed', 'run.settling', 'run.finished'].includes(event.type))
      .map((event) => event.payload.phase);
    assert.deepEqual(phases, [
      'preparing',
      'provider_starting',
      'streaming',
      'tool_running',
      'waiting_for_provider',
      'waiting_for_user',
      'waiting_for_provider',
      'streaming',
      'settling',
      'complete',
    ]);
  } finally {
    turns.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing runs schema is upgraded with a deterministic compatibility phase', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-phase-migration-'));
  const path = join(dir, 'turns.sqlite3');
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_session_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  sqlite.prepare(`INSERT INTO runs (run_id,session_id,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run('legacy-running', 's1', 'running', null, 1, 1);
  sqlite.prepare(`INSERT INTO runs (run_id,session_id,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run('legacy-waiting', 's2', 'waiting', null, 2, 2);
  sqlite.close();

  const store = new TurnStore(path);
  try {
    // Constructor restart recovery terminalizes active legacy rows, but preserves
    // the previous detailed phase in the durable recovery event.
    assert.equal(store.getRun('legacy-running').phase, 'interrupted');
    assert.equal(store.getRun('legacy-waiting').phase, 'interrupted');
    const runningRecovery = store.listEvents('s1').at(-1);
    const waitingRecovery = store.listEvents('s2').at(-1);
    assert.equal(runningRecovery.payload.previousPhase, 'streaming');
    assert.equal(waitingRecovery.payload.previousPhase, 'waiting_for_user');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function pick(run) {
  return { status: run?.status, phase: run?.phase };
}
