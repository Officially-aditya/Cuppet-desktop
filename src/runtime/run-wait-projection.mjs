const ACTIVE_WAITABLE_RUN_STATUSES = new Set(['starting', 'running', 'waiting']);
const EVENT_SCHEMA_VERSION = 1;
const DURABLE_RUNTIME_EVENT_TYPES = new Set([
  'tool.started',
  'tool.finished',
  'edit.batch.prepared',
  'edit.batch.applied',
  'mutation.recovered',
  'mutation.recovery.conflict',
]);

export class RunWaitProjection {
  #db;

  constructor(repository) {
    this.#db = requireSqlRepository(repository);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS run_waits (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_waits_run ON run_waits(run_id, created_at ASC);
    `);
    // TurnStore performs restart recovery first. Any surviving wait row therefore
    // belongs to a run that is no longer actively waiting and must not be resumed.
    this.#db.prepare(`
      DELETE FROM run_waits
      WHERE run_id NOT IN (SELECT run_id FROM runs WHERE status='waiting')
    `).run();
  }

  observe(event, now = Date.now()) {
    const interaction = interactionEvent(event);
    if (interaction?.phase === 'requested') {
      return this.beginWait({
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
        kind: interaction.kind,
        now,
      });
    }
    if (interaction?.phase === 'resolved') return this.endWait(interaction.requestId, now);
    if (event?.type === 'run.finished' && event.messageId) return this.clearRun(event.messageId);

    const durable = durableRuntimeProjection(event);
    if (!durable) return null;
    return this.#db.transaction(() => {
      const runId = durable.runId ?? this.#latestActiveRunId(durable.sessionId);
      this.#appendEvent({
        sessionId: durable.sessionId,
        runId,
        type: durable.type,
        payload: durable.payload,
        createdAt: now,
      });
      return { sessionId: durable.sessionId, runId, type: durable.type };
    });
  }

  beginWait({ sessionId, requestId, kind = 'interaction', now = Date.now() } = {}) {
    const session = requiredText(sessionId, 'sessionId');
    const request = requiredText(requestId, 'requestId');
    const waitKind = boundedKind(kind);
    return this.#db.transaction(() => {
      const run = this.#db.prepare(`
        SELECT run_id AS runId, session_id AS sessionId, status
        FROM runs
        WHERE session_id=? AND status IN ('starting','running','waiting')
        ORDER BY updated_at DESC, created_at DESC, run_id DESC
        LIMIT 1
      `).get(session);
      if (!run || !ACTIVE_WAITABLE_RUN_STATUSES.has(String(run.status))) return null;

      const inserted = this.#db.prepare(`
        INSERT OR IGNORE INTO run_waits (request_id,run_id,session_id,kind,created_at)
        VALUES (?,?,?,?,?)
      `).run(request, run.runId, session, waitKind, now);
      if (inserted.changes === 0) return this.#runSnapshot(run.runId);

      this.#db.prepare(`
        UPDATE runs SET status='waiting', updated_at=?
        WHERE run_id=? AND status IN ('starting','running','waiting')
      `).run(now, run.runId);
      const pending = this.#pendingCount(run.runId);
      this.#appendEvent({
        sessionId: session,
        runId: run.runId,
        type: 'run.waiting',
        payload: { status: 'waiting', requestId: request, kind: waitKind, pending },
        createdAt: now,
      });
      return this.#runSnapshot(run.runId);
    });
  }

  endWait(requestId, now = Date.now()) {
    const request = requiredText(requestId, 'requestId');
    return this.#db.transaction(() => {
      const wait = this.#db.prepare(`
        SELECT request_id AS requestId, run_id AS runId, session_id AS sessionId, kind
        FROM run_waits WHERE request_id=?
      `).get(request);
      if (!wait) return null;
      this.#db.prepare('DELETE FROM run_waits WHERE request_id=?').run(request);

      const run = this.#runSnapshot(wait.runId);
      if (!run) return null;
      const pending = this.#pendingCount(wait.runId);
      if (pending === 0 && run.status === 'waiting') {
        this.#db.prepare(`UPDATE runs SET status='running', updated_at=? WHERE run_id=? AND status='waiting'`).run(now, wait.runId);
        this.#appendEvent({
          sessionId: wait.sessionId,
          runId: wait.runId,
          type: 'run.resumed',
          payload: { status: 'running', requestId: request, kind: wait.kind, pending: 0 },
          createdAt: now,
        });
      } else if (pending > 0) {
        this.#appendEvent({
          sessionId: wait.sessionId,
          runId: wait.runId,
          type: 'run.wait.resolved',
          payload: { status: run.status, requestId: request, kind: wait.kind, pending },
          createdAt: now,
        });
      }
      return this.#runSnapshot(wait.runId);
    });
  }

  clearRun(runId) {
    const id = requiredText(runId, 'runId');
    return this.#db.prepare('DELETE FROM run_waits WHERE run_id=?').run(id).changes;
  }

  pending(runId) {
    return this.#pendingCount(requiredText(runId, 'runId'));
  }

  #pendingCount(runId) {
    return Number(this.#db.prepare('SELECT COUNT(*) AS count FROM run_waits WHERE run_id=?').get(runId)?.count ?? 0);
  }

  #latestActiveRunId(sessionId) {
    const row = this.#db.prepare(`
      SELECT run_id AS runId
      FROM runs
      WHERE session_id=? AND status IN ('starting','running','waiting','settling')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT 1
    `).get(sessionId);
    return optionalText(row?.runId);
  }

  #runSnapshot(runId) {
    const row = this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE run_id=?
    `).get(runId);
    return row ? {
      runId: String(row.runId),
      sessionId: String(row.sessionId),
      sourceSessionId: optionalText(row.sourceSessionId),
      projectId: optionalText(row.projectId),
      status: String(row.status),
      error: optionalText(row.error),
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    } : null;
  }

  #appendEvent({ sessionId, runId, type, payload, createdAt }) {
    const nextSequence = Number(this.#db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM runtime_events WHERE session_id=?
    `).get(sessionId)?.sequence ?? 1);
    this.#db.prepare(`
      INSERT INTO runtime_events (
        session_id,run_id,queue_id,sequence,type,payload_json,schema_version,created_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(sessionId, runId, null, nextSequence, type, JSON.stringify(payload ?? {}), EVENT_SCHEMA_VERSION, createdAt);
  }
}

