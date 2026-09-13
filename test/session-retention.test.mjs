import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';
import { DELETED_CHAT_RETENTION_MS, purgeSessionArtifacts } from '../src/runtime/session-retention.mjs';

test('deleted chats are hidden, restorable for seven days, and distinct from normal archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-db-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    db.createSession({ id: 'deleted', title: 'Deleted chat', now: 100 });
    db.createSession({ id: 'archived', title: 'Archived chat', now: 100 });
    db.appendMessage({ id: 'u1', sessionId: 'deleted', role: 'user', content: 'keep for recovery', now: 110 });

    const deleted = db.trashSession('deleted', 1_000);
    const archived = db.archiveSession('archived', true, 1_000);
    assert.equal(deleted.archivedAt, 1_000);
    assert.equal(deleted.deletedAt, 1_000);
    assert.equal(archived.archivedAt, 1_000);
    assert.equal(archived.deletedAt, null);
    assert.deepEqual(db.listSessions().map((session) => session.id), []);

    assert.deepEqual(db.listExpiredDeleted(999), []);
    assert.deepEqual(db.listExpiredDeleted(1_000).map((session) => session.id), ['deleted']);
    assert.equal(1_000 + DELETED_CHAT_RETENTION_MS, 604_801_000);

    const restored = db.archiveSession('deleted', false, 2_000);
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.deletedAt, null);
    assert.equal(db.getSession('deleted').messages[0].content, 'keep for recovery');
    assert.equal(db.listExpiredDeleted(Number.MAX_SAFE_INTEGER).some((session) => session.id === 'archived'), false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('final purge removes session artifacts but leaves mutation-journal deletion to its runtime owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-artifacts-'));
  const sessionId = 'session_keep_memory_drop_chat';
  const digest = createHash('sha256').update(sessionId).digest('hex');
  const projectRoot = join(dir, 'project');
  const tstRoot = join(dir, 'tst');
  const pe3Root = join(dir, 'pe3', 'project_1');
  try {
    await mkdir(join(dir, 'lossless-plans'), { recursive: true });
    await mkdir(join(dir, 'mutation-journal'), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(tstRoot, { recursive: true });
    await mkdir(pe3Root, { recursive: true });

    await writeFile(join(dir, 'lossless-plans', `${digest}.json`), '{"plan":true}\n');
    await writeFile(join(dir, 'mutation-journal', `${digest}.json`), '{"journal":true}\n');
    await writeFile(join(dir, 'cognitive-state.json'), JSON.stringify({ version: 1, orchestratorEnabled: false, backgroundPaused: false, sessionModes: { [sessionId]: 'plan', other: 'build' } }));
    await writeFile(join(pe3Root, 'pe3-task-agents.json'), JSON.stringify({
      schemaVersion: 1,
      activeSessionID: sessionId,
      agents: [
        { sessionID: sessionId, activePaths: ['generated.txt'], touchedPaths: ['generated.txt'] },
        { sessionID: 'other', activePaths: ['other.txt'], touchedPaths: [] },
      ],
      fileSignatures: { 'generated.txt': { size: 1 }, 'other.txt': { size: 2 } },
    }));
    await writeFile(join(tstRoot, 'memory.db'), 'TST MEMORY MUST STAY');
    await writeFile(join(projectRoot, 'generated.txt'), 'GENERATED CODE MUST STAY');

    const result = await purgeSessionArtifacts({ dataDir: dir, sessionId });
    assert.deepEqual(result.preserved, ['tst-memory', 'project-files']);
    assert.deepEqual(result.purged, ['lossless-plan', 'cognitive-session-state', 'pe3-task-state']);
    await assert.rejects(access(join(dir, 'lossless-plans', `${digest}.json`)));
    assert.equal(await readFile(join(dir, 'mutation-journal', `${digest}.json`), 'utf8'), '{"journal":true}\n');

    const cognitive = JSON.parse(await readFile(join(dir, 'cognitive-state.json'), 'utf8'));
    assert.equal(cognitive.sessionModes[sessionId], undefined);
    assert.equal(cognitive.sessionModes.other, 'build');

    const pe3 = JSON.parse(await readFile(join(pe3Root, 'pe3-task-agents.json'), 'utf8'));
    assert.deepEqual(pe3.agents.map((agent) => agent.sessionID), ['other']);
    assert.equal(pe3.activeSessionID, undefined);
    assert.deepEqual(Object.keys(pe3.fileSignatures), ['other.txt']);

    assert.equal(await readFile(join(tstRoot, 'memory.db'), 'utf8'), 'TST MEMORY MUST STAY');
    assert.equal(await readFile(join(projectRoot, 'generated.txt'), 'utf8'), 'GENERATED CODE MUST STAY');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session journal deletion checkpoints pending graph invalidations across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-graph-delete-'));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'mutation-journal');
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'a.txt'), 'before');
    const journal = new MutationJournal(journalDir);
    await journal.ready();
    const token = await journal.beginFile({ sessionId: 'cleanup-session', executionId: 'exec-1', tool: 'workspace_edit', projectRoot, path: 'a.txt' });
    await writeFile(join(projectRoot, 'a.txt'), 'after');
    await journal.commitFile(token);
    assert.deepEqual(await journal.graphInvalidations(projectRoot), ['a.txt']);

    const deleted = await journal.deleteSession('cleanup-session');
    assert.equal(deleted.preservedGraphInvalidations, 1);
    assert.equal((await journal.status('cleanup-session')).available, false);

    const restarted = new MutationJournal(journalDir);
    await restarted.ready();
    assert.deepEqual(await restarted.graphInvalidations(projectRoot), ['a.txt']);
    const acknowledged = await restarted.acknowledgeGraphRefresh({ projectRoot, paths: ['a.txt'] });
    assert.deepEqual(acknowledged.remaining, []);

    const restartedAgain = new MutationJournal(journalDir);
    await restartedAgain.ready();
    assert.deepEqual(await restartedAgain.graphInvalidations(projectRoot), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history compaction checkpoints evicted invalidations and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-graph-compaction-'));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'mutation-journal');
  try {
    await mkdir(projectRoot, { recursive: true });
    const journal = new MutationJournal(journalDir);
    await journal.ready();
    for (let index = 0; index < 260; index += 1) {
      await journal.recordBarrier({
        sessionId: 'compaction-session',
        executionId: `exec-${index}`,
        tool: 'bash',
        projectRoot,
        paths: [`generated/${index}.ts`],
        reason: 'compaction coverage',
      });
    }

    const restarted = new MutationJournal(journalDir);
    await restarted.ready();
    const invalidations = await restarted.graphInvalidations(projectRoot);
    assert.equal(invalidations.length, 260);
    assert.equal(invalidations.includes('generated/0.ts'), true);
    assert.equal(invalidations.includes('generated/259.ts'), true);

    const acknowledged = await restarted.acknowledgeGraphRefresh({ projectRoot, paths: invalidations });
    assert.deepEqual(acknowledged.remaining, []);
    const restartedAgain = new MutationJournal(journalDir);
    await restartedAgain.ready();
    assert.deepEqual(await restartedAgain.graphInvalidations(projectRoot), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('session deletion never truncates a graph checkpoint above two thousand paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-graph-large-checkpoint-'));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'mutation-journal');
  try {
    await mkdir(projectRoot, { recursive: true });
    const journal = new MutationJournal(journalDir);
    await journal.ready();
    const expected = [];
    for (let batch = 0; batch < 17; batch += 1) {
      const paths = [];
      for (let item = 0; item < 128; item += 1) {
        const path = `generated/${batch}-${item}.ts`;
        paths.push(path);
        expected.push(path);
      }
      await journal.recordBarrier({
        sessionId: 'large-checkpoint-session',
        executionId: `exec-${batch}`,
        tool: 'bash',
        projectRoot,
        paths,
        reason: 'large checkpoint coverage',
      });
    }
    assert.equal(expected.length, 2176);
    await journal.deleteSession('large-checkpoint-session');

    const restarted = new MutationJournal(journalDir);
    await restarted.ready();
    const invalidations = await restarted.graphInvalidations(projectRoot);
    assert.equal(invalidations.length, expected.length);
    assert.deepEqual(new Set(invalidations), new Set(expected));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed durable graph checkpoint fails closed instead of reporting a fresh graph', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-retention-graph-corrupt-checkpoint-'));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'mutation-journal');
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, '.graph-invalidations.json'), JSON.stringify({ schema: 999, projects: {} }));
    const journal = new MutationJournal(journalDir);
    await journal.ready();
    await assert.rejects(() => journal.graphInvalidations(projectRoot), /graph invalidation checkpoint/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});