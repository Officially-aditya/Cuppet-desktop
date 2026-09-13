import { createHash } from 'node:crypto';

const COMMAND_SCHEMA_VERSION = 1;
const MAX_RECEIPTS = 2000;
const RECEIPT_STATES = new Set(['processing', 'accepted', 'failed', 'unknown']);

export class CommandReceiptStore {
  #db;

  constructor(repository, now = Date.now) {
    this.#db = requireSqlRepository(repository);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        session_id TEXT,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        schema_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_command_receipts_session_updated
        ON command_receipts(session_id, updated_at DESC);
    `);
    this.#recoverInterrupted(now());
  }

  begin({ commandId, method, sessionId = null, params = {}, now = Date.now() }) {
    const id = requiredCommandId(commandId);
    const commandMethod = requiredMethod(method);
    const fingerprint = commandFingerprint(commandMethod, params);
    const session = optionalText(sessionId);
    return this.#db.transaction(() => {
      const existing = this.get(id);
      if (existing) {
        assertReceiptIdentity(existing, commandMethod, fingerprint);
        return { created: false, receipt: existing };
      }
      this.#db.prepare(`
        INSERT INTO command_receipts (
          command_id,method,session_id,fingerprint,state,result_json,error,schema_version,created_at,updated_at
        ) VALUES (?,?,?,?, 'processing', NULL, NULL, ?, ?, ?)
      `).run(id, commandMethod, session, fingerprint, COMMAND_SCHEMA_VERSION, now, now);
      this.#prune();
      return { created: true, receipt: this.get(id) };
    });
  }

  accept(commandId, result, now = Date.now()) {
    const id = requiredCommandId(commandId);
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw receiptError(`Unknown command receipt: ${id}`, 'COMMAND_RECEIPT_MISSING');
      if (current.state === 'accepted') {
        this.#db.prepare(`
          UPDATE command_receipts
          SET result_json=?, error=NULL, updated_at=?
          WHERE command_id=? AND state='accepted'
        `).run(JSON.stringify(safeResult(result)), now, id);
        return this.get(id);
      }
      if (current.state !== 'processing') throw receiptStateError(current);
      this.#db.prepare(`
        UPDATE command_receipts
        SET state='accepted', result_json=?, error=NULL, updated_at=?
        WHERE command_id=? AND state='processing'
      `).run(JSON.stringify(safeResult(result)), now, id);
      return this.get(id);
    });
  }

  fail(commandId, error, now = Date.now()) {
    const id = requiredCommandId(commandId);
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      if (current.state !== 'processing') return current;
      this.#db.prepare(`
        UPDATE command_receipts
        SET state='failed', error=?, updated_at=?
        WHERE command_id=? AND state='processing'
      `).run(cleanError(error), now, id);
      return this.get(id);
    });
  }

  get(commandId) {
    const id = String(commandId ?? '');
    if (!id) return null;
    const row = this.#db.prepare(`
      SELECT command_id AS commandId, method, session_id AS sessionId, fingerprint, state,
             result_json AS resultJson, error, schema_version AS schemaVersion,
             created_at AS createdAt, updated_at AS updatedAt
      FROM command_receipts WHERE command_id=?
    `).get(id);
    return row ? receiptRow(row) : null;
  }

  resolve({ commandId, method, params = {} }) {
    const id = requiredCommandId(commandId);
    const commandMethod = requiredMethod(method);
    const fingerprint = commandFingerprint(commandMethod, params);
    const receipt = this.get(id);
    if (!receipt) return null;
    assertReceiptIdentity(receipt, commandMethod, fingerprint);
    if (receipt.state === 'accepted') return { replay: true, result: structuredClone(receipt.result ?? {}) };
    throw receiptStateError(receipt);
  }

  markUnknown(commandId, message = 'Command outcome is unknown after runtime restart.', now = Date.now()) {
    const id = requiredCommandId(commandId);
    this.#db.prepare(`
      UPDATE command_receipts
      SET state='unknown', error=?, updated_at=?
      WHERE command_id=? AND state='processing'
    `).run(cleanError(message), now, id);
    return this.get(id);
  }

  #recoverInterrupted(now) {
    this.#db.prepare(`
      UPDATE command_receipts
      SET state='unknown',
          error='Command outcome is unknown after runtime restart; it was not replayed.',
          updated_at=?
      WHERE state='processing'
    `).run(now);
  }

  #prune() {
    this.#db.prepare(`
      DELETE FROM command_receipts
      WHERE state!='processing' AND command_id NOT IN (
        SELECT command_id FROM command_receipts
        WHERE state!='processing'
        ORDER BY updated_at DESC
        LIMIT ?
      )
    `).run(MAX_RECEIPTS);
  }
}

export function commandFingerprint(method, params = {}) {
  const normalizedMethod = requiredMethod(method);
  const source = record(params);
  const payload = normalizedMethod === 'session.send'
    ? {
        sessionId: optionalText(source.sessionId),
        text: typeof source.text === 'string' ? source.text : '',
        attachments: normalizeAttachments(source.attachments),
        provider: providerIdentity(source.provider),
      }
    : sanitizeValue(source);
  return createHash('sha256').update(stableJson({ method: normalizedMethod, payload })).digest('hex');
}

export function commandReceiptResult(receipt) {
  if (!receipt) return null;
  if (receipt.state === 'accepted') return structuredClone(receipt.result ?? {});
  throw receiptStateError(receipt);
}

function receiptRow(row) {
  const state = RECEIPT_STATES.has(String(row.state)) ? String(row.state) : 'unknown';
  return {
    commandId: String(row.commandId),
    method: String(row.method),
    sessionId: optionalText(row.sessionId),
    fingerprint: String(row.fingerprint),
    state,
    result: parseResult(row.resultJson),
    error: optionalText(row.error),
    schemaVersion: Number(row.schemaVersion) || COMMAND_SCHEMA_VERSION,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function assertReceiptIdentity(receipt, method, fingerprint) {
  if (receipt.method !== method || receipt.fingerprint !== fingerprint) {
    throw receiptError('Command id was already used for a different request.', 'COMMAND_RECEIPT_CONFLICT');
  }
}

function receiptStateError(receipt) {
  if (receipt.state === 'processing') {
    return receiptError('This command is already being processed; it was not dispatched twice.', 'COMMAND_IN_PROGRESS');
  }
  if (receipt.state === 'unknown') {
    return receiptError(receipt.error || 'Command outcome is unknown; inspect the chat before issuing a new command.', 'COMMAND_OUTCOME_UNKNOWN');
  }
  if (receipt.state === 'failed') {
    return receiptError(receipt.error || 'The prior command attempt failed and was not replayed.', 'COMMAND_FAILED');
  }
  return receiptError('Command receipt is not replayable.', 'COMMAND_NOT_REPLAYABLE');
}

function receiptError(message, code) {
  const error = new Error(message);
  error.name = 'CommandReceiptError';
  error.code = code;
  return error;
}

function safeResult(value) {
  return sanitizeValue(value, 0, { preserveProvider: true });
}

function providerIdentity(value) {
  const source = record(value);
  const primary = record(source.primary);
  const secondary = record(source.secondary);
  return {
    providerID: optionalText(source.providerID),
    baseUrl: optionalText(source.baseUrl),
    primary: {
      providerID: optionalText(primary.providerID),
      modelID: optionalText(primary.modelID),
      variant: optionalText(primary.variant),
    },
    secondary: {
      providerID: optionalText(secondary.providerID),
      modelID: optionalText(secondary.modelID),
      variant: optionalText(secondary.variant),
    },
  };
}

function normalizeAttachments(value) {
  return (Array.isArray(value) ? value : []).slice(0, 16).map((item) => {
    const source = record(item);
    return {
      name: optionalText(source.name),
      mime: optionalText(source.mime ?? source.type),
      path: optionalText(source.path),
      size: Number.isFinite(Number(source.size)) ? Math.max(0, Math.trunc(Number(source.size))) : null,
    };
  });
}

function sanitizeValue(value, depth = 0, options = {}) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizeValue(item, depth + 1, options));
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (!options.preserveProvider && /(?:api.?key|secret|token|password|authorization|cookie)/i.test(key)) continue;
    output[key] = sanitizeValue(value[key], depth + 1, options);
  }
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function parseResult(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function requiredCommandId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, 200) : '';
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('A valid command id is required.');
  return id;
}
function requiredMethod(value) {
  const method = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  if (!method || !/^[a-z0-9._-]+$/i.test(method)) throw new Error('A valid command method is required.');
  return method;
}
function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4000) : null;
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function cleanError(error) {
  const value = error instanceof Error ? error.message : String(error ?? 'Command failed.');
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[redacted]')
    .slice(0, 1000);
}
function requireSqlRepository(value) {
  if (!value || typeof value !== 'object' || typeof value.exec !== 'function' || typeof value.prepare !== 'function' || typeof value.transaction !== 'function') {
    throw new TypeError('CommandReceiptStore requires the shared SQL repository');
  }
  return value;
}
