const STATES = new Set(['prepared', 'accepted', 'committed', 'aborted', 'interrupted']);
const ACTIONS = new Set(['continue', 'create', 'reactivate']);

export class Pe3HandoffLedger {
  #projectId; #repo; #db; #now;

  constructor({ db, projectId, now = Date.now }) {
    if (!db || typeof db.sqlRepository !== 'function') throw new TypeError('PE3 handoff ledger requires the conversation database');
    this.#projectId = bounded(projectId, 256);
    if (!this.#projectId) throw new TypeError('PE3 handoff ledger requires projectId');
    this.#db = db;
    this.#repo = db.sqlRepository();
    this.#now = now;
    this.#repo.exec(`
      CREATE TABLE IF NOT EXISTS pe3_handoffs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('continue','create','reactivate')),
        state TEXT NOT NULL CHECK(state IN ('prepared','accepted','committed','aborted','interrupted')),
        reason TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        target_user_message_id TEXT,
        assistant_run_id TEXT,
        abort_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pe3_handoffs_project_sequence ON pe3_handoffs(project_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_pe3_handoffs_project_state ON pe3_handoffs(project_id, state, sequence ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pe3_handoffs_accepted_target ON pe3_handoffs(project_id, target_session_id) WHERE state='accepted';
    `);
  }

  recoverInterrupted() {
    const now = this.#now();
    return this.#repo.prepare(`UPDATE pe3_handoffs SET state='interrupted', updated_at=? WHERE project_id=? AND state IN ('prepared','accepted')`).run(now, this.#projectId).changes;
  }

  create({ id, sourceSessionId, targetSessionId, action, reason = '', evidence = {} }) {
    const handoffId = bounded(id, 256);
    const source = bounded(sourceSessionId, 256);
    const target = bounded(targetSessionId, 256);
    const normalizedAction = bounded(action, 32);
    if (!handoffId || !source || !target || !ACTIONS.has(normalizedAction)) throw new Error('PE3 durable handoff identity is invalid');
    const now = this.#now();
    this.#repo.prepare(`INSERT INTO pe3_handoffs(id,project_id,source_session_id,target_session_id,action,state,reason,evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,'prepared',?,?,?,?)`).run(
      handoffId,
      this.#projectId,
      source,
      target,
      normalizedAction,
      bounded(reason, 500),
      JSON.stringify(safeEvidence(evidence)),
      now,
      now,
    );
    return this.get(handoffId);
  }

  accept(id) {
    const handoffId = bounded(id, 256);
    try {
      const result = this.#repo.prepare(`UPDATE pe3_handoffs SET state='accepted', updated_at=? WHERE id=? AND project_id=? AND state='prepared'`).run(this.#now(), handoffId, this.#projectId);
      if (result.changes !== 1) throw new Error('PE3 route token is not prepared');
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message ?? error))) throw new Error('PE3 target session is busy');
      throw error;
    }
    return this.get(handoffId);
  }

  commit(id, { targetUserMessageId, assistantRunId }) {
    const handoffId = bounded(id, 256);
    const userId = bounded(targetUserMessageId, 256);
    const runId = bounded(assistantRunId, 256);
    if (!userId || !runId) throw new Error('PE3 committed handoff requires durable target message and run identity');
    const current = this.get(handoffId);
    if (!current || current.state !== 'accepted') throw new Error('PE3 route token is not accepted');
    const user = this.#db.getMessage?.(userId);
    const assistant = this.#db.getMessage?.(runId);
    if (!user || user.role !== 'user' || user.sessionId !== current.targetSessionId) throw new Error('PE3 target user-message identity is not durable in the target session');
    if (!assistant || assistant.role !== 'assistant' || assistant.sessionId !== current.targetSessionId) throw new Error('PE3 assistant run identity is not durable in the target session');
    const result = this.#repo.prepare(`UPDATE pe3_handoffs SET state='committed', target_user_message_id=?, assistant_run_id=?, updated_at=? WHERE id=? AND project_id=? AND state='accepted'`).run(
      userId,
      runId,
      this.#now(),
      handoffId,
      this.#projectId,
    );
    if (result.changes !== 1) throw new Error('PE3 route token is not accepted');
    return this.get(handoffId);
  }

  abort(id, reason = 'handoff aborted') {
    const handoffId = bounded(id, 256);
    const result = this.#repo.prepare(`UPDATE pe3_handoffs SET state='aborted', abort_reason=?, updated_at=? WHERE id=? AND project_id=? AND state IN ('prepared','accepted')`).run(
      bounded(reason, 500),
      this.#now(),
      handoffId,
      this.#projectId,
    );
    return result.changes > 0;
  }

  get(id) {
    const row = this.#repo.prepare(`SELECT sequence,id,project_id AS projectId,source_session_id AS sourceSessionId,target_session_id AS targetSessionId,action,state,reason,evidence_json AS evidenceJson,target_user_message_id AS targetUserMessageId,assistant_run_id AS assistantRunId,abort_reason AS abortReason,created_at AS createdAt,updated_at AS updatedAt FROM pe3_handoffs WHERE id=? AND project_id=?`).get(bounded(id, 256), this.#projectId);
    return row ? hydrate(row) : null;
  }

  listCommitted(afterSequence = 0) {
    return this.#repo.prepare(`SELECT sequence,id,project_id AS projectId,source_session_id AS sourceSessionId,target_session_id AS targetSessionId,action,state,reason,evidence_json AS evidenceJson,target_user_message_id AS targetUserMessageId,assistant_run_id AS assistantRunId,abort_reason AS abortReason,created_at AS createdAt,updated_at AS updatedAt FROM pe3_handoffs WHERE project_id=? AND state='committed' AND sequence>? ORDER BY sequence ASC`).all(this.#projectId, nonNegative(afterSequence)).map(hydrate);
  }

  list({ state } = {}) {
    if (state && !STATES.has(state)) throw new Error(`invalid PE3 handoff state: ${state}`);
    const rows = state
      ? this.#repo.prepare(`SELECT sequence,id,project_id AS projectId,source_session_id AS sourceSessionId,target_session_id AS targetSessionId,action,state,reason,evidence_json AS evidenceJson,target_user_message_id AS targetUserMessageId,assistant_run_id AS assistantRunId,abort_reason AS abortReason,created_at AS createdAt,updated_at AS updatedAt FROM pe3_handoffs WHERE project_id=? AND state=? ORDER BY sequence ASC`).all(this.#projectId, state)
      : this.#repo.prepare(`SELECT sequence,id,project_id AS projectId,source_session_id AS sourceSessionId,target_session_id AS targetSessionId,action,state,reason,evidence_json AS evidenceJson,target_user_message_id AS targetUserMessageId,assistant_run_id AS assistantRunId,abort_reason AS abortReason,created_at AS createdAt,updated_at AS updatedAt FROM pe3_handoffs WHERE project_id=? ORDER BY sequence ASC`).all(this.#projectId);
    return rows.map(hydrate);
  }
}

function hydrate(row) {
  let evidence = {};
  try { evidence = safeEvidence(JSON.parse(row.evidenceJson || '{}')); } catch {}
  const { evidenceJson, ...rest } = row;
  return { ...rest, sequence: nonNegative(row.sequence), evidence };
}

function safeEvidence(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    activePaths: safeList(source.activePaths, 32, 512),
    touchedPaths: safeList(source.touchedPaths, 32, 512),
    localizedPaths: safeList(source.localizedPaths, 32, 512),
    recentSymbols: safeList(source.recentSymbols, 32, 160),
    localizedSymbols: safeList(source.localizedSymbols, 32, 160),
  };
}

function safeList(values, limit, maxBytes) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const raw of values) {
    const value = bounded(raw, maxBytes);
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function bounded(value, maxBytes) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized;
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end)) > maxBytes) end -= 1;
  return normalized.slice(0, end);
}
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0; }
