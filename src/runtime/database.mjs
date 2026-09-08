import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MESSAGE_STATUSES = new Set(['complete', 'streaming', 'stopped', 'interrupted', 'error']);

export class ConversationDatabase {
  #db;

  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence ASC);
    `);

    const now = Date.now();
    this.#db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'")
      .run(now);
  }

  close() {
    this.#db.close();
  }

  createSession({ id, title = 'New chat', now = Date.now() }) {
    this.#db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return this.getSessionSummary(id);
  }

  listSessions() {
    return this.#db.prepare(`
      SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
             COALESCE((SELECT status FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant' ORDER BY m.sequence DESC LIMIT 1), 'complete') AS lastStatus
      FROM sessions s
      ORDER BY s.updated_at DESC
    `).all();
  }

  getSessionSummary(id) {
    return this.#db.prepare(`
      SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
             COALESCE((SELECT status FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant' ORDER BY m.sequence DESC LIMIT 1), 'complete') AS lastStatus
      FROM sessions s
      WHERE s.id = ?
    `).get(id) ?? null;
  }

  getSession(id) {
    const session = this.getSessionSummary(id);
    if (!session) return null;
    const messages = this.#db.prepare(`
      SELECT id, session_id AS sessionId, sequence, role, content, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM messages
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(id);
    return { ...session, messages };
  }

  appendMessage({ id, sessionId, role, content = '', status = 'complete', now = Date.now() }) {
    if (!MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`);
    const next = this.#db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE session_id = ?')
      .get(sessionId)?.sequence ?? 1;
    this.#db.prepare(`
      INSERT INTO messages (id, session_id, sequence, role, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, next, role, content, status, now, now);
    this.touchSession(sessionId, now);
    return this.getMessage(id);
  }

  getMessage(id) {
    return this.#db.prepare(`
      SELECT id, session_id AS sessionId, sequence, role, content, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM messages WHERE id = ?
    `).get(id) ?? null;
  }

  updateMessage(id, { content, status, now = Date.now() }) {
    if (status !== undefined && !MESSAGE_STATUSES.has(status)) throw new Error(`invalid message status: ${status}`);
    const current = this.getMessage(id);
    if (!current) throw new Error(`unknown message: ${id}`);
    const nextContent = content ?? current.content;
    const nextStatus = status ?? current.status;
    this.#db.prepare('UPDATE messages SET content = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(nextContent, nextStatus, now, id);
    this.touchSession(current.sessionId, now);
    return this.getMessage(id);
  }

  appendMessageContent(id, delta, now = Date.now()) {
    const current = this.getMessage(id);
    if (!current) throw new Error(`unknown message: ${id}`);
    return this.updateMessage(id, { content: `${current.content}${delta}`, now });
  }

  renameSession(id, title, now = Date.now()) {
    this.#db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    return this.getSessionSummary(id);
  }

  touchSession(id, now = Date.now()) {
    this.#db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, id);
  }
}
