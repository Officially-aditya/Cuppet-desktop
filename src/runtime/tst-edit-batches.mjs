import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_BATCHES = 32;
const MAX_OPERATIONS = 64;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 96 * 1024;
const BATCH_TTL_MS = 30 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const STRUCTURAL_OPS = new Set(['replace_node', 'insert_before_node', 'insert_after_node', 'delete_node']);

export class TstBatchEditManager {
  #tst; #journal; #emit; #writer; #batches = new Map(); #graphStale = new Map();
  constructor({ tst, journal, writer = null, emit = () => {} }) {
    this.#tst = tst; this.#journal = journal; this.#writer = writer; this.#emit = emit;
    const recovery = this.#journal?.ready?.();
    if (recovery && typeof recovery.then === 'function') {
      void recovery.then((report) => this.#emitRecovery(report)).catch(() => undefined);
    }
  }

  async resolveTargets({ path, query, expectedHash, limit = 12 }) {
    return this.#tst.resolveEditTargets(path, query, expectedHash, limit);
  }

  async ensureGraphFresh(projectRoot) {
    const root = await canonicalRoot(projectRoot);
    const stale = this.#graphStale.get(root);
    if (!stale?.length) return { ready: true };
    try {
      const expected = new Map();
      for (const path of stale) {
        const target = await resolveWorkspacePath(root, path, true);
        const current = await snapshotBytes(target.absolute);
        if (!current.exists || !current.hash) {
          return { ready: false, reason: `TST graph refresh is required before another structural operation: current file is unavailable for ${path}` };
        }
        expected.set(path, current.hash);
      }
      const refresh = await this.#tst.refreshGraphPaths(stale);
      const returned = new Map((refresh?.paths ?? []).map((item) => [String(item.path), item.content_hash ?? null]));
      const mismatches = stale.filter((path) => !returned.has(path) || returned.get(path) !== expected.get(path));
      if (mismatches.length) {
        return { ready: false, reason: `TST graph refresh is required before another structural operation: refresh did not acknowledge current hashes for ${mismatches.join(', ')}` };
      }
      this.#graphStale.delete(root);
      return { ready: true, recovered: true, refresh };
    } catch (error) {
      return { ready: false, reason: `TST graph refresh is required before another structural operation: ${cleanError(error)}` };
    }
  }

  async prepare({ sessionId, projectRoot, operations }) {
    if (!this.#tst?.configured) throw new Error('tst_edit_batch requires TST to be configured.');
    const freshness = await this.ensureGraphFresh(projectRoot);
    if (!freshness.ready) throw new Error(freshness.reason);
    const requested = normalizeOperations(operations);
    if (!requested.length) throw new Error('operations must contain at least one edit');
    if (requested.length > MAX_OPERATIONS) throw new Error(`Batch exceeds ${MAX_OPERATIONS} operation limit`);

    const root = await canonicalRoot(projectRoot);
    const files = new Map();
    const conflicts = [];
    for (let index = 0; index < requested.length; index++) {
      const operation = requested[index];
      try {
        await stageOperation({ root, operation, index, files });
      } catch (error) {
        conflicts.push({ index, op: operation.op, path: operation.path ?? operation.target?.path ?? null, error: cleanError(error) });
      }
    }
    if (conflicts.length) throw batchConflict('Batch target validation failed; nothing was written.', conflicts);
    if (files.size > MAX_FILES) throw new Error(`Batch exceeds ${MAX_FILES} file limit`);

    const stagedFiles = [];
    const parseFailures = [];
    for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        finalizeFileEdits(file);
        if (file.after.length > MAX_FILE_BYTES) throw new Error(`staged file exceeds ${MAX_FILE_BYTES} byte limit`);
        const parse = await this.#tst.parseStaged(file.path, file.exists ? file.baseHash : null, file.after.toString('utf8'));
        file.parse = parse;
        if (parse.supported && Number(parse.introduced_syntax_errors || 0) > 0) {
          parseFailures.push({ path: file.path, introduced: parse.introduced_syntax_errors, base: parse.base_diagnostics ?? [], staged: parse.staged_diagnostics ?? [] });
        }
        stagedFiles.push(file);
      } catch (error) {
        parseFailures.push({ path: file.path, error: cleanError(error) });
      }
    }
    if (parseFailures.length) throw batchConflict('Staged parse validation failed; nothing was written.', parseFailures);

    const diff = renderBatchDiff(stagedFiles);
    const diffDigest = sha256(Buffer.from(diff, 'utf8'));
    const id = `batch_${randomUUID()}`;
    const batch = {
      id, sessionId, projectRoot: root, createdAt: Date.now(), expiresAt: Date.now() + BATCH_TTL_MS,
      diffDigest, diff, operations: requested, files: stagedFiles.map(serializeStagedFile), state: 'prepared',
    };
    this.#remember(batch);
    this.#emit({ type: 'edit.batch.prepared', sessionId, batchId: id, paths: batch.files.map((file) => file.path), diffDigest });
    return publicBatch(batch);
  }

