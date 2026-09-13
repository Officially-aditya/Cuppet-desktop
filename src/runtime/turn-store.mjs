import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeRunPhase, phaseFromRunStatus } from './run-phase.mjs';

const ACTIVE_RUN_STATUSES = new Set(['starting', 'running', 'waiting', 'settling']);
const TERMINAL_RUN_STATUSES = new Set(['complete', 'stopped', 'interrupted', 'error']);
const QUEUE_STATES = new Set(['queued', 'dispatching', 'failed']);
const EVENT_SCHEMA_VERSION = 1;
const LEGACY_MIGRATION_ID = 'turn-state-v1-to-shared-db';

export class TurnStore {
  #db;
  #ownedDatabase = null;

  constructor(source, { legacyPath = null } = {}) {
    if (typeof source === 'string') {
      mkdirSync(dirname(source), { recursive: true });
      const sqlite = new DatabaseSync(source);
      sqlite.exec('PRAGMA journal_mode = WAL;');
      this.#ownedDatabase = sqlite;
      this.#db = sqliteRepository(sqlite);
    } else {
      this.#db = requireSqlRepository(source);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_session_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL,
        phase TEXT,
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

      CREATE TABLE IF NOT EXISTS runtime_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        queue_id TEXT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_events_session_sequence
        ON runtime_events(session_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS runtime_store_migrations (
        id TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL
      );
    `);

    this.#ensureRunPhaseColumn();
    this.#installConversationProjectionTriggers();
    if (legacyPath) this.#migrateLegacyFile(legacyPath);
    this.#recoverInterruptedState(Date.now());
  }

  close() {
    this.#ownedDatabase?.close();
    this.#ownedDatabase = null;
  }

  startRun({ runId, sessionId, sourceSessionId = null, projectId = null, now = Date.now() }) {
    const id = requiredText(runId, 'runId');
    const session = requiredText(sessionId, 'sessionId');
    return this.#transaction(() => {
      const existing = this.getRun(id);
      if (existing) {
        if (existing.sessionId !== session) throw new Error(`runId ${id} already belongs to session ${existing.sessionId}`);
        // On the shared conversation database, the assistant-message INSERT trigger creates
        // the run in `starting/preparing` inside the same transaction as the durable transcript row.
        // The runtime callback only enriches that already-durable identity and advances it.
        if (existing.status === 'starting') {
          this.#db.prepare(`
            UPDATE runs
            SET source_session_id=?, project_id=?, status='running', phase='provider_starting', error=NULL, updated_at=?
            WHERE run_id=? AND status='starting'
          `).run(optionalText(sourceSessionId), optionalText(projectId), now, id);
          this.#appendEvent({
            sessionId: session,
            runId: id,
            type: 'run.phase',
            payload: { status: 'running', phase: 'provider_starting', previousPhase: existing.phase },
            createdAt: now,
          });
          return this.getRun(id);
        }
        return existing;
      }
      this.#db.prepare(`
        INSERT INTO runs (run_id,session_id,source_session_id,project_id,status,phase,error,created_at,updated_at)
        VALUES (?,?,?,?, 'running', 'provider_starting', NULL, ?, ?)
      `).run(id, session, optionalText(sourceSessionId), optionalText(projectId), now, now);
      this.#appendEvent({
        sessionId: session,
        runId: id,
        type: 'run.started',
        payload: { status: 'running', phase: 'provider_starting', sourceSessionId: optionalText(sourceSessionId), projectId: optionalText(projectId) },
        createdAt: now,
      });
      return this.getRun(id);
    });
  }

  finishRun(runId, { status = 'complete', error = null, now = Date.now() } = {}) {
    const id = requiredText(runId, 'runId');
    const normalizedStatus = normalizeTerminalRunStatus(status);
    return this.#transaction(() => {
      const current = this.getRun(id);
      if (!current) return null;
      if (TERMINAL_RUN_STATUSES.has(current.status)) return current;
      const normalizedError = optionalText(error);
      this.#db.prepare(`
        UPDATE runs SET status=?, phase=?, error=?, updated_at=? WHERE run_id=?
      `).run(normalizedStatus, normalizedStatus, normalizedError, now, id);
      this.#appendEvent({
        sessionId: current.sessionId,
        runId: id,
        type: 'run.finished',
        payload: { status: normalizedStatus, phase: normalizedStatus, error: normalizedError },
        createdAt: now,
      });
      return this.getRun(id);
    });
  }

  getRun(runId) {
    const row = this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, phase, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE run_id=?
    `).get(String(runId ?? ''));
    return row ? runRow(row) : null;
  }

  latestRun(sessionId) {
    const row = this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, phase, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE session_id=? ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(String(sessionId ?? ''));
    return row ? runRow(row) : null;
  }

  enqueue({ id, sessionId, params, queuedAt = Date.now() }) {
    const queueId = requiredText(id, 'queue id');
    const session = requiredText(sessionId, 'sessionId');
    const payload = JSON.stringify(params ?? {});
    return this.#transaction(() => {
      this.#db.prepare(`
        INSERT INTO queued_turns (queue_id,session_id,params_json,status,error,queued_at,updated_at)
        VALUES (?,?,?,'queued',NULL,?,?)
      `).run(queueId, session, payload, queuedAt, queuedAt);
      this.#appendEvent({
        sessionId: session,
        queueId,
        type: 'queue.queued',
        payload: { status: 'queued', queuedAt },
        createdAt: queuedAt,
      });
      return { id: queueId, sessionId: session, params: parseParams(payload), status: 'queued', queuedAt };
    });
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

  listEvents(sessionId, { afterSequence = 0, limit = 200 } = {}) {
    const session = requiredText(sessionId, 'sessionId');
    const after = Math.max(0, Number.isFinite(Number(afterSequence)) ? Math.trunc(Number(afterSequence)) : 0);
    const boundedLimit = Math.max(1, Math.min(1000, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 200));
    return this.#db.prepare(`
      SELECT event_id AS eventId, session_id AS sessionId, run_id AS runId, queue_id AS queueId,
             sequence, type, payload_json AS payloadJson, schema_version AS schemaVersion,
             created_at AS createdAt
      FROM runtime_events
      WHERE session_id=? AND sequence>?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(session, after, boundedLimit).map(eventRow);
  }

  recordEvent({ sessionId, runId = null, queueId = null, type, payload = {}, createdAt = Date.now() }) {
    return this.#transaction(() => this.#appendEvent({ sessionId, runId, queueId, type, payload, createdAt }));
  }

  claimNext(sessionId, now = Date.now()) {
    const session = requiredText(sessionId, 'sessionId');
    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT queue_id AS id, session_id AS sessionId, params_json AS paramsJson,
               status, error, queued_at AS queuedAt, updated_at AS updatedAt
        FROM queued_turns
        WHERE session_id=? AND status='queued'
        ORDER BY queued_at ASC, queue_id ASC
        LIMIT 1
      `).get(session);
      if (!row) return null;
      const result = this.#db.prepare(`
        UPDATE queued_turns SET status='dispatching', error=NULL, updated_at=?
        WHERE queue_id=? AND status='queued'
      `).run(now, row.id);
      if (result.changes === 0) return null;
      this.#appendEvent({
        sessionId: session,
        queueId: String(row.id),
        type: 'queue.started',
        payload: { status: 'dispatching', queuedAt: Number(row.queuedAt) || 0 },
        createdAt: now,
      });
      return { ...queueRow(row), status: 'dispatching', updatedAt: now };
    });
  }

  completeQueue(queueId, now = Date.now()) {
    const id = requiredText(queueId, 'queue id');
    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT queue_id AS id, session_id AS sessionId, queued_at AS queuedAt
        FROM queued_turns WHERE queue_id=?
      `).get(id);
      if (!row) return false;
      const result = this.#db.prepare('DELETE FROM queued_turns WHERE queue_id=?').run(id);
      if (result.changes === 0) return false;
      this.#appendEvent({
        sessionId: String(row.sessionId),
        queueId: id,
        type: 'queue.dispatched',
        payload: { status: 'dispatched', queuedAt: Number(row.queuedAt) || 0 },
        createdAt: now,
      });
      return true;
    });
  }

  failQueue(queueId, error, now = Date.now()) {
    const id = requiredText(queueId, 'queue id');
    const message = cleanError(error);
    return this.#transaction(() => {
      const row = this.#db.prepare(`
        SELECT queue_id AS id, session_id AS sessionId, queued_at AS queuedAt
        FROM queued_turns WHERE queue_id=?
      `).get(id);
      if (!row) return false;
      const result = this.#db.prepare(`
        UPDATE queued_turns SET status='failed', error=?, updated_at=? WHERE queue_id=?
      `).run(message, now, id);
      if (result.changes === 0) return false;
      this.#appendEvent({
        sessionId: String(row.sessionId),
        queueId: id,
        type: 'queue.failed',
        payload: { status: 'failed', error: message, queuedAt: Number(row.queuedAt) || 0 },
        createdAt: now,
      });
      this.#pruneFailedQueueRows();
      return true;
    });
  }

  #ensureRunPhaseColumn() {
    const columns = this.#db.prepare('PRAGMA table_info(runs)').all();
    if (!columns.some((column) => column.name === 'phase')) this.#db.exec('ALTER TABLE runs ADD COLUMN phase TEXT');
    this.#db.prepare(`
      UPDATE runs
      SET phase=CASE status
        WHEN 'starting' THEN 'preparing'
        WHEN 'running' THEN 'streaming'
        WHEN 'waiting' THEN 'waiting_for_user'
        WHEN 'settling' THEN 'settling'
        WHEN 'complete' THEN 'complete'
        WHEN 'stopped' THEN 'stopped'
        WHEN 'interrupted' THEN 'interrupted'
        ELSE 'error'
      END
      WHERE phase IS NULL OR TRIM(phase)=''
    `).run();
  }

  #installConversationProjectionTriggers() {
    const hasMessages = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    if (!hasMessages) return;
    // Recreate these projection-only triggers so schema upgrades are applied to
    // existing databases as well as clean installs. Provider/TST side effects stay
    // out of SQLite, while message + run transitions remain one transaction.
    this.#db.exec(`
      DROP TRIGGER IF EXISTS cuppet_run_start_from_assistant_message;
      DROP TRIGGER IF EXISTS cuppet_run_settling_from_assistant_message;

      CREATE TRIGGER cuppet_run_start_from_assistant_message
      AFTER INSERT ON messages
      WHEN NEW.role='assistant'
        AND NEW.status='streaming'
        AND NOT EXISTS (SELECT 1 FROM runs WHERE run_id=NEW.id)
      BEGIN
        INSERT INTO runs (
          run_id,session_id,source_session_id,project_id,status,phase,error,created_at,updated_at
        ) VALUES (
          NEW.id,
          NEW.session_id,
          NULL,
          (SELECT project_id FROM sessions WHERE id=NEW.session_id),
          'starting',
          'preparing',
          NULL,
          NEW.created_at,
          NEW.updated_at
        );
        INSERT INTO runtime_events (
          session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
        ) VALUES (
          NEW.session_id,
          NEW.id,
          NULL,
          (SELECT COALESCE(MAX(sequence),0)+1 FROM runtime_events WHERE session_id=NEW.session_id),
          'run.started',
          '{"status":"starting","phase":"preparing","source":"assistant_message"}',
          ${EVENT_SCHEMA_VERSION},
          NEW.created_at
        );
      END;

      CREATE TRIGGER cuppet_run_settling_from_assistant_message
      AFTER UPDATE OF status ON messages
      WHEN OLD.role='assistant'
        AND OLD.status='streaming'
        AND NEW.status IN ('complete','stopped','interrupted','error')
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE run_id=NEW.id AND status IN ('starting','running','waiting')
        )
      BEGIN
        UPDATE runs
        SET status='settling', phase='settling', updated_at=NEW.updated_at
        WHERE run_id=NEW.id AND status IN ('starting','running','waiting');
        INSERT INTO runtime_events (
          session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
        ) VALUES (
          NEW.session_id,
          NEW.id,
          NULL,
          (SELECT COALESCE(MAX(sequence),0)+1 FROM runtime_events WHERE session_id=NEW.session_id),
          'run.settling',
          '{"status":"settling","phase":"settling","messageStatus":"' || NEW.status || '"}',
          ${EVENT_SCHEMA_VERSION},
          NEW.updated_at
        );
      END;
    `);
  }

  #migrateLegacyFile(path) {
    if (this.#db.prepare('SELECT 1 FROM runtime_store_migrations WHERE id=?').get(LEGACY_MIGRATION_ID)) return;
    if (!existsSync(path)) {
      this.#transaction(() => this.#db.prepare('INSERT INTO runtime_store_migrations (id,migrated_at) VALUES (?,?)').run(LEGACY_MIGRATION_ID, Date.now()));
      return;
    }

    let legacy = null;
    try {
      legacy = new DatabaseSync(path);
      const runs = tableExists(legacy, 'runs') ? legacy.prepare(`SELECT run_id AS runId,session_id AS sessionId,source_session_id AS sourceSessionId,project_id AS projectId,status,error,created_at AS createdAt,updated_at AS updatedAt FROM runs`).all() : [];
      const queued = tableExists(legacy, 'queued_turns') ? legacy.prepare(`SELECT queue_id AS queueId,session_id AS sessionId,params_json AS paramsJson,status,error,queued_at AS queuedAt,updated_at AS updatedAt FROM queued_turns`).all() : [];
      const events = tableExists(legacy, 'runtime_events') ? legacy.prepare(`SELECT session_id AS sessionId,run_id AS runId,queue_id AS queueId,sequence,type,payload_json AS payloadJson,schema_version AS schemaVersion,created_at AS createdAt FROM runtime_events ORDER BY session_id,sequence`).all() : [];
      this.#transaction(() => {
        const insertRun = this.#db.prepare(`INSERT OR IGNORE INTO runs (run_id,session_id,source_session_id,project_id,status,phase,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const row of runs) insertRun.run(row.runId,row.sessionId,row.sourceSessionId,row.projectId,row.status,phaseFromRunStatus(row.status),row.error,row.createdAt,row.updatedAt);
        const insertQueue = this.#db.prepare(`INSERT OR IGNORE INTO queued_turns (queue_id,session_id,params_json,status,error,queued_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
        for (const row of queued) insertQueue.run(row.queueId,row.sessionId,row.paramsJson,row.status,row.error,row.queuedAt,row.updatedAt);
        const insertEvent = this.#db.prepare(`INSERT OR IGNORE INTO runtime_events (session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at) VALUES (?,?,?,?,?,?,?,?)`);
        for (const row of events) insertEvent.run(row.sessionId,row.runId,row.queueId,row.sequence,row.type,row.payloadJson,row.schemaVersion,row.createdAt);
        this.#db.prepare('INSERT INTO runtime_store_migrations (id,migrated_at) VALUES (?,?)').run(LEGACY_MIGRATION_ID, Date.now());
      });
    } finally {
      try { legacy?.close(); } catch {}
    }
  }

  #recoverInterruptedState(now) {
    this.#transaction(() => {
      const activeRuns = this.#db.prepare(`
        SELECT run_id AS runId, session_id AS sessionId, status, phase
        FROM runs WHERE status IN ('starting','running','waiting','settling')
      `).all();
      for (const run of activeRuns) {
        const message = 'Interrupted by runtime restart.';
        this.#db.prepare(`
          UPDATE runs
          SET status='interrupted', phase='interrupted',
              error=CASE WHEN error IS NULL OR error='' THEN ? ELSE error END,
              updated_at=?
          WHERE run_id=?
        `).run(message, now, run.runId);
        const current = this.getRun(run.runId);
        this.#appendEvent({
          sessionId: String(run.sessionId),
          runId: String(run.runId),
          type: 'run.finished',
          payload: {
            status: 'interrupted',
            phase: 'interrupted',
            error: current?.error ?? message,
            previousStatus: String(run.status),
            previousPhase: normalizeRunPhase(run.phase, run.status),
            recovery: 'runtime_restart',
          },
          createdAt: now,
        });
      }

      // A dispatching queue item may already have created its user/assistant messages.
      // Never replay it after a crash: at-most-once delivery is safer than duplicating work.
      const dispatching = this.#db.prepare(`
        SELECT queue_id AS id, session_id AS sessionId, queued_at AS queuedAt
        FROM queued_turns WHERE status='dispatching'
      `).all();
      for (const row of dispatching) {
        const message = 'Queue dispatch was interrupted by runtime restart; item was not replayed.';
        this.#db.prepare(`
          UPDATE queued_turns SET status='failed', error=?, updated_at=? WHERE queue_id=?
        `).run(message, now, row.id);
        this.#appendEvent({
          sessionId: String(row.sessionId),
          queueId: String(row.id),
          type: 'queue.failed',
          payload: {
            status: 'failed',
            error: message,
            queuedAt: Number(row.queuedAt) || 0,
            recovery: 'runtime_restart',
          },
          createdAt: now,
        });
      }
      this.#pruneFailedQueueRows();
    });
  }

  #appendEvent({ sessionId, runId = null, queueId = null, type, payload = {}, createdAt = Date.now() }) {
    const session = requiredText(sessionId, 'sessionId');
    const eventType = requiredText(type, 'event type');
    const nextSequence = Number(this.#db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_events WHERE session_id=?
    `).get(session)?.sequence ?? 1);
    this.#db.prepare(`
      INSERT INTO runtime_events (
        session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      session,
      optionalText(runId),
      optionalText(queueId),
      nextSequence,
      eventType,
      JSON.stringify(payload ?? {}),
      EVENT_SCHEMA_VERSION,
      createdAt,
    );
  }

  #transaction(callback) {
    return this.#db.transaction(callback);
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

