import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';

async function fixture(t, run) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-search-backfill-'));
  const path = join(dir, 'conversations.sqlite3');
  let db = new ConversationDatabase(path);
  const reopen = () => { db.close(); db = new ConversationDatabase(path); return db; };
  try { await run({ db, reopen, tick: (ms) => t.mock.timers.tick(ms) }); }
  finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

const count = (db) => db.sqlRepository().prepare('SELECT COUNT(*) AS count FROM search_index').get().count;

test('startup keeps the existing index intact, including after background checks', async (t) => fixture(t, async ({ db, reopen, tick }) => {
  db.createSession({ id: 's1', title: 'Existing title' });
  db.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'Searchable history' });
  db.sqlRepository().prepare("UPDATE search_index SET rowid=100000 WHERE item_id='u1'").run();
  db = reopen();
  const rowid = () => db.sqlRepository().prepare("SELECT rowid FROM search_index WHERE item_id='u1'").get().rowid;
  assert.equal(rowid(), 100000, 'opening the database must not rebuild the index');
  assert.equal(db.search('history')[0].itemId, 'u1', 'old results are immediately usable');
  tick(250);
  assert.equal(rowid(), 100000, 'backfill must skip entries already indexed');
  assert.equal(count(db), 2);
}));

test('missing history is indexed in bounded batches and resumes its checkpoint after restart', async (t) => fixture(t, async ({ db, reopen, tick }) => {
  db.createSession({ id: 's1', title: 'Legacy conversation' });
  for (let n = 0; n < 80; n++) db.appendMessage({ id: `u${n}`, sessionId: 's1', role: 'user', content: `Legacy needle ${n}` });
  db.sqlRepository().exec('DELETE FROM search_index');
  db = reopen();
  assert.equal(count(db), 0, 'startup must not scan and reindex historical content');
  db.appendMessage({ id: 'fresh', sessionId: 's1', role: 'user', content: 'Fresh immediately searchable message' });
  assert.equal(db.search('immediately')[0].itemId, 'fresh');
  tick(249);
  assert.equal(count(db), 1);
  tick(1);
  assert.equal(count(db), 27, 'one session and 25 historical messages are added per batch');
  assert.equal(db.sqlRepository().prepare("SELECT last_rowid FROM search_index_progress WHERE kind='message'").get().last_rowid, 25);

  // Edits ahead of the cursor must remain current and must not be duplicated.
  db.renameSession('s1', 'Updated conversation');
  db.updateMessage('u60', { content: 'Revised content' });
  db = reopen();
  assert.equal(count(db), 28, 'restart must preserve the partial index');
  tick(250);
  assert.equal(db.sqlRepository().prepare("SELECT last_rowid FROM search_index_progress WHERE kind='message'").get().last_rowid, 50);
  tick(25);
  tick(25);
  assert.equal(count(db), 82);
  assert.equal(db.search('Revised')[0].itemId, 'u60');
  assert.equal(db.search('Revised')[0].title, 'Updated conversation');
  assert.deepEqual(db.sqlRepository().prepare('SELECT kind,item_id,COUNT(*) AS count FROM search_index GROUP BY kind,item_id HAVING COUNT(*)>1').all(), []);
  tick(500);
  assert.equal(count(db), 82);
}));

test('backfill respects deletion and streaming, and indexes interrupted replies behind the cursor', async (t) => fixture(t, async ({ db, reopen, tick }) => {
  db.createSession({ id: 'deleted', title: 'Deleted chat' });
  db.appendMessage({ id: 'removed', sessionId: 'deleted', role: 'user', content: 'Removed history' });
  db.createSession({ id: 'kept', title: 'Kept chat' });
  db.appendMessage({ id: 'system', sessionId: 'kept', role: 'system', content: 'Private system message' });
  db.appendMessage({ id: 'stream', sessionId: 'kept', role: 'assistant', status: 'streaming', content: 'Recoverable response' });
  db.sqlRepository().exec('DELETE FROM search_index');
  db.deleteSession('deleted');
  tick(250);
  assert.equal(count(db), 1, 'only the kept session is indexed while the reply streams');
  assert.equal(db.search('Recoverable').length, 0);
  db = reopen();
  assert.equal(db.getMessage('stream').status, 'interrupted');
  assert.equal(db.search('Recoverable').length, 0, 'recovery indexing is also deferred');
  tick(250);
  assert.equal(db.search('Recoverable')[0].itemId, 'stream');
  assert.equal(db.search('Private').length, 0);
  assert.equal(db.search('Removed').length, 0);
  db = reopen();
  tick(250);
  assert.equal(count(db), 2);
}));
