import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { checkTstSignal, tstOptions, waitForTst, withTstRequest } from './tst-request.mjs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export const WORKSPACE_TST_CAPABILITIES = [
  'context.prepare',
  'evidence.record',
  'graph.list',
  'graph.locate',
  'graph.query',
  'graph.refresh_paths',
  'graph.revision',
  'graph.workspace',
  'memory.forget',
  'memory.observe',
  'memory.query',
  'memory.remember',
  'turn.completed',
];

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.vscode',
  '.idea',
  'vendor',
  '.gemini',
  'coverage',
  '.cuppet',
  '.cuppet-desktop',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.ogg', '.m4a', '.webm',
  '.sqlite3', '.sqlite', '.db',
]);

const MAX_INDEXED_FILES = 5000;
// Handles for different projects share the global store. Lock the read/modify/rename
// transition by the canonical store path, including when the store does not exist yet.
const memoryStoreQueues = new Map();
let memoryStoreRegistration = Promise.resolve();
async function withMemoryStore(storeDir, operation) {
  if (!storeDir) throw new Error('Memory store is not configured');
  const registration = memoryStoreRegistration.then(async () => {
    let ancestor = resolve(storeDir);
    for (;;) {
      try { const actual = await realpath(ancestor); return join(actual, relative(ancestor, resolve(storeDir))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
    }
  });
  // Register before the next canonicalization can overtake us.
  const queued = registration.then((key) => {
    const prior = memoryStoreQueues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => operation(key));
    memoryStoreQueues.set(key, run);
    void run.then(() => { if (memoryStoreQueues.get(key) === run) memoryStoreQueues.delete(key); }, () => { if (memoryStoreQueues.get(key) === run) memoryStoreQueues.delete(key); });
    return { run };
  });
  memoryStoreRegistration = queued.then(() => undefined, () => undefined);
  return (await queued).run;
}

export class WorkspaceTstHandle {
  #projectRoot;
  #projectKey;
  #projectStore;
  #globalStore;
  #sessionMemories = new Map();
  #cachedFiles = null;
  #cacheTimestamp = 0;
  #indexCapped = false;
  #memoryQueue = Promise.resolve();

  constructor({ projectRoot, projectKey = null, projectStore = null, globalStore = null } = {}) {
    if (!projectRoot) throw new Error('WorkspaceTstHandle requires projectRoot');
    this.#projectRoot = resolve(projectRoot);
    this.#projectKey = projectKey ?? createHash('sha256').update(this.#projectRoot).digest('hex');
    this.#projectStore = projectStore ? resolve(projectStore) : null;
    this.#globalStore = globalStore ? resolve(globalStore) : null;
  }

  get configured() { return true; }
  get status() {
    return {
      configured: true,
      protocol: 'cuppet.tst.v3',
      running: true,
      connected: true,
      capabilities: [...WORKSPACE_TST_CAPABILITIES],
      starts: 1,
      lastError: null,
      projectKey: this.#projectKey,
      mode: 'workspace-fallback',
    };
  }

  supports(capability, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    return WORKSPACE_TST_CAPABILITIES.includes(capability);
  }

  async call(method, params = {}, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    return withTstRequest(options, () => this.#dispatch(method, params));
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'graph.revision':
        return this.graphRevision();
      case 'graph.workspace':
        return this.graphWorkspace(params.limit, params.offset);
      case 'graph.list':
        return this.graphList(params.prefix, params.limit, params.offset);
      case 'graph.locate':
        return this.graphLocate(params.pattern, params.prefix, params.limit);
      case 'graph.query':
        return this.graphQuery(params.query, params.prefix, params.limit);
      case 'graph.trace_summary':
        return this.graphTraceSummary(params.query, params.direction, params.depth, params.limit);
      case 'graph.refresh_paths':
        return this.refreshGraphPaths(params.paths);
      case 'memory.query':
        return this.queryMemory(params.session_id, params.query, params.limit);
      case 'memory.remember':
        return this.rememberMemory(params.session_id, params);
      case 'memory.forget':
        if (params.clear_scope) return this.clearMemory(params.session_id, params.clear_scope);
        return this.forgetMemory(params.session_id, params.key);
      case 'memory.observe':
        return this.observeMemory(params.session_id, params);
      case 'evidence.record':
        return this.recordEvidence(params.session_id, params.memory_id, params.kind, params.reference, params.success, params.content_hash);
      case 'context.prepare':
        return this.prepareContext(params.session_id, params.query, params.hints, params.observations, params.mode, params.projection_budget);
      case 'stm.refresh':
        return this.refreshStm(params);
      case 'turn.completed':
        return this.turnCompleted(params.session_id);
      case 'shutdown':
        return { ok: true };
      default:
        throw new Error(`Workspace TST fallback does not implement method ${method}`);
    }
  }

  async graphWorkspace(limit = 100, offset = 0, options = {}) {
    if (offset && typeof offset === 'object') { options = offset; offset = 0; }
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    const { files, capped } = await this.#scanFiles('', signal);
    checkTstSignal(signal);
    const clampedLimit = clamp(Number(limit) || 100, 1, 512);
    return {
      root: this.#projectRoot,
      graph: {
        files: files.length,
        symbols: 0,
        edges: 0,
        ...(capped ? { truncated: true } : {}),
      },
      ...pageMetadata(files.length, offset, clampedLimit),
      files: files.slice(pageOffset(offset), pageOffset(offset) + clampedLimit),
    };
  }

  async graphList(prefix, limit = 100, offset = 0, options = {}) {
    if (offset && typeof offset === 'object') { options = offset; offset = 0; }
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
    const { files, capped } = await this.#scanFiles(cleanPrefix, signal);
    checkTstSignal(signal);
    const filtered = cleanPrefix
      ? files.filter((path) => path === cleanPrefix || path.startsWith(`${cleanPrefix}/`))
      : files;
    const clampedLimit = clamp(Number(limit) || 100, 1, 512);
    return {
      prefix: cleanPrefix,
      total: filtered.length,
      ...pageMetadata(filtered.length, offset, clampedLimit),
      paths: filtered.slice(pageOffset(offset), pageOffset(offset) + clampedLimit),
      ...(capped ? { truncated: true } : {}),
    };
  }

  async graphRevision(options = {}) {
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    this.#cachedFiles = null;
    const { files, capped } = await this.#scanFiles('', signal);
    if (capped) return { revision: null, indexing_complete: false };
    const digest = createHash('sha256').update(this.#projectRoot);
    for (const path of files) {
      checkTstSignal(signal);
      const metadata = await stat(resolve(this.#projectRoot, path), { bigint: true }).catch(() => null);
      digest.update(JSON.stringify([path, metadata?.dev?.toString(), metadata?.ino?.toString(), metadata?.size?.toString(), metadata?.mtimeNs?.toString(), metadata?.ctimeNs?.toString()]));
    }
    return { revision: digest.digest('hex'), indexing_complete: true };
  }

  async searchWorkspace(query, prefix, limit = 12, offset = 0, { caseSensitive = true, resolveTargets = null, authorizeRead = async () => {}, signal } = {}) {
    signal ??= tstOptions().signal; checkTstSignal(signal);
    const needle = String(query ?? '');
    if (!needle || /[\r\n]/.test(needle)) throw new Error('query must be a non-empty, single-line literal');
    const { files, capped } = await this.#scanFiles(prefix, signal);
    const start = pageOffset(offset); const count = clamp(limit, 1, 512);
    const matches = []; let total = 0; let targetLimitReached = false;
    const rootReal = await realpath(this.#projectRoot);
    const searched = caseSensitive ? needle : needle.toLowerCase();
    for (const path of files) {
      if (signal?.aborted) { const error = new Error('Generation stopped'); error.name = 'AbortError'; throw error; }
      if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      const absolute = await realpath(resolve(this.#projectRoot, path)).catch(() => null);
      if (!absolute || !isInside(rootReal, absolute)) continue;
      let raw;
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        await authorizeRead(path, relative(rootReal, absolute).replaceAll('\\', '/'));
        if (signal?.aborted) { const error = new Error('Generation stopped'); error.name = 'AbortError'; throw error; }
        raw = await readFile(absolute, 'utf8');
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (raw.includes('\0') || !(caseSensitive ? raw : raw.toLowerCase()).includes(searched)) continue;
      if (resolveTargets) {
        const result = await resolveTargets(path, needle, hashSource(raw), 64);
        targetLimitReached ||= (result?.matches ?? []).length >= 64;
        for (const target of result?.matches ?? []) {
          if (target.symbol !== needle || target.path !== path || !target.target_id) continue;
          if (total >= start && matches.length < count) matches.push({
            path, line: target.start_row + 1, column: target.start_column + 1,
            kind: target.kind, symbol: target.symbol, target,
          });
          total++;
        }
      } else {
        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const column = (caseSensitive ? lines[index] : lines[index].toLowerCase()).indexOf(searched);
          if (column < 0) continue;
          if (total >= start && matches.length < count) matches.push({ path, line: index + 1, column: column + 1, kind: 'text', symbol: needle, text: lines[index].slice(0, 500) });
          total++;
        }
      }
    }
    return { query: needle, total, matches, ...pageMetadata(total, start, count), ...(capped || targetLimitReached ? { truncated: true } : {}) };
  }

  async graphLocate(pattern, prefix, limit = 12, options = {}) {
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    const query = String(pattern ?? '').trim();
    const clampedLimit = clamp(Number(limit) || 12, 1, 12);
    if (!query) return { query, matches: [] };

    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
    const { files } = await this.#scanFiles(cleanPrefix, signal);
    checkTstSignal(signal);
    const candidates = cleanPrefix
      ? files.filter((path) => path === cleanPrefix || path.startsWith(`${cleanPrefix}/`))
      : files;

    const matches = [];
    const lowerQuery = query.toLowerCase();

    // 1. Filename match
    for (const relativePath of candidates) {
      const base = basename(relativePath);
      if (base.toLowerCase().includes(lowerQuery)) {
        matches.push({
          path: relativePath,
          line: 1,
          column: 1,
          kind: 'file',
          symbol: base,
          name: base,
        });
        if (matches.length >= clampedLimit) break;
      }
    }

    // 2. File content search in non-binary files
    if (matches.length < clampedLimit) {
      for (const relativePath of candidates) {
        checkTstSignal(signal);
        if (matches.length >= clampedLimit) break;
        const ext = extname(relativePath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const fullPath = resolve(this.#projectRoot, relativePath);
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > 1024 * 1024) continue;
          const raw = await readFile(fullPath, 'utf8');
          if (!raw.toLowerCase().includes(lowerQuery)) continue;

          const lines = raw.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const colIndex = line.toLowerCase().indexOf(lowerQuery);
            if (colIndex !== -1) {
              matches.push({
                path: relativePath,
                line: i + 1,
                column: colIndex + 1,
                kind: 'text',
                symbol: query,
                name: query,
              });
              if (matches.length >= clampedLimit) break;
            }
          }
        } catch {}
      }
    }

    return {
      query,
      matches: matches.slice(0, clampedLimit),
    };
  }

  async graphQuery(query, prefix, limit = 12, options = {}) {
    return this.graphLocate(query, prefix, limit, options);
  }

  async graphTraceSummary(query, direction = 'both', depth = 2, limit = 12, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    return {
      query: String(query ?? ''),
      direction: ['callers', 'callees', 'both'].includes(direction) ? direction : 'both',
      depth: clamp(Number(depth) || 2, 1, 4),
      edges: [],
      unsupported: 'Call-graph tracing needs the native TST daemon; this workspace uses the text-search fallback, so an empty result means "unknown", not "no callers". Use tst_explore mode=search for references and tst_read to inspect call sites.',
    };
  }

  async refreshGraphPaths(paths, options = {}) {
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    this.#cachedFiles = null;
    const requested = [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 1024)))].slice(0, 64);
    const refreshed = [];
    for (const relativePath of requested) {
      checkTstSignal(signal);
      const fullPath = resolve(this.#projectRoot, relativePath);
      let hash = null;
      try {
        const raw = await readFile(fullPath);
        hash = createHash('sha256').update(raw).digest('hex');
      } catch {}
      refreshed.push({ path: relativePath, content_hash: hash });
    }
    return { paths: refreshed };
  }

  graphRefreshPaths(paths) {
    return this.refreshGraphPaths(paths);
  }

  async resolveEditTargets(path, query, expectedHash, limit = 12, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    throw new Error('Connected TST daemon does not support revision-bound edit targets.');
  }

  async parseStaged(path, baseHash, content, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    throw new Error('Connected TST daemon does not support staged parsing.');
  }

  async queryMemory(sessionId, query, limit = 20, options = {}) {
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    const maxLimit = clamp(Number(limit) || 20, 1, 40);
    const needle = String(query ?? '').trim().toLowerCase();
    const allRecords = await waitForTst(this.#memoryRecords(sessionId), signal);

    const seenKeys = new Set();

    const unique = [];
    for (const rec of allRecords) {
      if (!rec?.key || seenKeys.has(rec.key)) continue;
      seenKeys.add(rec.key);
      unique.push(rec);
    }

    const filtered = needle
      ? unique.filter((r) => r.key.toLowerCase().includes(needle) || r.value.toLowerCase().includes(needle))
      : unique;

    filtered.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });

    return Promise.all(filtered.slice(0, maxLimit).map((record) => this.#freshMemory(record, signal)));
  }

  rememberMemory(sessionId, input = {}, options = {}) { return withTstRequest(options, () => this.#serialMemory(() => this.#rememberMemory(sessionId, input))); }
  forgetMemory(sessionId, key, options = {}) { return withTstRequest(options, () => this.#serialMemory(() => this.#forgetMemory(sessionId, key))); }
  clearMemory(sessionId, scope = 'session', options = {}) { return withTstRequest(options, () => this.#serialMemory(() => this.#clearMemory(sessionId, scope))); }
  #serialMemory(task) {
    const run = this.#memoryQueue.then(task, task);
    this.#memoryQueue = run.then(() => undefined, () => undefined);
    return waitForTst(run, tstOptions().signal);
  }

  async #rememberMemory(sessionId, { key, value, scope = 'project', pinned = false, fileHashes, file_hashes = {} } = {}) {
    const normalizedScope = normalizeMemoryScope(scope);
    const recordKey = String(key ?? '').slice(0, 240);
    const recordValue = String(value ?? '').slice(0, 4000);
    if (!recordKey.trim() || !recordValue.trim()) throw new Error('Memory key and value are required');
    if (normalizedScope === 'session' && !sessionId) throw new Error('Session memory requires a session ID');
    checkTstSignal(tstOptions().signal);
    const memoryRecord = {
      id: `mem-${randomBytes(8).toString('hex')}`,
      key: recordKey,
      value: recordValue,
      scope: normalizedScope,
      pinned: Boolean(pinned),
      file_hashes: boundedHashes(fileHashes ?? file_hashes),
      file_project_key: this.#projectKey,
      evidence: [],
      createdAt: Date.now(),
    };

    if (normalizedScope === 'session') {
      if (sessionId) {
        let sessionMap = this.#sessionMemories.get(sessionId);
        if (!sessionMap) { sessionMap = new Map(); this.#sessionMemories.set(sessionId, sessionMap); }
        sessionMap.delete(recordKey); sessionMap.set(recordKey, memoryRecord);
      }
    } else {
      const store = normalizedScope === 'global' ? this.#globalStore : this.#projectStore;
      await withMemoryStore(store, async (canonical) => {
        const map = await this.#loadMemories(canonical);
        checkTstSignal(tstOptions().signal);
        map.delete(recordKey); map.set(recordKey, memoryRecord);
        await this.#saveMemories(canonical, map);
      });
    }
    return memoryRecord;
  }

  async #forgetMemory(sessionId, key) {
    checkTstSignal(tstOptions().signal);
    const targetKey = String(key ?? '').slice(0, 240);
    if (sessionId && this.#sessionMemories.has(sessionId)) {
      this.#sessionMemories.get(sessionId).delete(targetKey);
    }
    for (const store of new Set([this.#projectStore, this.#globalStore].filter(Boolean))) {
      await withMemoryStore(store, async (canonical) => {
        const map = await this.#loadMemories(canonical);
        if (map.delete(targetKey)) await this.#saveMemories(canonical, map);
      });
    }
    return { forgotten: true };
  }

  async #clearMemory(sessionId, scope = 'session') {
    checkTstSignal(tstOptions().signal);
    const normalized = normalizeMemoryScope(scope);
    if (normalized === 'session' && sessionId) {
      this.#sessionMemories.delete(sessionId);
    } else if (normalized !== 'session') {
      const store = normalized === 'global' ? this.#globalStore : this.#projectStore;
      await withMemoryStore(store, (canonical) => this.#saveMemories(canonical, new Map()));
    }
    return { cleared: true };
  }

  async #memoryRecords(sessionId) {
    checkTstSignal(tstOptions().signal);
    const records = [...(this.#sessionMemories.get(sessionId)?.values() ?? [])];
    for (const store of new Set([this.#projectStore, this.#globalStore].filter(Boolean))) {
      const map = await withMemoryStore(store, (canonical) => this.#loadMemories(canonical));
      records.push(...map.values());
    }
    return records;
  }

  async #freshMemory(record, signal) {
    checkTstSignal(signal);
    let stale = record.stale === true;
    const hashes = Object.entries(record.file_hashes ?? {});
    if (hashes.length && record.file_project_key && record.file_project_key !== this.#projectKey) stale = true;
    const root = await realpath(this.#projectRoot);
    for (const [path, expected] of hashes.slice(0, 64)) {
      checkTstSignal(signal);
      const normalized = normalizePrefix(path);
      if (!normalized || normalized !== path.replaceAll('\\', '/')) { stale = true; break; }
      try {
        const canonical = await realpath(resolve(root, path));
        if (!isInside(root, canonical)) { stale = true; break; }
        const metadata = await stat(canonical);
        if (!metadata.isFile() || metadata.size > 1024 * 1024 || hashSource(await readFile(canonical, { signal })) !== expected) { stale = true; break; }
      } catch (error) { checkTstSignal(signal); stale = true; break; }
    }
    const evidence = (Array.isArray(record.evidence) ? record.evidence : []).slice(-16);
    return { ...record, stale, evidence, verified: !stale && evidence.at(-1)?.success === true };
  }

  async observeMemory(sessionId, observation, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    if (!observation || typeof observation.key !== 'string' || typeof observation.value !== 'string') return { observed: false };
    // Observations are session continuity, never implicitly promoted to shared memory.
    const record = await this.rememberMemory(sessionId, { ...observation, scope: 'session' }, tstOptions(options));
    return { observed: true, id: record.id };
  }

  recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash, options = {}) {
    const signal = tstOptions(options).signal;
    return this.#serialMemory(async () => {
      checkTstSignal(signal);
      const append = (record) => ({ ...record, evidence: [...(record.evidence ?? []).slice(-15), {
        kind: String(kind ?? '').slice(0, 100), reference: String(reference ?? '').slice(0, 500),
        success: success === true, timestamp_ms: Date.now(), ...(contentHash ? { content_hash: String(contentHash).slice(0, 128) } : {}),
      }] });
      const session = this.#sessionMemories.get(sessionId);
      for (const [key, record] of session ?? []) if (record.id === memoryId) {
        checkTstSignal(signal); session.set(key, append(record)); return { recorded: true };
      }
      for (const store of new Set([this.#projectStore, this.#globalStore].filter(Boolean))) {
        const recorded = await withMemoryStore(store, async (canonical) => {
          const map = await this.#loadMemories(canonical);
          for (const [key, record] of map) if (record.id === memoryId) {
            checkTstSignal(signal); map.set(key, append(record)); await this.#saveMemories(canonical, map); return true;
          }
          return false;
        });
        if (recorded) return { recorded: true };
      }
      return { recorded: false, reason: 'memory_not_found' };
    });
  }

  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0, options = {}) {
    const signal = tstOptions(options).signal; checkTstSignal(signal);
    for (const observation of (Array.isArray(observations) ? observations : []).slice(0, 32)) {
      await this.observeMemory(sessionId, observation, { signal });
    }
    const terms = [...new Set((String(query ?? '').slice(0, 6000) + ' ' + (Array.isArray(hints) ? hints.slice(0, 32).join(' ') : '')).toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])].slice(0, 64);
    const scored = (await waitForTst(this.#memoryRecords(sessionId), signal)).filter((record) => !record.key.startsWith('user_message:')).map((record) => ({
      record, score: (record.pinned ? 2 : 0) + terms.filter((term) => (record.key + ' ' + record.value).toLowerCase().includes(term)).length,
    })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || (b.record.createdAt ?? 0) - (a.record.createdAt ?? 0));
    const memories = []; const keys = new Set(); let bytes = 0;
    for (const { record } of scored.slice(0, 64)) {
      checkTstSignal(signal);
      if (keys.has(record.key)) continue;
      const fresh = await this.#freshMemory(record, signal);
      if (fresh.stale || fresh.evidence.at(-1)?.success === false) continue;
      const compact = { id: fresh.id, key: fresh.key, value: fresh.value.slice(0, 1200), scope: fresh.scope, stale: false, verified: fresh.verified };
      const size = Buffer.byteLength(JSON.stringify(compact));
      if (bytes + size > 6000) break;
      memories.push(compact); keys.add(record.key); bytes += size;
      if (memories.length >= 24) break;
    }
    // Fallback retrieval is incomplete continuity; it must never permit compaction.
    return { memories, stm: memories.filter((record) => record.scope === 'session'), ltm: memories.filter((record) => record.scope !== 'session'),
      observation_complete: false, mode: 'workspace-fallback', plan_projection: { complete: false, coverage: { indexing_complete: false } } };
  }

  async refreshStm() {
    throw new Error('Workspace TST fallback does not support structured STM refresh');
  }

  async turnCompleted(sessionId, options = {}) {
    checkTstSignal(tstOptions(options).signal);
    return { ok: true };
  }

  async close() {
    this.#sessionMemories.clear();
    this.#cachedFiles = null;
  }

  async #scanFiles(prefix = '', signal = tstOptions().signal) {
    checkTstSignal(signal);
    const cleanPrefix = normalizePrefix(prefix);
    if (cleanPrefix === null) return { files: [], capped: false };
    const now = Date.now();
    if (!cleanPrefix) {
      if (this.#cachedFiles && now - this.#cacheTimestamp < 3000) return { files: this.#cachedFiles, capped: this.#indexCapped };
      const files = [];
      await walkDir(this.#projectRoot, this.#projectRoot, files, MAX_INDEXED_FILES, signal);
      this.#indexCapped = files.length >= MAX_INDEXED_FILES;
      files.sort((a, b) => a.localeCompare(b));
      this.#cachedFiles = files;
      this.#cacheTimestamp = now;
      return { files, capped: this.#indexCapped };
    }
    // A prefix walks only that subtree, so it keeps working when the whole-repository index is capped.
    const startPath = resolve(this.#projectRoot, cleanPrefix);
    const rootReal = await realpath(this.#projectRoot).catch(() => resolve(this.#projectRoot));
    const startReal = await realpath(startPath).catch(() => null);
    if (!startReal || !isInside(rootReal, startReal)) return { files: [], capped: false };
    const info = await stat(startReal).catch(() => null);
    if (info?.isFile()) return { files: [cleanPrefix], capped: false };
    const files = [];
    await walkDir(this.#projectRoot, startPath, files, MAX_INDEXED_FILES, signal);
    files.sort((a, b) => a.localeCompare(b));
    return { files, capped: files.length >= MAX_INDEXED_FILES };
  }

  async #loadMemories(storeDir) {
    const filePath = join(storeDir, 'memory.json');
    let raw;
    try { raw = await readFile(filePath, { encoding: 'utf8', signal: tstOptions().signal }); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item.key !== 'string' || typeof item.value !== 'string')) throw new Error('Invalid memory file');
      return new Map(parsed.map((item) => [item.key, item]));
    } catch {
      // Quarantine must succeed before a replacement is allowed to overwrite the store.
      await rename(filePath, `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`);
      return new Map();
    }
  }

  async #saveMemories(storeDir, memoryMap) {
    await mkdir(storeDir, { recursive: true });
    const filePath = join(storeDir, 'memory.json');
    const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try { checkTstSignal(tstOptions().signal); await writeFile(temp, JSON.stringify([...memoryMap.values()], null, 2), { encoding: 'utf8', signal: tstOptions().signal }); checkTstSignal(tstOptions().signal); await rename(temp, filePath); }
    catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
}

async function walkDir(rootDir, currentDir, accumulator, maxFiles, signal) {
  checkTstSignal(signal);
  if (accumulator.length >= maxFiles) return;
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (accumulator.length >= maxFiles) break;
    checkTstSignal(signal);
    const name = entry.name;
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;

    const fullPath = join(currentDir, name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name)) continue;   // '.git' is in the set; .github/.gitlab/etc. are ordinary source directories
      await walkDir(rootDir, fullPath, accumulator, maxFiles, signal);
    } else if (entry.isFile()) {
      const rel = relative(rootDir, fullPath).replaceAll('\\', '/');
      accumulator.push(rel);
    }
  }
}

function hashSource(text) { return createHash('sha256').update(text).digest('hex'); }
function pageOffset(value) {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  return offset;
}
function pageMetadata(total, offset, limit) {
  const start = pageOffset(offset);
  return { offset: start, next_offset: start + limit < total ? start + limit : null };
}
function normalizePrefix(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || text.includes('\0') || text.split('/').includes('..')) return null;
  return text;
}
function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function clamp(value, min, max) {
  const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : min;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeMemoryScope(value) {
  const scope = String(value ?? 'session').toLowerCase();
  return ['session', 'project', 'global'].includes(scope) ? scope : 'session';
}

function boundedHashes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .flatMap(([path, hash]) => typeof path === 'string' && typeof hash === 'string' ? [[path.slice(0, 512), hash.slice(0, 128)]] : [])
  );
}
