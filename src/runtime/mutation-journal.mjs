import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SCHEMA_VERSION = 1;
const PENDING_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_BATCH_FILES = 64;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class UndoConflictError extends Error {
  constructor(message) { super(message); this.name = 'UndoConflictError'; this.code = 'undo_conflict'; }
}

export class MutationJournal {
  #directory; #cache = new Map(); #writes = new Map(); #recoveryPromise; #recoveryReport = { recoveredBatches: 0, restoredFiles: 0, conflicts: [] };
  constructor(directory) {
    this.#directory = directory;
    this.#recoveryPromise = this.#recoverPendingBatches().catch((error) => {
      const conflict = { sessionId: null, mutationId: null, path: null, error: cleanError(error) };
      this.#recoveryReport = { recoveredBatches: 0, restoredFiles: 0, conflicts: [conflict] };
      return structuredClone(this.#recoveryReport);
    });
  }

  async ready() { return structuredClone(await this.#recoveryPromise); }

  async beginFile({ sessionId, executionId, tool, projectRoot, path }) {
    await this.#recoveryPromise;
    if (!sessionId || !executionId || !projectRoot || !path) throw new Error('mutation snapshot requires session, execution, workspace, and path');
    const safe = await resolveWorkspacePath(projectRoot, path, false);
    const before = await snapshotFile(safe.absolute);
    return { sessionId, executionId, tool: String(tool || 'workspace'), projectRoot: safe.root, path: safe.relative, before };
  }

  async commitFile(token) {
    await this.#recoveryPromise;
    const afterPath = await resolveWorkspacePath(token.projectRoot, token.path, false);
    const after = await snapshotFile(afterPath.absolute);
    const entry = {
      id: mutationId(), schema: SCHEMA_VERSION, sessionId: token.sessionId, executionId: token.executionId,
      tool: token.tool, kind: 'file', projectRoot: token.projectRoot, path: token.path,
      before: token.before, after, state: 'applied', createdAt: Date.now(),
    };
    await this.#append(entry);
    return structuredClone(entry);
  }

  async beginBatch({ sessionId, executionId, tool = 'tst_edit_batch', projectRoot, paths, expectedAfter = [] }) {
    await this.#recoveryPromise;
    const unique = [...new Set((Array.isArray(paths) ? paths : []).map(String))];
    if (!sessionId || !executionId || !projectRoot || !unique.length) throw new Error('batch mutation snapshot requires session, execution, workspace, and paths');
    if (unique.length > MAX_BATCH_FILES) throw new Error(`Batch journal exceeds ${MAX_BATCH_FILES} file limit`);
    const expected = expectedAfterMap(expectedAfter);
    let canonicalRoot;
    const files = [];
    for (const path of unique) {
      const safe = await resolveWorkspacePath(projectRoot, path, false);
      canonicalRoot ??= safe.root;
      if (safe.root !== canonicalRoot) throw new Error('Batch journal paths do not share one canonical workspace');
      files.push({ path: safe.relative, before: await snapshotFile(safe.absolute), expectedAfter: expected.get(safe.relative) ?? null });
    }
    const token = {
      id: mutationId(), schema: PENDING_SCHEMA_VERSION, kind: 'batch-intent', sessionId, executionId,
      tool, projectRoot: canonicalRoot, files, createdAt: Date.now(),
    };
    await this.#writePending(token);
    return structuredClone(token);
  }

  async commitBatch(token) {
    await this.#recoveryPromise;
    const files = [];
    for (const item of token.files) {
      const safe = await resolveWorkspacePath(token.projectRoot, item.path, false);
      const after = await snapshotFile(safe.absolute);
      if (item.expectedAfter && !snapshotMatches(after, item.expectedAfter)) {
        throw new Error(`Batch commit refused because ${item.path} does not match its expected post-write snapshot.`);
      }
      files.push({ path: item.path, before: item.before, after });
    }
    const entry = {
      id: validMutationId(token.id) ? token.id : mutationId(), schema: SCHEMA_VERSION, sessionId: token.sessionId, executionId: token.executionId,
      tool: token.tool, kind: 'batch', projectRoot: token.projectRoot, files,
      state: 'applied', createdAt: Date.now(),
    };
    await this.#append(entry);
    if (validMutationId(token.id)) await this.#deletePending(token.id);
    return structuredClone(entry);
  }

  async abortBatch(token) {
    await this.#recoveryPromise;
    if (!validMutationId(token?.id)) return false;
    return this.#deletePending(token.id);
  }

  async recordBarrier({ sessionId, executionId, tool = 'bash', paths = [], reason = 'opaque workspace mutation' }) {
    await this.#recoveryPromise;
    const entry = {
      id: mutationId(), schema: SCHEMA_VERSION, sessionId, executionId, tool, kind: 'barrier',
      paths: [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 512)))].slice(0, 128),
      reason: String(reason).slice(0, 500), state: 'applied', createdAt: Date.now(),
    };
    await this.#append(entry);
    return structuredClone(entry);
  }

  async status(sessionId) {
    await this.#recoveryPromise;
    const entries = await this.#load(sessionId);
    const latest = [...entries].reverse().find((entry) => entry.state === 'applied') ?? null;
    const conflicts = this.#recoveryReport.conflicts.filter((item) => item.sessionId === sessionId);
    return {
      available: Boolean(latest),
      latest: latest ? publicEntry(latest) : null,
      recovery: { conflicted: conflicts.length > 0, conflicts: structuredClone(conflicts) },
    };
  }

  async deleteSession(sessionId) {
    await this.#recoveryPromise;
    const id = String(sessionId ?? '');
    if (!id) return { sessionId: id, deleted: false };
    const pending = this.#writes.get(id);
    if (pending) await pending.catch(() => undefined);
    this.#writes.delete(id);
    const cached = this.#cache.delete(id);
    await this.#deletePendingForSession(id);
    this.#recoveryReport.conflicts = this.#recoveryReport.conflicts.filter((item) => item.sessionId !== id);
    if (this.#directory) await rm(this.#path(id), { force: true });
    return { sessionId: id, deleted: cached || Boolean(this.#directory) };
  }

  async undoLatest({ sessionId, projectRoot }) {
    await this.#recoveryPromise;
    const entries = await this.#load(sessionId);
    const index = findLatestApplied(entries);
    if (index < 0) return { undone: false, sessionId, reason: 'No reversible workspace mutation is recorded for this session.' };
    const entry = entries[index];
    if (entry.kind === 'barrier') throw new UndoConflictError(`The latest workspace mutation (${entry.tool}) is opaque and cannot be safely undone. ${entry.reason || ''}`.trim());

    const currentRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
    if (entry.projectRoot !== currentRoot) throw new UndoConflictError('Cannot undo this mutation because the session is no longer attached to the original project workspace.');
    const files = entry.kind === 'batch' ? entry.files : [{ path: entry.path, before: entry.before, after: entry.after }];
    const checked = [];
    for (const item of files) {
      const target = await resolveWorkspacePath(currentRoot, item.path, false);
      const current = await snapshotFile(target.absolute);
      if (!snapshotMatches(current, item.after)) throw new UndoConflictError(`Cannot undo ${item.path}: the file changed after Cuppet's recorded mutation.`);
      checked.push({ item, target, current });
    }

    const restored = [];
    try {
      for (const record of checked) {
        await restoreSnapshot(record.target.absolute, record.item.before);
        const verified = await snapshotFile(record.target.absolute);
        if (!snapshotMatches(verified, record.item.before)) throw new UndoConflictError(`Undo verification failed for ${record.item.path}; the restored bytes do not match the recorded pre-mutation snapshot.`);
        restored.push(record);
      }
    } catch (error) {
      for (const record of restored.reverse()) {
        try { await restoreSnapshot(record.target.absolute, record.item.after); } catch { /* best-effort recovery; original failure remains authoritative */ }
      }
      throw error;
    }

    entries[index] = { ...entry, state: 'undone', undoneAt: Date.now() };
    await this.#save(sessionId, entries);
    const paths = files.map((item) => item.path);
    return {
      undone: true, sessionId, mutationId: entry.id, executionId: entry.executionId, tool: entry.tool,
      path: paths.length === 1 ? paths[0] : null, paths,
    };
  }

  async #append(entry) {
    const entries = await this.#load(entry.sessionId);
    const existing = entries.findIndex((item) => item.id === entry.id);
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    await this.#save(entry.sessionId, entries);
  }

  async #load(sessionId) {
    const key = String(sessionId || '');
    if (!key) return [];
    if (this.#cache.has(key)) return structuredClone(this.#cache.get(key));
    try {
      const decoded = JSON.parse(await readFile(this.#path(key), 'utf8'));
      const entries = decoded?.schema === SCHEMA_VERSION && decoded?.sessionId === key && Array.isArray(decoded.entries) ? decoded.entries.filter(validEntry) : [];
      this.#cache.set(key, entries);
      return structuredClone(entries);
    } catch { this.#cache.set(key, []); return []; }
  }

  async #save(sessionId, entries) {
    const snapshot = entries.slice(-MAX_ENTRIES).map((entry) => structuredClone(entry));
    if (!this.#directory) { this.#cache.set(sessionId, snapshot); return; }
    const previous = this.#writes.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
      const target = this.#path(sessionId);
      const temporary = join(this.#directory, `.${hash(sessionId)}.${randomBytes(5).toString('hex')}.tmp`);
      await writeFile(temporary, `${JSON.stringify({ schema: SCHEMA_VERSION, sessionId, entries: snapshot })}\n`, { mode: 0o600 });
      await rename(temporary, target);
      this.#cache.set(sessionId, snapshot);
    });
    this.#writes.set(sessionId, next);
    try { await next; } finally { if (this.#writes.get(sessionId) === next) this.#writes.delete(sessionId); }
  }

  async #writePending(token) {
    if (!this.#directory) return;
    await mkdir(this.#pendingDirectory(), { recursive: true, mode: 0o700 });
    await chmod(this.#pendingDirectory(), 0o700);
    const target = this.#pendingPath(token.id);
    const temporary = `${target}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(token)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async #deletePending(id) {
    if (!this.#directory || !validMutationId(id)) return false;
    try { await rm(this.#pendingPath(id), { force: true }); return true; }
    catch { return false; }
  }

  async #deletePendingForSession(sessionId) {
    if (!this.#directory) return;
    for (const pending of await this.#pendingEntries()) {
      if (pending.token?.sessionId === sessionId) await rm(pending.path, { force: true }).catch(() => undefined);
    }
  }

  async #recoverPendingBatches() {
    if (!this.#directory) return structuredClone(this.#recoveryReport);
    const report = { recoveredBatches: 0, restoredFiles: 0, conflicts: [] };
    for (const pending of await this.#pendingEntries()) {
      const token = pending.token;
      if (!validPendingBatch(token)) {
        report.conflicts.push({ sessionId: token?.sessionId ?? null, mutationId: token?.id ?? null, path: null, error: 'Invalid pending mutation intent; recovery refused.' });
        continue;
      }
      const history = await this.#load(token.sessionId);
      if (history.some((entry) => entry.id === token.id && ['applied', 'undone'].includes(entry.state))) {
        await rm(pending.path, { force: true }).catch(() => undefined);
        continue;
      }

      let batchConflict = false;
      for (const item of token.files) {
        try {
          const target = await resolveWorkspacePath(token.projectRoot, item.path, false);
          const current = await snapshotFile(target.absolute);
          if (snapshotMatches(current, item.before)) continue;
          if (item.expectedAfter && snapshotMatches(current, item.expectedAfter)) {
            await restoreSnapshot(target.absolute, item.before);
            const restored = await snapshotFile(target.absolute);
            if (!snapshotMatches(restored, item.before)) throw new Error('restored bytes did not match the durable preimage');
            report.restoredFiles += 1;
            continue;
          }
          batchConflict = true;
          report.conflicts.push({
            sessionId: token.sessionId,
            mutationId: token.id,
            path: item.path,
            error: 'Workspace file matches neither the durable preimage nor the expected Cuppet postimage; recovery preserved the current file.',
          });
        } catch (error) {
          batchConflict = true;
          report.conflicts.push({ sessionId: token.sessionId, mutationId: token.id, path: item.path, error: cleanError(error) });
        }
      }
      if (!batchConflict) {
        report.recoveredBatches += 1;
        await rm(pending.path, { force: true }).catch(() => undefined);
      }
    }
    this.#recoveryReport = report;
    return structuredClone(report);
  }

  async #pendingEntries() {
    if (!this.#directory) return [];
    let names;
    try { names = await readdir(this.#pendingDirectory()); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const output = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.#pendingDirectory(), name);
      try { output.push({ path, token: JSON.parse(await readFile(path, 'utf8')) }); }
      catch { output.push({ path, token: null }); }
    }
    return output;
  }

  #path(sessionId) { return join(this.#directory, `${hash(sessionId)}.json`); }
  #pendingDirectory() { return join(this.#directory, 'pending'); }
  #pendingPath(id) { return join(this.#pendingDirectory(), `${id}.json`); }
}

async function restoreSnapshot(path, snapshot) {
  if (snapshot.exists) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${Date.now().toString(36)}.${randomBytes(5).toString('hex')}.cuppet-restore`);
    try {
      await writeFile(temporary, Buffer.from(snapshot.contentBase64, 'base64'));
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  } else {
    await rm(path, { force: true });
  }
}

async function snapshotFile(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('Mutation journal only supports regular files');
    if (metadata.size > MAX_SNAPSHOT_BYTES) throw new Error(`Cannot safely journal a file larger than ${MAX_SNAPSHOT_BYTES} bytes`);
    const content = await readFile(path);
    return { exists: true, hash: hash(content), contentBase64: content.toString('base64') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, hash: null, contentBase64: '' };
    throw error;
  }
}

function expectedAfterMap(values) {
  const output = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    const path = typeof item?.path === 'string' ? item.path.replaceAll('\\', '/') : '';
    if (!path) continue;
    const exists = item?.exists !== false;
    const hashValue = exists && typeof item?.hash === 'string' && SHA256_HEX.test(item.hash) ? item.hash : null;
    if (exists && !hashValue) continue;
    output.set(path, { exists, hash: exists ? hashValue : null });
  }
  return output;
}
function snapshotMatches(actual, expected) { return Boolean(actual?.exists) === Boolean(expected?.exists) && (!expected?.exists || actual?.hash === expected?.hash); }
function findLatestApplied(entries) { for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.state === 'applied') return i; return -1; }
function validEntry(entry) {
  if (!entry || entry.schema !== SCHEMA_VERSION || typeof entry.sessionId !== 'string' || !['file', 'batch', 'barrier'].includes(entry.kind) || !['applied', 'undone'].includes(entry.state)) return false;
  if (entry.kind === 'barrier') return true;
  if (typeof entry.projectRoot !== 'string' || entry.projectRoot.length === 0) return false;
  if (entry.kind === 'batch') return Array.isArray(entry.files) && entry.files.length > 0 && entry.files.length <= MAX_BATCH_FILES && entry.files.every(validJournalFile);
  return validJournalFile({ path: entry.path, before: entry.before, after: entry.after });
}
function validPendingBatch(entry) {
  return Boolean(entry && entry.schema === PENDING_SCHEMA_VERSION && entry.kind === 'batch-intent' && validMutationId(entry.id)
    && typeof entry.sessionId === 'string' && entry.sessionId.length > 0
    && typeof entry.executionId === 'string' && entry.executionId.length > 0
    && typeof entry.projectRoot === 'string' && entry.projectRoot.length > 0
    && Array.isArray(entry.files) && entry.files.length > 0 && entry.files.length <= MAX_BATCH_FILES
    && entry.files.every((item) => typeof item?.path === 'string' && item.path.length > 0 && validSnapshot(item.before, true)
      && (item.expectedAfter === null || validSnapshot(item.expectedAfter, false))));
}
function validJournalFile(item) { return typeof item?.path === 'string' && item.path.length > 0 && validSnapshot(item.before, true) && validSnapshot(item.after, false); }
function validSnapshot(value, withContent) {
  if (!value || typeof value.exists !== 'boolean') return false;
  if (!value.exists) return value.hash === null;
  if (typeof value.hash !== 'string' || !SHA256_HEX.test(value.hash)) return false;
  return !withContent || typeof value.contentBase64 === 'string';
}
function publicEntry(entry) {
  const paths = entry.kind === 'batch' ? entry.files.map((item) => item.path) : entry.path ? [entry.path] : entry.paths ?? [];
  return { id: entry.id, executionId: entry.executionId, tool: entry.tool, kind: entry.kind, state: entry.state, path: paths.length === 1 ? paths[0] : null, paths, createdAt: entry.createdAt };
}
function validMutationId(value) { return typeof value === 'string' && /^mutation_[a-z0-9]+_[a-f0-9]{10}$/.test(value); }
function mutationId() { return `mutation_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`; }
function hash(value) { return createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex'); }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).slice(0, 1000); }

async function resolveWorkspacePath(projectRoot, resource, mustExist) {
  const root = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const raw = String(resource ?? '').trim();
  if (!raw || raw.includes('\0') || raw.startsWith('~') || raw.startsWith('file:')) throw new Error('Invalid mutation journal path');
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (candidate === root || !isAtOrInside(root, candidate)) throw new Error('Mutation journal path escapes the project workspace');
  if (mustExist) {
    const actual = await realpath(candidate);
    if (!isAtOrInside(root, actual)) throw new Error('Mutation journal path resolves outside the project workspace');
  } else {
    let ancestor = candidate;
    for (;;) {
      try { const actual = await realpath(ancestor); if (!isAtOrInside(root, actual)) throw new Error('Mutation journal ancestor resolves outside the workspace'); break; }
      catch (error) { if (String(error?.message).includes('outside')) throw error; if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
    }
  }
  return { root, absolute: candidate, relative: relative(root, candidate).replaceAll('\\', '/') };
}
function isAtOrInside(root, candidate) { const path = relative(root, candidate); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