export function interactionEvent(event) {
  const type = String(event?.type ?? '');
  if (type === 'permission.requested' || type === 'question.requested') {
    const request = record(event.request);
    const sessionId = optionalText(request.sessionId);
    const requestId = optionalText(request.id);
    if (!sessionId || !requestId) return null;
    return {
      phase: 'requested',
      kind: type.startsWith('permission.') ? 'permission' : 'question',
      sessionId,
      requestId,
    };
  }
  if (type === 'permission.resolved' || type === 'question.resolved') {
    const sessionId = optionalText(event.sessionId);
    const requestId = optionalText(event.requestId);
    if (!sessionId || !requestId) return null;
    return {
      phase: 'resolved',
      kind: type.startsWith('permission.') ? 'permission' : 'question',
      sessionId,
      requestId,
    };
  }
  return null;
}

export function durableRuntimeProjection(event) {
  const type = String(event?.type ?? '');
  if (!DURABLE_RUNTIME_EVENT_TYPES.has(type)) return null;
  const sessionId = optionalText(event?.sessionId);
  if (!sessionId) return null;
  const runId = optionalText(event?.messageId);

  if (type === 'tool.started') {
    return {
      type,
      sessionId,
      runId,
      payload: compactPayload({
        executionId: event.executionId,
        callId: event.callId,
        tool: event.tool,
        status: 'running',
      }),
    };
  }
  if (type === 'tool.finished') {
    return {
      type,
      sessionId,
      runId,
      payload: compactPayload({
        executionId: event.executionId,
        callId: event.callId,
        tool: event.tool,
        status: event.success === true ? 'complete' : event.rejected === true ? 'rejected' : 'error',
        success: event.success === true,
        rejected: event.rejected === true,
        mutation: event.mutation === true,
        paths: boundedPaths(event.paths),
      }),
    };
  }
  if (type === 'edit.batch.prepared' || type === 'edit.batch.applied') {
    return {
      type,
      sessionId,
      runId,
      payload: compactPayload({
        batchId: event.batchId,
        paths: boundedPaths(event.paths),
        diffDigest: event.diffDigest,
        ...(type === 'edit.batch.applied' ? {
          graphReady: event.graphReady === true,
          graphError: boundedText(event.graphError, 500),
        } : {}),
      }),
    };
  }
  return {
    type,
    sessionId,
    runId,
    payload: compactPayload({
      mutationId: event.mutationId,
      restoredFiles: finiteInteger(event.restoredFiles),
      path: boundedText(event.path, 512),
      message: boundedText(event.message, 500),
    }),
  };
}

function compactPayload(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== '' && !(Array.isArray(item) && item.length === 0)));
}
function boundedPaths(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => boundedText(item, 512)).filter(Boolean))].slice(0, 64);
}
function boundedText(value, limit) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}
function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
}
function boundedKind(value) {
  const kind = String(value ?? '').trim().toLowerCase();
  return ['permission', 'question', 'interaction'].includes(kind) ? kind : 'interaction';
}

function requiredText(value, label) {
  const result = optionalText(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requireSqlRepository(value) {
  if (!value || typeof value !== 'object' || typeof value.exec !== 'function' || typeof value.prepare !== 'function' || typeof value.transaction !== 'function') {
    throw new TypeError('RunWaitProjection requires the shared SQL repository');
  }
  return value;
}
