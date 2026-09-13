import { normalizeRunPhase } from './run-phase.mjs';

const ACTIVE_RUN_STATUSES = ['starting', 'running', 'waiting', 'settling'];

export class RunStateProjection {
  #db;

  constructor(repository) {
    this.#db = requireSqlRepository(repository);
  }

  isActive(sessionId) {
    const session = optionalText(sessionId);
    if (!session) return false;
    return Boolean(this.#db.prepare(`
      SELECT 1
      FROM runs
      WHERE session_id=? AND status IN ('starting','running','waiting','settling')
      LIMIT 1
    `).get(session));
  }

  activeCount() {
    return Number(this.#db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs
      WHERE status IN ('starting','running','waiting','settling')
    `).get()?.count ?? 0);
  }

  activeRun(sessionId) {
    const session = optionalText(sessionId);
    if (!session) return null;
    const row = this.#db.prepare(`
      SELECT run_id AS runId, session_id AS sessionId, source_session_id AS sourceSessionId,
             project_id AS projectId, status, phase, error, created_at AS createdAt, updated_at AS updatedAt
      FROM runs
      WHERE session_id=? AND status IN ('starting','running','waiting','settling')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT 1
    `).get(session);
    return row ? {
      runId: String(row.runId),
      sessionId: String(row.sessionId),
      sourceSessionId: optionalText(row.sourceSessionId),
      projectId: optionalText(row.projectId),
      status: ACTIVE_RUN_STATUSES.includes(String(row.status)) ? String(row.status) : 'running',
      phase: normalizeRunPhase(row.phase, row.status),
      error: optionalText(row.error),
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    } : null;
  }
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
}

function requireSqlRepository(value) {
  if (!value || typeof value !== 'object' || typeof value.prepare !== 'function') {
    throw new TypeError('RunStateProjection requires the shared SQL repository');
  }
  return value;
}