  async apply({ batchId, sessionId, projectRoot, executionId, authorize }) {
    const batch = this.#require(batchId, sessionId, projectRoot);
    if (batch.state !== 'prepared') throw new Error(`Batch ${batchId} is not prepared`);
    return this.#withWriter(batch.projectRoot, async () => {
      const freshBatch = this.#require(batchId, sessionId, projectRoot);
      const paths = freshBatch.files.map((file) => file.path);
      await authorize({
        action: 'edit', resources: paths,
        description: `Apply checked TST batch ${batchId} (${freshBatch.diffDigest.slice(0, 12)}): ${paths.join(', ')}`,
        fingerprintKey: `tst-batch:${batchId}:${freshBatch.diffDigest}`,
      });

      const conflicts = [];
      for (const file of freshBatch.files) {
        const target = await resolveWorkspacePath(freshBatch.projectRoot, file.path, false);
        const current = await snapshotBytes(target.absolute);
        if (file.exists) {
          if (!current.exists || current.hash !== file.baseHash) conflicts.push({ path: file.path, expected: file.baseHash, actual: current.hash, reason: 'base file changed after prepare' });
        } else if (current.exists) {
          conflicts.push({ path: file.path, reason: 'file was created externally after prepare' });
        }
      }
      if (conflicts.length) throw batchConflict('Batch became stale before apply; nothing was written.', conflicts);

      const journalToken = await this.#journal.beginBatch({
        sessionId,
        executionId,
        tool: 'tst_edit_batch',
        projectRoot: freshBatch.projectRoot,
        paths,
        expectedAfter: freshBatch.files.map((file) => ({ path: file.path, exists: true, hash: file.afterHash })),
      });
      const published = [];
      try {
        for (const file of freshBatch.files) {
          const target = await resolveWorkspacePath(freshBatch.projectRoot, file.path, false);
          await atomicPublish(target.absolute, Buffer.from(file.afterBase64, 'base64'), file.mode);
          published.push({ file, target });
          const after = await snapshotBytes(target.absolute);
          if (!after.exists || after.hash !== file.afterHash) throw new Error(`post-write hash mismatch for ${file.path}`);
        }
        await this.#journal.commitBatch(journalToken);
      } catch (error) {
        let rollbackClean = true;
        for (const record of published.reverse()) {
          const before = journalToken.files.find((item) => item.path === record.file.path)?.before;
          if (!before) continue;
          try { await restoreSnapshot(record.target.absolute, before); }
          catch { rollbackClean = false; }
        }
        if (rollbackClean) await this.#journal.abortBatch?.(journalToken).catch(() => undefined);
        throw new Error(`Batch publish failed and was recovered where hash-safe: ${cleanError(error)}`);
      }

      freshBatch.state = 'applied'; freshBatch.appliedAt = Date.now();
      this.#batches.set(freshBatch.id, freshBatch);

      let refresh = null; let graphReady = true; let graphError = null;
      try {
        refresh = await this.#tst.refreshGraphPaths(paths);
        const returned = new Map((refresh?.paths ?? []).map((item) => [String(item.path), item.content_hash ?? null]));
        const mismatches = freshBatch.files.filter((file) => !returned.has(file.path) || returned.get(file.path) !== file.afterHash).map((file) => file.path);
        if (mismatches.length) {
          graphReady = false; graphError = `Graph refresh observed different post-edit hashes for: ${mismatches.join(', ')}`;
          this.#graphStale.set(freshBatch.projectRoot, paths);
        }
      } catch (error) {
        graphReady = false; graphError = cleanError(error); this.#graphStale.set(freshBatch.projectRoot, paths);
      }

      this.#emit({ type: 'edit.batch.applied', sessionId, batchId, paths, diffDigest: freshBatch.diffDigest, graphReady, graphError });
      return { ...publicBatch(freshBatch), applied: true, graphReady, graphError, refresh };
    });
  }

  get(batchId) {
    const batch = this.#batches.get(batchId); if (!batch) return null; return publicBatch(batch);
  }

  #require(batchId, sessionId, projectRoot) {
    this.#prune();
    const batch = this.#batches.get(String(batchId || ''));
    if (!batch) throw new Error(`Unknown or expired TST edit batch: ${batchId}`);
    if (batch.sessionId !== sessionId) throw new Error('TST edit batch belongs to a different session');
    const expected = resolve(projectRoot); const actual = resolve(batch.projectRoot);
    if (expected !== actual) throw new Error('TST edit batch belongs to a different project workspace');
    if (batch.expiresAt < Date.now()) { this.#batches.delete(batch.id); throw new Error(`TST edit batch expired: ${batch.id}`); }
    return batch;
  }

  #remember(batch) { this.#prune(); this.#batches.set(batch.id, batch); while (this.#batches.size > MAX_BATCHES) this.#batches.delete(this.#batches.keys().next().value); }
  #prune() { const now = Date.now(); for (const [id, batch] of this.#batches) if (batch.expiresAt < now) this.#batches.delete(id); }
  async #withWriter(root, fn) { return this.#writer?.withProject ? this.#writer.withProject(root, fn) : fn(); }

  #emitRecovery(report = {}) {
    for (const item of Array.isArray(report.recovered) ? report.recovered : []) {
      if (!item?.sessionId || !item?.mutationId) continue;
      this.#emit({
        type: 'mutation.recovered',
        sessionId: item.sessionId,
        mutationId: item.mutationId,
        restoredFiles: Number(item.restoredFiles) || 0,
      });
    }
    for (const item of Array.isArray(report.conflicts) ? report.conflicts : []) {
      if (!item?.sessionId || !item?.mutationId) continue;
      this.#emit({
        type: 'mutation.recovery.conflict',
        sessionId: item.sessionId,
        mutationId: item.mutationId,
        path: item.path ?? null,
        message: cleanError(item.error || 'Mutation recovery conflict'),
      });
    }
  }
}

