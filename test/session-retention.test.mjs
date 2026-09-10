import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
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

test('final purge removes session artifacts but preserves TST memory and generated project files', async () => {
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
    await assert.rejects(access(join(dir, 'lossless-plans', `${digest}.json`)));
    await assert.rejects(access(join(dir, 'mutation-journal', `${digest}.json`)));

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
