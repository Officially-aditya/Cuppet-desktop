import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConversationDatabase } from '../src/runtime/database.mjs';

test('Phase 1 database upgrades in place without losing chats', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-migrate-')); const path=join(dir,'db.sqlite3');
  const old=new DatabaseSync(path); old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'complete',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(session_id,sequence));`); old.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('old','Old chat',1,1); old.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run('msg','old',1,'user','preserve me','complete',1,1); old.close();
  const db=new ConversationDatabase(path); try { const restored=db.getSession('old'); assert.equal(restored.projectId,null); assert.equal(restored.messages[0].content,'preserve me'); db.createProject({id:'p',name:'Project',canonicalPath:join(dir,'repo')}); const fresh=db.createSession({id:'new',projectId:'p'}); assert.equal(fresh.projectId,'p'); } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});