async function stageOperation({ root, operation, index, files }) {
  if (STRUCTURAL_OPS.has(operation.op)) {
    const target = validateTarget(operation.target);
    const file = await ensureFile(root, target.path, files, { mustExist: true });
    if (file.baseHash !== target.base_hash) throw new Error(`stale target hash ${target.target_id}`);
    if (target.end_byte > file.before.length || target.start_byte > target.end_byte) throw new Error(`invalid target byte span ${target.target_id}`);
    const expected = Buffer.from(target.expected_source, 'utf8');
    if (!file.before.subarray(target.start_byte, target.end_byte).equals(expected)) throw new Error(`target source changed for ${target.target_id}`);
    let start = target.start_byte; let end = target.end_byte; let replacement;
    if (operation.op === 'replace_node') replacement = Buffer.from(String(operation.content ?? ''), 'utf8');
    else if (operation.op === 'delete_node') replacement = Buffer.alloc(0);
    else if (operation.op === 'insert_before_node') { start = target.start_byte; end = start; replacement = Buffer.from(String(operation.content ?? ''), 'utf8'); }
    else { start = target.end_byte; end = start; replacement = Buffer.from(String(operation.content ?? ''), 'utf8'); }
    addEdit(file, { index, start, end, replacement, description: `${operation.op}:${target.symbol}` });
    return;
  }
  if (operation.op === 'replace_text') {
    const file = await ensureFile(root, operation.path, files, { mustExist: true });
    if (operation.expected_hash && file.baseHash !== operation.expected_hash) throw new Error(`stale expected_hash for ${file.path}`);
    const needle = Buffer.from(String(operation.old_text ?? ''), 'utf8');
    if (!needle.length) throw new Error('replace_text old_text is required');
    const positions = allOccurrences(file.before, needle);
    if (positions.length !== 1) throw new Error(`replace_text matched ${positions.length} times; exactly one match is required inside a batch`);
    addEdit(file, { index, start: positions[0], end: positions[0] + needle.length, replacement: Buffer.from(String(operation.new_text ?? ''), 'utf8'), description: 'replace_text' });
    return;
  }
  if (operation.op === 'create_file') {
    const file = await ensureFile(root, operation.path, files, { mustExist: false });
    if (file.exists) throw new Error(`create_file target already exists: ${file.path}`);
    if (file.edits.length) throw new Error(`multiple create operations for ${file.path}`);
    addEdit(file, { index, start: 0, end: 0, replacement: Buffer.from(String(operation.content ?? ''), 'utf8'), description: 'create_file' });
    return;
  }
  throw new Error(`unsupported batch operation: ${operation.op}`);
}

