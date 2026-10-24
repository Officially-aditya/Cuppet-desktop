import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './database-migrations.mjs';

const MESSAGE_STATUSES = new Set(['complete', 'streaming', 'stopped', 'interrupted', 'error']);
const TOOL_STATUSES = new Set(['running', 'complete', 'error', 'rejected']);
const SEARCH_INDEX_BATCH_SIZE = 25;
const SEARCH_INDEX_BATCH_DELAY_MS = 25;

export class ConversationDatabase {
  #db;
  #transactionDepth = 0;
  #savepointSequence = 0;
  #searchIndexTimer = null;
  #pendingContent = new Map();
  #appendContent;
  #touchStreamingSession;
  #sessionMessages;
  #activityMessage;
  #nextActivitySequence;
  #insertActivity;
  #activitySequences = new Map();
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    try { migrateDatabase(this.#db); } catch (error) { this.#db.close(); throw error; }
    this.#scheduleSearchIndex(250);
    this.#appendContent = this.#db.prepare('UPDATE messages SET content=content||?,updated_at=? WHERE id=?');
    this.#touchStreamingSession = this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=(SELECT session_id FROM messages WHERE id=?)');
    this.#sessionMessages = this.#db.prepare('SELECT id,session_id AS sessionId,sequence,role,content,attachments_json AS attachmentsJson,status,created_at AS createdAt,updated_at AS updatedAt FROM messages WHERE session_id=? ORDER BY sequence');
    this.#activityMessage = this.#db.prepare('SELECT session_id AS sessionId FROM messages WHERE id=?');
    this.#nextActivitySequence = this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM message_activities WHERE message_id=?');
    this.#insertActivity = this.#db.prepare('INSERT INTO message_activities (session_id,message_id,sequence,source,activity_json,created_at) VALUES (?,?,?,?,?,?)');
    const now = Date.now();
    this.transaction(() => {
      const interrupted = this.#db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming' RETURNING rowid").all(now);
      // A streaming row may already be behind the backfill cursor, without an index entry.
      if (interrupted.length) {
        const cursor = interrupted.reduce((min, row) => Math.min(min, row.rowid - 1), Infinity);
        this.#db.prepare("UPDATE search_index_progress SET last_rowid = MIN(last_rowid, ?) WHERE kind = 'message'").run(cursor);
      }
    });
    this.#db.prepare("UPDATE tool_executions SET status = 'error', output = CASE WHEN output = '' THEN 'Interrupted by runtime restart.' ELSE output END, updated_at = ? WHERE status = 'running'").run(now);
  }
  #scheduleSearchIndex(delay = SEARCH_INDEX_BATCH_DELAY_MS) {
    this.#searchIndexTimer = setTimeout(() => {
      this.#searchIndexTimer = null;
      try {
        if (this.#backfillSearchIndex()) this.#scheduleSearchIndex();
      } catch (error) {
        console.warn('Search index backfill will retry:', error.message);
        this.#scheduleSearchIndex(1000);
      }
    }, delay);
    this.#searchIndexTimer.unref?.();
  }
  #backfillSearchIndex() {
    return this.transaction(() => {
      const exists = this.#db.prepare('SELECT 1 FROM search_index WHERE kind=? AND item_id=? LIMIT 1');
      const insert = this.#db.prepare('INSERT INTO search_index(kind,item_id,session_id,title,content) VALUES (?,?,?,?,?)');
      const checkpoint = this.#db.prepare('UPDATE search_index_progress SET last_rowid=? WHERE kind=?');
      let more = false;
      for (const kind of ['session', 'message']) {
        const cursor = this.#db.prepare('SELECT last_rowid FROM search_index_progress WHERE kind=?').get(kind).last_rowid;
        const rows = kind === 'session'
          ? this.#db.prepare('SELECT rowid,id,id AS sessionId,title FROM sessions WHERE rowid>? ORDER BY rowid LIMIT ?').all(cursor, SEARCH_INDEX_BATCH_SIZE)
          : this.#db.prepare('SELECT m.rowid,m.id,m.session_id AS sessionId,m.role,m.status,m.content,s.title FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.rowid>? ORDER BY m.rowid LIMIT ?').all(cursor, SEARCH_INDEX_BATCH_SIZE);
        for (const row of rows) {
          if (kind === 'message' && (!['user', 'assistant'].includes(row.role) || row.status === 'streaming')) continue;
          if (!exists.get(kind, row.id)) insert.run(kind, row.id, row.sessionId, row.title, row.content ?? '');
        }
        if (rows.length) checkpoint.run(rows.at(-1).rowid, kind);
        more ||= rows.length === SEARCH_INDEX_BATCH_SIZE;
      }
      return more;
    });
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
  close(){ for (const id of this.#pendingContent.keys()) this.flushMessageContent(id); clearTimeout(this.#searchIndexTimer); this.#searchIndexTimer = null; this.#db.close(); }
  sqlRepository() {
    const owner = this;
    return Object.freeze({
      exec(sql) { return owner.#db.exec(sql); },
      prepare(sql) { return owner.#db.prepare(sql); },
      transaction(callback) { return owner.transaction(callback); },
    });
  }
  transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('SQLite transaction callback is required');
    const nested = this.#transactionDepth > 0;
    const savepoint = nested ? `cuppet_tx_${++this.#savepointSequence}` : null;
    if (nested) this.#db.exec(`SAVEPOINT ${savepoint}`);
    else this.#db.exec('BEGIN IMMEDIATE');
    this.#transactionDepth += 1;
    try {
      const result = callback();
      if (result && typeof result.then === 'function') throw new Error('SQLite transaction callback must be synchronous');
      this.#transactionDepth -= 1;
      if (nested) this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      else this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#activitySequences.clear();
      this.#transactionDepth = Math.max(0, this.#transactionDepth - 1);
      if (nested) {
        try { this.#db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch {}
        try { this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch {}
      } else {
        try { this.#db.exec('ROLLBACK'); } catch {}
      }
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
  getSessionMessages(id){ return this.#sessionMessages.all(id).map((row) => this.#pendingContent.get(row.id)?.message ?? hydrateMessage(row)); }
  getSession(id){ const session=this.getSessionSummary(id); if(!session) return null; return {...session,messages:this.getSessionMessages(id),activities:this.listMessageActivities(id),toolExecutions:this.listToolExecutions(id)}; }
  appendMessage({id,sessionId,role,content='',attachments=[],status='complete',now=Date.now()}){ if(!MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`); const next=this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM messages WHERE session_id=?').get(sessionId)?.sequence ?? 1; const attachmentsJson = Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null; this.#db.prepare(`INSERT INTO messages (id,session_id,sequence,role,content,attachments_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,sessionId,next,role,content,attachmentsJson,status,now,now); this.touchSession(sessionId,now); this.#upsertSearchMessage(id); return this.getMessage(id); }
  getMessage(id){ if (this.#pendingContent.has(id)) return { ...this.#pendingContent.get(id).message }; const row = this.#db.prepare(`SELECT id,session_id AS sessionId,sequence,role,content,attachments_json AS attachmentsJson,status,created_at AS createdAt,updated_at AS updatedAt FROM messages WHERE id=?`).get(id) ?? null; return row ? hydrateMessage(row) : null; }
  getLatestStreamingAssistantMessageId(sessionId){ return this.#db.prepare("SELECT id FROM messages WHERE session_id=? AND role='assistant' AND status='streaming' ORDER BY sequence DESC LIMIT 1").get(sessionId)?.id ?? ''; }
  updateMessage(id,{content,status,now=Date.now()}){ this.flushMessageContent(id); if(status!==undefined&&!MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`); const current=this.getMessage(id); if(!current) throw new Error(`unknown message: ${id}`); this.#db.prepare('UPDATE messages SET content=?,status=?,updated_at=? WHERE id=?').run(content??current.content,status??current.status,now,id); this.touchSession(current.sessionId,now); const nextStatus=status??current.status; if(nextStatus!=='streaming') { this.#activitySequences.delete(id); this.#upsertSearchMessage(id); } return this.getMessage(id); }
  appendMessageContent(id, delta, now = Date.now()) {
    let pending = this.#pendingContent.get(id);
    if (pending?.error) throw pending.error;
    if (!pending) {
      const message = this.getMessage(id);
      if (!message) throw new Error(`unknown message: ${id}`);
      if (message.status !== 'streaming') return this.updateMessage(id, { content: message.content + delta, now });
      pending = { message, delta: '', timer: null, error: null };
      this.#pendingContent.set(id, pending);
    }
    const firstText = pending.message.content.length === 0;
    pending.delta += delta;
    pending.message = { ...pending.message, content: pending.message.content + delta, updatedAt: now };
    if (firstText) this.flushMessageContent(id);
    else if (!pending.timer) {
      pending.timer = setTimeout(() => {
        pending.timer = null;
        try { this.flushMessageContent(id); } catch (error) { pending.error = error; }
      }, 250);
      pending.timer.unref?.();
    }
    return pending.message;
  }
  flushMessageContent(id) {
    const pending = this.#pendingContent.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.transaction(() => {
      this.#appendContent.run(pending.delta, pending.message.updatedAt, id);
      this.#touchStreamingSession.run(pending.message.updatedAt, id);
    });
    this.#pendingContent.delete(id);
  }
  appendMessageActivity({sessionId,messageId,source='provider',activity,now=Date.now()}){
    const message=this.#activityMessage.get(messageId); if(!message) throw new Error(`unknown message: ${messageId}`);
    if(message.sessionId!==sessionId) throw new Error(`message ${messageId} does not belong to session ${sessionId}`);
    const next=this.#activitySequences.get(messageId) ?? this.#nextActivitySequence.get(messageId).sequence;
    this.#insertActivity.run(sessionId,messageId,next,String(source||'provider'),JSON.stringify(activity??{}),now);
    this.#activitySequences.set(messageId, next + 1);
    return { sessionId, messageId, sequence: next, source: String(source||'provider'), activity: activity??{}, createdAt: now };
  }
  listMessageActivities(sessionId, { messageIds, limit } = {}){
    if (Array.isArray(messageIds) && !messageIds.length) return [];
    const filter = Array.isArray(messageIds) ? ` AND a.message_id IN (${messageIds.map(() => '?').join(',')})` : '';
    const bounded = Number.isSafeInteger(limit) && limit >= 0;
    return this.#db.prepare(`SELECT a.session_id AS sessionId,a.message_id AS messageId,a.sequence,a.source,a.activity_json AS activityJson,a.created_at AS createdAt FROM message_activities a JOIN messages m ON m.id=a.message_id WHERE a.session_id=?${filter} ORDER BY m.sequence ASC,a.sequence ASC,a.id ASC${bounded ? ' LIMIT ?' : ''}`).all(sessionId, ...(messageIds ?? []), ...(bounded ? [limit] : [])).map((row)=>({ ...row, activity: parseActivity(row.activityJson) })).map(({activityJson,...row})=>row);
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
  deleteSession(id){ this.#activitySequences.clear(); this.#db.prepare('DELETE FROM search_index WHERE session_id=?').run(id); const result=this.#db.prepare('DELETE FROM sessions WHERE id=?').run(id); return result.changes>0; }
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

  createToolExecution({ id, sessionId, messageId=null, callId, toolName, argumentsJson='{}', now=Date.now() }) {
    this.#db.prepare(`INSERT INTO tool_executions (id,session_id,message_id,call_id,tool_name,arguments_json,output,status,permission_source,created_at,updated_at) VALUES (?,?,?,?,?,?,'','running',NULL,?,?)`).run(id,sessionId,messageId,callId,toolName,argumentsJson,now,now);
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
  getToolExecution(id){ return this.#db.prepare(`SELECT id,session_id AS sessionId,message_id AS messageId,call_id AS callId,tool_name AS toolName,arguments_json AS argumentsJson,output,status,permission_source AS permissionSource,created_at AS createdAt,updated_at AS updatedAt FROM tool_executions WHERE id=?`).get(id) ?? null; }
  listToolExecutions(sessionId){ return this.#db.prepare(`SELECT id,session_id AS sessionId,message_id AS messageId,call_id AS callId,tool_name AS toolName,arguments_json AS argumentsJson,output,status,permission_source AS permissionSource,created_at AS createdAt,updated_at AS updatedAt FROM tool_executions WHERE session_id=? ORDER BY created_at ASC,id ASC`).all(sessionId); }
  listMessageToolExecutions(sessionId, messageId) {
    const message = this.getMessage(messageId);
    if (!message || message.sessionId !== sessionId) return [];
    const select = 'SELECT id,session_id AS sessionId,message_id AS messageId,call_id AS callId,tool_name AS toolName,arguments_json AS argumentsJson,output,status,permission_source AS permissionSource,created_at AS createdAt,updated_at AS updatedAt FROM tool_executions';
    const exact = this.#db.prepare(`${select} WHERE session_id=? AND message_id=? ORDER BY created_at ASC,id ASC`).all(sessionId, messageId);
    if (exact.length) return exact;
    // Executions recorded before message association existed are attributed by
    // the message's lifetime. New rows always carry an exact message_id.
    const start = Number(message.createdAt) || 0;
    const end = Number(message.updatedAt) || start;
    if (end <= start) return [];
    return this.#db.prepare(`${select} WHERE session_id=? AND message_id IS NULL AND created_at>=? AND created_at<? ORDER BY created_at ASC,id ASC`)
      .all(sessionId, start, end);
  }
}

function parseActivity(value){
  try { const parsed=JSON.parse(String(value??'{}')); return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}; }
  catch { return {}; }
}

function ftsQuery(value){
  const terms=String(value??'').normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu)?.slice(0,12)??[];
  return terms.map((term)=>`"${term.replace(/"/g,'""')}"*`).join(' AND ');
}

function hydrateMessage(row) {
  if (!row) return null;
  const { attachmentsJson, ...rest } = row;
  if (!attachmentsJson) return rest;
  try {
    const parsed = JSON.parse(attachmentsJson);
    return { ...rest, ...(Array.isArray(parsed) && parsed.length ? { attachments: parsed } : {}) };
  } catch {
    return rest;
  }
}

