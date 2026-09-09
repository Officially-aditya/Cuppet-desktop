import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-d1-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try { await run(db); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

test('local search indexes titles and completed visible messages', async () => fixture(async (db) => {
  db.createProject({ id: 'project_1', name: 'Sydney', canonicalPath: '/tmp/sydney' });
  db.createSession({ id: 'session_1', projectId: 'project_1', title: 'OAuth repair' });
  db.appendMessage({ id: 'user_1', sessionId: 'session_1', role: 'user', content: 'Find the refresh token regression.' });
  db.appendMessage({ id: 'assistant_1', sessionId: 'session_1', role: 'assistant', content: '', status: 'streaming' });

  assert.equal(db.search('regression').length, 1);
  assert.equal(db.search('fixed').length, 0);

  db.updateMessage('assistant_1', { content: 'Fixed the refresh handler and added coverage.', status: 'complete' });
  const refresh = db.search('refresh');
  assert.ok(refresh.some((item) => item.itemId === 'user_1'));
  assert.ok(refresh.some((item) => item.itemId === 'assistant_1'));

  const title = db.search('OAuth');
  assert.ok(title.some((item) => item.kind === 'session' && item.sessionId === 'session_1'));
}));

test('rename, archive, restore, project rename, and delete keep search coherent', async () => fixture(async (db) => {
  db.createProject({ id: 'project_1', name: 'Old project', canonicalPath: '/tmp/project' });
  db.createSession({ id: 'session_1', projectId: 'project_1', title: 'Initial title' });
  db.appendMessage({ id: 'user_1', sessionId: 'session_1', role: 'user', content: 'Persistent searchable phrase' });

  db.renameSession('session_1', 'Renamed conversation');
  assert.ok(db.search('Renamed').some((item) => item.kind === 'session'));

  const renamedProject = db.renameProject('project_1', 'New project');
  assert.equal(renamedProject.name, 'New project');

  db.archiveSession('session_1', true);
  assert.equal(db.listSessions().length, 0);
  assert.equal(db.search('Persistent').length, 0);
  assert.ok(db.search('Persistent', { includeArchived: true }).some((item) => item.archivedAt));

  db.archiveSession('session_1', false);
  assert.equal(db.listSessions().length, 1);
  assert.ok(db.search('Persistent').length > 0);

  assert.equal(db.deleteSession('session_1'), true);
  assert.equal(db.getSessionSummary('session_1'), null);
  assert.equal(db.search('Persistent', { includeArchived: true }).length, 0);
}));

test('FTS query input is bounded and special characters fail closed to useful terms', async () => fixture(async (db) => {
  db.createSession({ id: 'session_1', title: 'Parser safety' });
  db.appendMessage({ id: 'user_1', sessionId: 'session_1', role: 'user', content: 'alpha beta gamma' });
  assert.ok(db.search('alpha OR "unterminated').some((item) => item.sessionId === 'session_1'));
  assert.deepEqual(db.search('***'), []);
}));