async function ensureFile(root, path, files, { mustExist }) {
  const resolved = await resolveWorkspacePath(root, path, mustExist);
  if (files.has(resolved.relative)) {
    const prior = files.get(resolved.relative);
    if (prior.exists !== mustExist) throw new Error(`conflicting existence assumptions for ${resolved.relative}`);
    return prior;
  }
  const snapshot = await snapshotBytes(resolved.absolute);
  if (mustExist && !snapshot.exists) throw new Error(`file does not exist: ${resolved.relative}`);
  if (!mustExist && snapshot.exists) throw new Error(`file already exists: ${resolved.relative}`);
  const mode = snapshot.exists ? (await stat(resolved.absolute)).mode : 0o644;
  const file = { path: resolved.relative, absolute: resolved.absolute, exists: snapshot.exists, before: snapshot.exists ? snapshot.content : Buffer.alloc(0), baseHash: snapshot.hash, mode, edits: [], after: null, afterHash: null, parse: null };
  files.set(resolved.relative, file); return file;
}

function addEdit(file, edit) {
  if (edit.replacement.length > MAX_FILE_BYTES) throw new Error(`replacement is too large for ${file.path}`);
  for (const prior of file.edits) {
    if (rangesConflict(prior, edit)) throw new Error(`overlapping/ambiguous operations in ${file.path}: #${prior.index} and #${edit.index}`);
  }
  file.edits.push(edit);
}

function rangesConflict(left, right) {
  if (left.start === left.end && right.start === right.end) return left.start === right.start;
  if (left.start === left.end) return left.start >= right.start && left.start <= right.end;
  if (right.start === right.end) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function finalizeFileEdits(file) {
  const edits = [...file.edits].sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index);
  let output = Buffer.from(file.before);
  for (const edit of edits) output = Buffer.concat([output.subarray(0, edit.start), edit.replacement, output.subarray(edit.end)]);
  file.after = output; file.afterHash = sha256(output);
}

function serializeStagedFile(file) {
  return { path: file.path, exists: file.exists, baseHash: file.baseHash, afterHash: file.afterHash, afterBase64: file.after.toString('base64'), mode: file.mode, parse: file.parse };
}

function publicBatch(batch) {
  return { id: batch.id, state: batch.state, sessionId: batch.sessionId, paths: batch.files.map((file) => file.path), diffDigest: batch.diffDigest, diff: batch.diff, createdAt: batch.createdAt, expiresAt: batch.expiresAt, files: batch.files.map((file) => ({ path: file.path, baseHash: file.baseHash, afterHash: file.afterHash, parse: file.parse })) };
}

