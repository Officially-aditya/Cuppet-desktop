import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ACTIVE_RUN_STATUSES = new Set(['starting', 'running', 'waiting', 'settling']);
const TERMINAL_RUN_STATUSES = new Set(['complete', 'stopped', 'interrupted', 'error']);
const QUEUE_STATES = new Set(['queued', 'dispatching', 'failed']);

export class TurnStore {
  #db;

  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_session_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session_updated
        ON runs(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS queued_turns (
        queue_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        queued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queued_turns_session_state
        ON queued_turns(session_id, status, queued_at ASC, queue_id ASC);
    `);

    const now = Date.now();
    this.#db.prepare(`
      UPDATE runs
      SET status='interrupted',
          error=CASE WHEN error IS NULL OR error='' THEN 'Interrupted by runtime restart.' ELSE error END,
          updated_at=?
      WHERE status IN ('starting','running','waiting','settling')
    `).run(now);
    // A dispatching queue item may already have created its user/assistant messages.
    // Never replay it after a crash: at-most-once delivery is safer than duplicating work.
    this.#db.prepare(`
      UPDATE queued_turns
      SET status='failed',
          error='Queue dispatch was interrupted by runtime restart; item was not replayed.',
          updated_at=?
      WHERE status='dispatching'
    `).run(now);
    this.#pruneFailedQueueRows();
  }

  close() {
    this.#db.close();
  }

  startRun({ runId, sessionId, sourceSessionId = null, projectId = null, now = Date.now() }) {
    const id = requiredText(runId, 'runId');
    const session = requiredText(sessionId, 'sessionId');
    this.#db.prepare(`
      INSERT INTO runs (run_id,session_id,source_session_id,project_id,status,error,created_at,updated_at)
      VALUES (?,?,?,?, 'running', NULL, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        session_id=excluded.session_id,
        source_session_id=excluded.source_session_id,
        project_id=excluded.project_id,
        status='running',
        error=NULL,
        updated_at=excluded.updated_at
    `).run(id, session, optionalText(sourceSessionId), optionalText(projectId), now, now);
    return this.getRun(id);
  }

  finishRun(runId, { status = 'complete', error = null, now = Date.now() } = {}) {
    const id = requiredText(runId, 'runId');
    const normalizedStatus = normalizeTerminalRunStatus(status);
    const result = this.#db.prepare(`
      UPDATE runs SET status=?, error=?, updated_at=? WHERE run_id=?
    `).run(normalizedStatus, optionalText(error), now, id);
    return result.changes > 0 ? this.getRun(id) : null;
  }

  getRun(runId) {
    return this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE run_id=?
    `).get(String(runId ?? '')) ?? null;
  }

  latestRun(sessionId) {
    return this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE session_id=? ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(String(sessionId ?? '')) ?? null;
  }

  enqueue({ id, sessionId, params, queuedAt = Date.now() }) {
    const queueId = requiredText(id, 'queue id');
    const session = requiredText(sessionId, 'sessionId');
    const payload = JSON.stringify(params ?? {});
    this.#db.prepare(`
      INSERT INTO queued_turns (queue_id,session_id,params_json,status,error,queued_at,updated_at)
      VALUES (?,?,?,'queued',NULL,?,?)
    `).run(queueId, session, payload, queuedAt, queuedAt);
    return { id: queueId, sessionId: session, params: parseParams(payload), status: 'queued', queuedAt };
  }

  countQueued(sessionId) {
    return Number(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM queued_turns WHERE session_id=? AND status='queued'
    `).get(String(sessionId ?? ''))?.count ?? 0);
  }

  hasQueued(sessionId) {
    return this.countQueued(sessionId) > 0;
  }

  queuedSessions() {
    return this.#db.prepare(`
      SELECT session_id AS sessionId, MIN(queued_at) AS firstQueuedAt
      FROM queued_turns WHERE status='queued'
      GROUP BY session_id ORDER BY firstQueuedAt ASC, session_id ASC
    `).all().map((row) => String(row.sessionId));
  }

  listQueued(sessionId) {
    const rows = this.#db.prepare(`
      SELECT queue_id AS id, session_id AS sessionId, params_json AS paramsJson,
             status, error, queued_at AS queuedAt, updated_at AS updatedAt
      FROM queued_turns
      WHERE session_id=? AND status='queued'
      ORDER BY queued_at ASC, queue_id ASC
    `).all(String(sessionId ?? ''));
    return rows.map(queueRow);
  }

  claimNext(sessionId, now = Date.now()) {
    const session = requiredText(sessionId, 'sessionId');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#db.prepare(`
        SELECT queue_id AS id, session_id AS sessionId, params_json AS paramsJson,
               status, error, queued_at AS queuedAt, updated_at AS updatedAt
        FROM queued_turns
        WHERE session_id=? AND status='queued'
        ORDER BY queued_at ASC, queue_id ASC
        LIMIT 1
      `).get(session);
      if (!row) {
        this.#db.exec('COMMIT');
        return null;
      }
      this.#db.prepare(`
        UPDATE queued_turns SET status='dispatching', error=NULL, updated_at=?
        WHERE queue_id=? AND status='queued'
      `).run(now, row.id);
      this.#db.exec('COMMIT');
      return { ...queueRow(row), status: 'dispatching', updatedAt: now };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  completeQueue(queueId) {
    const result = this.#db.prepare('DELETE FROM queued_turns WHERE queue_id=?').run(String(queueId ?? ''));
    return result.changes > 0;
  }

  failQueue(queueId, error, now = Date.now()) {
    const result = this.#db.prepare(`
      UPDATE queued_turns SET status='failed', error=?, updated_at=? WHERE queue_id=?
    `).run(cleanError(error), now, String(queueId ?? ''));
    this.#pruneFailedQueueRows();
    return result.changes > 0;
  }

  #pruneFailedQueueRows(limit = 500) {
    const keep = Math.max(50, Math.min(5000, Number(limit) || 500));
    this.#db.prepare(`
      DELETE FROM queued_turns
      WHERE status='failed' AND queue_id NOT IN (
        SELECT queue_id FROM queued_turns WHERE status='failed'
        ORDER BY updated_at DESC LIMIT ?
      )
    `).run(keep);
  }
}

export function normalizeRunStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (ACTIVE_RUN_STATUSES.has(value) || TERMINAL_RUN_STATUSES.has(value)) return value;
  return 'error';
}

function normalizeTerminalRunStatus(status) {
  const value = normalizeRunStatus(status);
  return TERMINAL_RUN_STATUSES.has(value) ? value : 'error';
}

function queueRow(row) {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    params: parseParams(row.paramsJson),
    status: QUEUE_STATES.has(String(row.status)) ? String(row.status) : 'failed',
    error: optionalText(row.error),
    queuedAt: Number(row.queuedAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function parseParams(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requiredText(value, label) {
  const result = optionalText(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
}

function cleanError(error) {
  const value = error instanceof Error ? error.message : String(error ?? 'Queue dispatch failed.');
  return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 1000);
}
