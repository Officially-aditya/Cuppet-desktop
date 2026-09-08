import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class UndoConflictError extends Error {
  constructor(message) { super(message); this.name = 'UndoConflictError'; this.code = 'undo_conflict'; }
}

export class MutationJournal {
  #directory; #cache = new Map(); #writes = new Map();
  constructor(directory) { this.#directory = directory; }

  async beginFile({ sessionId, executionId, tool, projectRoot, path }) {
    if (!sessionId || !executionId || !projectRoot || !path) throw new Error('mutation snapshot requires session, execution, workspace, and path');
    const safe = await resolveWorkspacePath(projectRoot, path, false);
    const before = await snapshotFile(safe.absolute);
    return { sessionId, executionId, tool: String(tool || 'workspace'), projectRoot: safe.root, path: safe.relative, before };
  }

  async commitFile(token) {
    const afterPath = await resolveWorkspacePath(token.projectRoot, token.path, false);
    const after = await snapshotFile(afterPath.absolute);
    const entry = {
      id: `mutation_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`,
      schema: SCHEMA_VERSION,
      sessionId: token.sessionId,
      executionId: token.executionId,
      tool: token.tool,
      kind: 'file',
      projectRoot: token.projectRoot,
      path: token.path,
      before: token.before,
      after: { exists: after.exists, hash: after.exists ? after.hash : null },
      state: 'applied',
      createdAt: Date.now(),
    };
    await this.#append(entry);
    return structuredClone(entry);
  }

  async recordBarrier({ sessionId, executionId, tool = 'bash', paths = [], reason = 'opaque workspace mutation' }) {
    const entry = {
      id: `mutation_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`,
      schema: SCHEMA_VERSION,
      sessionId,
      executionId,
      tool,
      kind: 'barrier',
      paths: [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 512)))].slice(0, 128),
      reason: String(reason).slice(0, 500),
      state: 'applied',
      createdAt: Date.now(),
    };
    await this.#append(entry);
    return structuredClone(entry);
  }

  async status(sessionId) {
    const entries = await this.#load(sessionId);
    const latest = [...entries].reverse().find((entry) => entry.state === 'applied') ?? null;
    return { available: Boolean(latest), latest: latest ? publicEntry(latest) : null };
  }

  async undoLatest({ sessionId, projectRoot }) {
    const entries = await this.#load(sessionId);
    const index = findLatestApplied(entries);
    if (index < 0) return { undone: false, sessionId, reason: 'No reversible workspace mutation is recorded for this session.' };
    const entry = entries[index];
    if (entry.kind !== 'file') throw new UndoConflictError(`The latest workspace mutation (${entry.tool}) is opaque and cannot be safely undone. ${entry.reason || ''}`.trim());

    const currentRoot = await realpath(projectRoot).catch(() => resolve(projectRoot));
    if (entry.projectRoot !== currentRoot) throw new UndoConflictError('Cannot undo this mutation because the session is no longer attached to the original project workspace.');
    const target = await resolveWorkspacePath(currentRoot, entry.path, false);
    const current = await snapshotFile(target.absolute);
    if (!snapshotMatches(current, entry.after)) throw new UndoConflictError(`Cannot undo ${entry.path}: the file changed after Cuppet's recorded mutation.`);

    if (entry.before.exists) {
      await mkdir(dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, Buffer.from(entry.before.contentBase64, 'base64'));
    } else {
      await rm(target.absolute, { force: true });
    }
    const restored = await snapshotFile(target.absolute);
    if (!snapshotMatches(restored, entry.before)) throw new UndoConflictError(`Undo verification failed for ${entry.path}; the restored bytes do not match the recorded pre-mutation snapshot.`);

    entries[index] = { ...entry, state: 'undone', undoneAt: Date.now() };
    await this.#save(sessionId, entries);
    return { undone: true, sessionId, mutationId: entry.id, executionId: entry.executionId, tool: entry.tool, path: entry.path };
  }

  async #append(entry) {
    const entries = await this.#load(entry.sessionId);
    entries.push(entry);
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

  #path(sessionId) { return join(this.#directory, `${hash(sessionId)}.json`); }
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
function snapshotMatches(actual, expected) { return Boolean(actual?.exists) === Boolean(expected?.exists) && (!expected?.exists || actual?.hash === expected?.hash); }
function findLatestApplied(entries) { for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.state === 'applied') return i; return -1; }
function validEntry(entry) {
  if (!entry || entry.schema !== SCHEMA_VERSION || typeof entry.sessionId !== 'string' || !['file', 'barrier'].includes(entry.kind) || !['applied', 'undone'].includes(entry.state)) return false;
  if (entry.kind === 'barrier') return true;
  return typeof entry.projectRoot === 'string' && entry.projectRoot.length > 0 && typeof entry.path === 'string' && entry.path.length > 0 && validSnapshot(entry.before, true) && validSnapshot(entry.after, false);
}
function validSnapshot(value, withContent) {
  if (!value || typeof value.exists !== 'boolean') return false;
  if (!value.exists) return value.hash === null;
  if (typeof value.hash !== 'string' || !SHA256_HEX.test(value.hash)) return false;
  return !withContent || typeof value.contentBase64 === 'string';
}
function publicEntry(entry) { return { id: entry.id, executionId: entry.executionId, tool: entry.tool, kind: entry.kind, state: entry.state, path: entry.path ?? null, paths: entry.paths ?? [], createdAt: entry.createdAt }; }
function hash(value) { return createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).digest('hex'); }

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