function renderBatchDiff(files) {
  const chunks = [];
  for (const file of files) {
    const before = file.before.toString('utf8'); const after = file.after.toString('utf8');
    chunks.push(`--- a/${file.path}\n+++ b/${file.path}\n@@ checked whole-file projection @@\n${renderLines(before, '-')}${renderLines(after, '+')}`);
  }
  return capText(chunks.join('\n'), MAX_DIFF_BYTES);
}
function renderLines(text, prefix) { return text.split(/(?<=\n)/).slice(0, 400).map((line) => `${prefix}${line}`).join(''); }

async function atomicPublish(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Date.now().toString(36)}.${randomUUID()}.cuppet-tmp`);
  try { await writeFile(temp, content, { mode: mode & 0o777 }); await rename(temp, path); }
  catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
}
async function restoreSnapshot(path, snapshot) {
  if (snapshot.exists) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(snapshot.contentBase64, 'base64')); }
  else await rm(path, { force: true });
}
async function snapshotBytes(path) {
  try {
    const metadata = await stat(path); if (!metadata.isFile()) throw new Error('batch target must be a regular file');
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte batch limit`);
    const content = await readFile(path); return { exists: true, hash: sha256(content), content };
  } catch (error) { if (error?.code === 'ENOENT') return { exists: false, hash: null, content: Buffer.alloc(0) }; throw error; }
}

async function resolveWorkspacePath(projectRoot, resource, mustExist) {
  const root = await canonicalRoot(projectRoot); const raw = String(resource ?? '').trim();
  if (!raw || raw.includes('\0') || raw.startsWith('~') || raw.startsWith('file:')) throw new Error('Invalid batch path');
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (candidate === root || !isAtOrInside(root, candidate)) throw new Error('Batch path escapes the project workspace');
  if (mustExist) {
    const actual = await realpath(candidate); if (!isAtOrInside(root, actual)) throw new Error('Batch path resolves outside the project workspace');
  } else {
    let ancestor = candidate;
    for (;;) {
      try { const actual = await realpath(ancestor); if (!isAtOrInside(root, actual)) throw new Error('Batch path ancestor resolves outside the project workspace'); break; }
      catch (error) { if (String(error?.message).includes('outside')) throw error; if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
    }
  }
  return { root, absolute: candidate, relative: relative(root, candidate).replaceAll('\\', '/') };
}
async function canonicalRoot(root) { return realpath(root).catch(() => resolve(root)); }
function isAtOrInside(root, candidate) { const path = relative(root, candidate); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function validateTarget(value) {
  if (!value || typeof value !== 'object') throw new Error('structural operation requires target');
  const target = { target_id: String(value.target_id ?? ''), path: String(value.path ?? ''), symbol: String(value.symbol ?? ''), kind: String(value.kind ?? ''), base_hash: String(value.base_hash ?? ''), start_byte: Number(value.start_byte), end_byte: Number(value.end_byte), expected_source: String(value.expected_source ?? '') };
  if (!target.target_id.startsWith('tst:') || !target.path || !SHA256_HEX.test(target.base_hash) || !Number.isSafeInteger(target.start_byte) || !Number.isSafeInteger(target.end_byte) || target.start_byte < 0 || target.end_byte < target.start_byte) throw new Error('invalid revision-bound TST target');
  return target;
}
function normalizeOperations(values) {
  return (Array.isArray(values) ? values : []).map((value) => value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : { op: '' });
}
function allOccurrences(buffer, needle) { const output = []; let offset = 0; for (;;) { const index = buffer.indexOf(needle, offset); if (index < 0) break; output.push(index); offset = index + Math.max(1, needle.length); } return output; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function capText(value, maxBytes) { const buffer = Buffer.from(String(value), 'utf8'); return buffer.length <= maxBytes ? buffer.toString('utf8') : `${buffer.subarray(0, maxBytes).toString('utf8')}\n…[truncated]`; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
function batchConflict(message, conflicts) { const error = new Error(`${message}\n${JSON.stringify(conflicts.slice(0, 64), null, 2)}`); error.name = 'TstBatchConflictError'; error.conflicts = conflicts; return error; }