function runRow(row) {
  return {
    runId: String(row.runId),
    sessionId: String(row.sessionId),
    sourceSessionId: optionalText(row.sourceSessionId),
    projectId: optionalText(row.projectId),
    status: normalizeRunStatus(row.status),
    phase: normalizeRunPhase(row.phase, row.status),
    error: optionalText(row.error),
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
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

function eventRow(row) {
  return {
    eventId: Number(row.eventId) || 0,
    sessionId: String(row.sessionId),
    runId: optionalText(row.runId),
    queueId: optionalText(row.queueId),
    sequence: Number(row.sequence) || 0,
    type: String(row.type),
    payload: parseParams(row.payloadJson),
    schemaVersion: Number(row.schemaVersion) || EVENT_SCHEMA_VERSION,
    createdAt: Number(row.createdAt) || 0,
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

function requireSqlRepository(value) {
  if (!value || typeof value !== 'object' || typeof value.exec !== 'function' || typeof value.prepare !== 'function' || typeof value.transaction !== 'function') {
    throw new TypeError('TurnStore requires a SQLite path or shared SQL repository');
  }
  return value;
}

function sqliteRepository(sqlite) {
  return {
    exec(sql) { return sqlite.exec(sql); },
    prepare(sql) { return sqlite.prepare(sql); },
    transaction(callback) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        if (result && typeof result.then === 'function') throw new Error('TurnStore transaction callback must be synchronous');
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        try { sqlite.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
}

function tableExists(sqlite, name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
