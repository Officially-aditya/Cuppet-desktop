import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MESSAGE_STATUSES = new Set(['complete', 'streaming', 'stopped', 'interrupted', 'error']);
const TOOL_STATUSES = new Set(['running', 'complete', 'error', 'rejected']);

export class ConversationDatabase {
  #db;
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        repository_id TEXT,
        remote_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS message_activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        source TEXT NOT NULL,
        activity_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(message_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','error','rejected')),
        permission_source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_message_activities_message_sequence ON message_activities(message_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_message_activities_session_sequence ON message_activities(session_id, message_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_session_created ON tool_executions(session_id, created_at ASC);
    `);
    this.#ensureSessionProjectColumn();
    this.#ensureSessionArchiveColumn();
    this.#ensureSessionDeletedColumn();
    this.#ensureSearchIndex();
    const now = Date.now();
    this.#db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'").run(now);
    this.#db.prepare("UPDATE tool_executions SET status = 'error', output = CASE WHEN output = '' THEN 'Interrupted by runtime restart.' ELSE output END, updated_at = ? WHERE status = 'running'").run(now);
  }
  #ensureSessionProjectColumn() {
    const columns = this.#db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some((column) => column.name === 'project_id')) {
      this.#db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL');
      this.#db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC)');
    }
  }
  #ensureSessionArchiveColumn() {
    const columns = this.#db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some((column) => column.name === 'archived_at')) {
      this.#db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER');
      this.#db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_archived_updated ON sessions(archived_at, updated_at DESC)');
    }
  }
  #ensureSessionDeletedColumn() {
    const columns = this.#db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some((column) => column.name === 'deleted_at')) {
      this.#db.exec('ALTER TABLE sessions ADD COLUMN deleted_at INTEGER');
      this.#db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at)');
    }
  }
  #ensureSearchIndex() {
    this.#db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind UNINDEXED,item_id UNINDEXED,session_id UNINDEXED,title,content,tokenize='unicode61 remove_diacritics 2')`);
    this.#rebuildSearchIndex();
  }
  #rebuildSearchIndex() {
    this.#db.exec('DELETE FROM search_index');
    const insert = this.#db.prepare('INSERT INTO search_index(kind,item_id,session_id,title,content) VALUES (?,?,?,?,?)');
    for (const session of this.#db.prepare('SELECT id,title FROM sessions').all()) insert.run('session', session.id, session.id, session.title, '');
    for (const message of this.#db.prepare("SELECT m.id,m.session_id AS sessionId,s.title,m.content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role IN ('user','assistant') AND m.status <> 'streaming'").all()) insert.run('message', message.id, message.sessionId, message.title, message.content);
  }
  #upsertSearchSession(sessionId) {
    const session = this.#db.prepare('SELECT id,title FROM sessions WHERE id=?').get(sessionId);
    this.#db.prepare("DELETE FROM search_index WHERE kind='session' AND item_id=?").run(sessionId);
    if (session) this.#db.prepare('INSERT INTO search_index(kind,item_id,session_id,title,content) VALUES (?,?,?,?,?)').run('session', session.id, session.id, session.title, '');
    this.#db.prepare('UPDATE search_index SET title=? WHERE session_id=?').run(session?.title ?? '', sessionId);
  }
  #upsertSearchMessage(messageId) {
    const message = this.#db.prepare(`SELECT m.id,m.session_id AS sessionId,m.role,m.content,m.status,s.title FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=?`).get(messageId);
    this.#db.prepare("DELETE FROM search_index WHERE kind='message' AND item_id=?").run(messageId);
    if (message && ['user','assistant'].includes(message.role) && message.status !== 'streaming') {
      this.#db.prepare('INSERT INTO search_index(kind,item_id,session_id,title,content) VALUES (?,?,?,?,?)').run('message', message.id, message.sessionId, message.title, message.content);
    }
  }
  close(){ this.#db.close(); }
  transaction(callback) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      if (result && typeof result.then === 'function') throw new Error('SQLite transaction callback must be synchronous');
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  createProject({ id, name, canonicalPath, repositoryId = null, remoteUrl = null, now = Date.now() }) {
    this.#db.prepare(`INSERT INTO projects (id,name,canonical_path,repository_id,remote_url,created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?)`).run(id,name,canonicalPath,repositoryId,remoteUrl,now,now,now);
    return this.getProject(id);
  }
  listProjects(){ return this.#db.prepare(`SELECT id,name,canonical_path AS canonicalPath,repository_id AS repositoryId,remote_url AS remoteUrl,created_at AS createdAt,updated_at AS updatedAt,last_opened_at AS lastOpenedAt FROM projects ORDER BY last_opened_at DESC,name COLLATE NOCASE`).all(); }
  getProject(id){ return this.#db.prepare(`SELECT id,name,canonical_path AS canonicalPath,repository_id AS repositoryId,remote_url AS remoteUrl,created_at AS createdAt,updated_at AS updatedAt,last_opened_at AS lastOpenedAt FROM projects WHERE id=?`).get(id) ?? null; }
  getProjectByPath(path){ return this.#db.prepare(`SELECT id,name,canonical_path AS canonicalPath,repository_id AS repositoryId,remote_url AS remoteUrl,created_at AS createdAt,updated_at AS updatedAt,last_opened_at AS lastOpenedAt FROM projects WHERE canonical_path=?`).get(path) ?? null; }
  touchProject(id, now=Date.now()){ this.#db.prepare('UPDATE projects SET last_opened_at=?,updated_at=? WHERE id=?').run(now,now,id); return this.getProject(id); }
  relocateProject(id, canonicalPath, { repositoryId = null, remoteUrl = null, now = Date.now() }={}) { this.#db.prepare('UPDATE projects SET canonical_path=?,repository_id=?,remote_url=?,updated_at=?,last_opened_at=? WHERE id=?').run(canonicalPath,repositoryId,remoteUrl,now,now,id); return this.getProject(id); }
  renameProject(id,name,now=Date.now()){ const value=String(name??'').trim().slice(0,120); if(!value) throw new Error('project name is required'); this.#db.prepare('UPDATE projects SET name=?,updated_at=? WHERE id=?').run(value,now,id); return this.getProject(id); }
  removeProject(id){ const result=this.#db.prepare('DELETE FROM projects WHERE id=?').run(id); return result.changes>0; }

  createSession({ id, title='New chat', projectId=null, now=Date.now() }) {
    if(projectId && !this.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    this.#db.prepare('INSERT INTO sessions (id,title,created_at,updated_at,project_id,archived_at,deleted_at) VALUES (?,?,?,?,?,NULL,NULL)').run(id,title,now,now,projectId);
    if(projectId) this.touchProject(projectId,now);
    this.#upsertSearchSession(id);
    return this.getSessionSummary(id);
  }
  listSessions({ projectId, archived = false }={}) {
    const clauses = [archived ? 's.archived_at IS NOT NULL' : 's.archived_at IS NULL'];
    const values = [];
    if (projectId !== undefined) { clauses.push('s.project_id IS ?'); values.push(projectId); }
    return this.#db.prepare(`SELECT s.id,s.title,s.project_id AS projectId,s.archived_at AS archivedAt,s.deleted_at AS deletedAt,s.created_at AS createdAt,s.updated_at AS updatedAt,COALESCE((SELECT status FROM messages m WHERE m.session_id=s.id AND m.role='assistant' ORDER BY m.sequence DESC LIMIT 1),'complete') AS lastStatus FROM sessions s WHERE ${clauses.join(' AND ')} ORDER BY s.updated_at DESC`).all(...values);
  }
  getSessionSummary(id){ return this.#db.prepare(`SELECT s.id,s.title,s.project_id AS projectId,s.archived_at AS archivedAt,s.deleted_at AS deletedAt,s.created_at AS createdAt,s.updated_at AS updatedAt,COALESCE((SELECT status FROM messages m WHERE m.session_id=s.id AND m.role='assistant' ORDER BY m.sequence DESC LIMIT 1),'complete') AS lastStatus FROM sessions s WHERE s.id=?`).get(id) ?? null; }
  getSession(id){ const session=this.getSessionSummary(id); if(!session) return null; const messages=this.#db.prepare(`SELECT id,session_id AS sessionId,sequence,role,content,status,created_at AS createdAt,updated_at AS updatedAt FROM messages WHERE session_id=? ORDER BY sequence`).all(id); return {...session,messages,activities:this.listMessageActivities(id),toolExecutions:this.listToolExecutions(id)}; }
  appendMessage({id,sessionId,role,content='',status='complete',now=Date.now()}){ if(!MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`); const next=this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM messages WHERE session_id=?').get(sessionId)?.sequence ?? 1; this.#db.prepare(`INSERT INTO messages (id,session_id,sequence,role,content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(id,sessionId,next,role,content,status,now,now); this.touchSession(sessionId,now); this.#upsertSearchMessage(id); return this.getMessage(id); }
  getMessage(id){ return this.#db.prepare(`SELECT id,session_id AS sessionId,sequence,role,content,status,created_at AS createdAt,updated_at AS updatedAt FROM messages WHERE id=?`).get(id) ?? null; }
  updateMessage(id,{content,status,now=Date.now()}){ if(status!==undefined&&!MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`); const current=this.getMessage(id); if(!current) throw new Error(`unknown message: ${id}`); this.#db.prepare('UPDATE messages SET content=?,status=?,updated_at=? WHERE id=?').run(content??current.content,status??current.status,now,id); this.touchSession(current.sessionId,now); const nextStatus=status??current.status; if(nextStatus!=='streaming') this.#upsertSearchMessage(id); return this.getMessage(id); }
  appendMessageContent(id,delta,now=Date.now()){ const current=this.getMessage(id); if(!current) throw new Error(`unknown message: ${id}`); return this.updateMessage(id,{content:`${current.content}${delta}`,now}); }
  appendMessageActivity({sessionId,messageId,source='provider',activity,now=Date.now()}){
    const message=this.getMessage(messageId); if(!message) throw new Error(`unknown message: ${messageId}`);
    if(message.sessionId!==sessionId) throw new Error(`message ${messageId} does not belong to session ${sessionId}`);
    const next=this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM message_activities WHERE message_id=?').get(messageId)?.sequence ?? 1;
    this.#db.prepare('INSERT INTO message_activities (session_id,message_id,sequence,source,activity_json,created_at) VALUES (?,?,?,?,?,?)').run(sessionId,messageId,next,String(source||'provider'),JSON.stringify(activity??{}),now);
    return { sessionId, messageId, sequence: next, source: String(source||'provider'), activity: activity??{}, createdAt: now };
  }
  listMessageActivities(sessionId){
    return this.#db.prepare('SELECT session_id AS sessionId,message_id AS messageId,sequence,source,activity_json AS activityJson,created_at AS createdAt FROM message_activities WHERE session_id=? ORDER BY (SELECT sequence FROM messages WHERE id=message_id) ASC,sequence ASC,id ASC').all(sessionId).map((row)=>({ ...row, activity: parseActivity(row.activityJson) })).map(({activityJson,...row})=>row);
  }
  renameSession(id,title,now=Date.now()){ const value=String(title??'').trim().slice(0,160); if(!value) throw new Error('chat title is required'); this.#db.prepare('UPDATE sessions SET title=?,updated_at=? WHERE id=?').run(value,now,id); this.#upsertSearchSession(id); return this.getSessionSummary(id); }
  archiveSession(id,archived=true,now=Date.now()){
    const session=this.getSessionSummary(id); if(!session) throw new Error(`unknown session: ${id}`);
    if(archived) this.#db.prepare('UPDATE sessions SET archived_at=?,updated_at=? WHERE id=?').run(now,now,id);
    else this.#db.prepare('UPDATE sessions SET archived_at=NULL,deleted_at=NULL,updated_at=? WHERE id=?').run(now,id);
    return this.getSessionSummary(id);
  }
  trashSession(id,now=Date.now()){
    const session=this.getSessionSummary(id); if(!session) throw new Error(`unknown session: ${id}`);
    this.#db.prepare('UPDATE sessions SET archived_at=?,deleted_at=?,updated_at=? WHERE id=?').run(now,now,now,id);
    return this.getSessionSummary(id);
  }
  listExpiredDeleted(cutoff,limit=100){ return this.#db.prepare(`SELECT id,project_id AS projectId,deleted_at AS deletedAt FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at<=? ORDER BY deleted_at ASC LIMIT ?`).all(cutoff,Math.min(Math.max(Number(limit)||100,1),500)); }
  deleteSession(id){ this.#db.prepare('DELETE FROM search_index WHERE session_id=?').run(id); const result=this.#db.prepare('DELETE FROM sessions WHERE id=?').run(id); return result.changes>0; }
  touchSession(id,now=Date.now()){ this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now,id); }
  search(query,{limit=50,includeArchived=false}={}){
    const match=ftsQuery(query); if(!match) return [];
    const archivedClause=includeArchived?'':'AND s.archived_at IS NULL';
    return this.#db.prepare(`SELECT si.kind,si.item_id AS itemId,si.session_id AS sessionId,s.title,s.project_id AS projectId,s.archived_at AS archivedAt,s.deleted_at AS deletedAt,m.sequence,m.role,snippet(search_index,4,'[',']',' … ',18) AS snippet,bm25(search_index,0,0,0,3.0,1.0) AS rank FROM search_index si JOIN sessions s ON s.id=si.session_id LEFT JOIN messages m ON si.kind='message' AND m.id=si.item_id WHERE search_index MATCH ? ${archivedClause} ORDER BY rank ASC,s.updated_at DESC LIMIT ?`).all(match,Math.min(Math.max(Number(limit)||50,1),100));
  }

  forkSession({ sourceSessionId, id, title, now = Date.now() }) {
    const source = this.getSession(sourceSessionId);
    if (!source) throw new Error(`unknown session: ${sourceSessionId}`);
    if (source.messages.some((message) => message.status === 'streaming')) throw new Error('cannot fork a session while it is generating');
    return this.transaction(() => {
      const session = this.createSession({ id, projectId: source.projectId, title: title || `${source.title || 'New chat'} (fork)`, now });
      const messageMap = {};
      for (const message of source.messages) {
        const messageId = `${id}:fork:${message.sequence}:${message.id}`;
        messageMap[message.id] = messageId;
        this.appendMessage({ id: messageId, sessionId: id, role: message.role, content: message.content, status: message.status, now });
      }
      for (const entry of source.activities ?? []) {
        const targetMessageId = messageMap[entry.messageId];
        if (!targetMessageId) continue;
        this.appendMessageActivity({ sessionId: id, messageId: targetMessageId, source: entry.source, activity: entry.activity, now: entry.createdAt ?? now });
      }
      return { session: this.getSessionSummary(session.id), sourceSessionId, messageMap };
    });
  }

  createToolExecution({ id, sessionId, callId, toolName, argumentsJson='{}', now=Date.now() }) {
    this.#db.prepare(`INSERT INTO tool_executions (id,session_id,call_id,tool_name,arguments_json,output,status,permission_source,created_at,updated_at) VALUES (?,?,?,?,?,'','running',NULL,?,?)`).run(id,sessionId,callId,toolName,argumentsJson,now,now);
    this.touchSession(sessionId,now);
    return this.getToolExecution(id);
  }
  finishToolExecution(id,{status,output='',permissionSource=null,now=Date.now()}) {
    if(!TOOL_STATUSES.has(status)||status==='running') throw new Error(`invalid terminal tool status: ${status}`);
    const current=this.getToolExecution(id); if(!current) throw new Error(`unknown tool execution: ${id}`);
    this.#db.prepare('UPDATE tool_executions SET output=?,status=?,permission_source=?,updated_at=? WHERE id=?').run(String(output),status,permissionSource,now,id);
    this.touchSession(current.sessionId,now);
    return this.getToolExecution(id);
  }
  getToolExecution(id){ return this.#db.prepare(`SELECT id,session_id AS sessionId,call_id AS callId,tool_name AS toolName,arguments_json AS argumentsJson,output,status,permission_source AS permissionSource,created_at AS createdAt,updated_at AS updatedAt FROM tool_executions WHERE id=?`).get(id) ?? null; }
  listToolExecutions(sessionId){ return this.#db.prepare(`SELECT id,session_id AS sessionId,call_id AS callId,tool_name AS toolName,arguments_json AS argumentsJson,output,status,permission_source AS permissionSource,created_at AS createdAt,updated_at AS updatedAt FROM tool_executions WHERE session_id=? ORDER BY created_at ASC,id ASC`).all(sessionId); }
}

function parseActivity(value){
  try { const parsed=JSON.parse(String(value??'{}')); return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}; }
  catch { return {}; }
}

function ftsQuery(value){
  const terms=String(value??'').normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu)?.slice(0,12)??[];
  return terms.map((term)=>`"${term.replace(/"/g,'""')}"*`).join(' AND ');
}
