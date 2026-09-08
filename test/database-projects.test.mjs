import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';

test('sessions remain isolated by stable project binding and project removal preserves transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-db-projects-'));
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  try {
    db.createProject({ id: 'p1', name: 'One', canonicalPath: join(dir, 'one') });
    db.createProject({ id: 'p2', name: 'Two', canonicalPath: join(dir, 'two') });
    const a = db.createSession({ id: 'a', projectId: 'p1' });
    const b = db.createSession({ id: 'b', projectId: 'p2' });
    const general = db.createSession({ id: 'g' });
    db.appendMessage({ id: 'm1', sessionId: a.id, role: 'user', content: 'alpha' });
    db.appendMessage({ id: 'm2', sessionId: b.id, role: 'user', content: 'beta' });
    assert.deepEqual(db.listSessions({ projectId: 'p1' }).map((s) => s.id), ['a']);
    assert.deepEqual(db.listSessions({ projectId: 'p2' }).map((s) => s.id), ['b']);
    assert.deepEqual(db.listSessions({ projectId: null }).map((s) => s.id), ['g']);
    assert.equal(db.removeProject('p1'), true);
    const restored = db.getSession('a');
    assert.equal(restored.projectId, null);
    assert.equal(restored.messages[0].content, 'alpha');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
