import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { DATABASE_SCHEMA_VERSION, migrateDatabase } from '../src/runtime/database-migrations.mjs';

test('conversation and turn stores share ordered migrations and reopening does not rewrite schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-schema-'));
  const path = join(dir, 'db.sqlite3');
  try {
    let db = new ConversationDatabase(path);
    const sql = db.sqlRepository();
    assert.equal(sql.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
    const schemaVersion = sql.prepare('PRAGMA schema_version').get().schema_version;
    new TurnStore(sql).close();
    assert.equal(sql.prepare('PRAGMA schema_version').get().schema_version, schemaVersion);
    db.createSession({ id: 's', title: 'Preserved' });
    db.close();
    db = new ConversationDatabase(path);
    assert.equal(db.getSession('s').title, 'Preserved');
    assert.equal(db.sqlRepository().prepare('PRAGMA schema_version').get().schema_version, schemaVersion);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('both database entry points refuse newer schemas before changing the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-new-schema-'));
  const path = join(dir, 'db.sqlite3');
  try {
    let raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION + 1}; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserved');`);
    const schemaVersion = raw.prepare('PRAGMA schema_version').get().schema_version;
    raw.close();
    assert.throws(() => new ConversationDatabase(path), /newer than supported/);
    assert.throws(() => new TurnStore(path), /newer than supported/);
    raw = new DatabaseSync(path);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION + 1);
    assert.equal(raw.prepare('PRAGMA schema_version').get().schema_version, schemaVersion);
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(raw.prepare('SELECT value FROM future_data').get().value, 'preserved');
    raw.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed legacy migration rolls back all schema changes and the version together', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    // This malformed old runs table fails the second migration after conversation DDL succeeds.
    raw.exec('CREATE TABLE runs (run_id TEXT PRIMARY KEY)');
    assert.throws(() => migrateDatabase(raw), /no such column/);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(), undefined);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='runs'").get().name, 'runs');
  } finally { raw.close(); }
});
