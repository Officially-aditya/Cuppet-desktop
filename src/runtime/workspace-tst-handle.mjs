import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export const WORKSPACE_TST_CAPABILITIES = [
  'context.prepare',
  'evidence.record',
  'graph.list',
  'graph.locate',
  'graph.query',
  'graph.refresh_paths',
  'graph.trace_summary',
  'graph.workspace',
  'memory.forget',
  'memory.observe',
  'memory.query',
  'memory.remember',
  'stm.refresh',
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

  supports(capability) {
    return WORKSPACE_TST_CAPABILITIES.includes(capability);
  }

  async call(method, params = {}) {
    switch (method) {
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

  async graphWorkspace(limit = 100, offset = 0) {
    const { files, capped } = await this.#scanFiles();
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

  async graphList(prefix, limit = 100, offset = 0) {
    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
    const { files, capped } = await this.#scanFiles(cleanPrefix);
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

  async searchWorkspace(query, prefix, limit = 12, offset = 0, { caseSensitive = true, resolveTargets = null, authorizeRead = async () => {}, signal } = {}) {
    const needle = String(query ?? '');
    if (!needle || /[\r\n]/.test(needle)) throw new Error('query must be a non-empty, single-line literal');
    const { files, capped } = await this.#scanFiles(prefix);
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

  async graphLocate(pattern, prefix, limit = 12) {
    const query = String(pattern ?? '').trim();
    const clampedLimit = clamp(Number(limit) || 12, 1, 12);
    if (!query) return { query, matches: [] };

    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
    const { files } = await this.#scanFiles(cleanPrefix);
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

  async graphQuery(query, prefix, limit = 12) {
    return this.graphLocate(query, prefix, limit);
  }

  async graphTraceSummary(query, direction = 'both', depth = 2, limit = 12) {
    return {
      query: String(query ?? ''),
      direction: ['callers', 'callees', 'both'].includes(direction) ? direction : 'both',
      depth: clamp(Number(depth) || 2, 1, 4),
      edges: [],
      unsupported: 'Call-graph tracing needs the native TST daemon; this workspace uses the text-search fallback, so an empty result means "unknown", not "no callers". Use tst_explore mode=search for references and tst_read to inspect call sites.',
    };
  }

  async refreshGraphPaths(paths) {
    this.#cachedFiles = null;
    const requested = [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 1024)))].slice(0, 64);
    const refreshed = [];
    for (const relativePath of requested) {
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

  async resolveEditTargets(path, query, expectedHash, limit = 12) {
    throw new Error('Connected TST daemon does not support revision-bound edit targets.');
  }

  async parseStaged(path, baseHash, content) {
    throw new Error('Connected TST daemon does not support staged parsing.');
  }

  async queryMemory(sessionId, query, limit = 20) {
    const maxLimit = clamp(Number(limit) || 20, 1, 40);
    const needle = String(query ?? '').trim().toLowerCase();
    const allRecords = [];

    if (sessionId && this.#sessionMemories.has(sessionId)) {
      allRecords.push(...this.#sessionMemories.get(sessionId).values());
    }

    if (this.#projectStore) {
      const map = await withMemoryStore(this.#projectStore, (store) => this.#loadMemories(store));
      allRecords.push(...map.values());
    }

    if (this.#globalStore) {
      const map = await withMemoryStore(this.#globalStore, (store) => this.#loadMemories(store));
      allRecords.push(...map.values());
    }

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

    return filtered.slice(0, maxLimit);
  }

  rememberMemory(sessionId, input = {}) { return this.#serialMemory(() => this.#rememberMemory(sessionId, input)); }
  forgetMemory(sessionId, key) { return this.#serialMemory(() => this.#forgetMemory(sessionId, key)); }
  clearMemory(sessionId, scope = 'session') { return this.#serialMemory(() => this.#clearMemory(sessionId, scope)); }
  #serialMemory(task) {
    const run = this.#memoryQueue.then(task, task);
    this.#memoryQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #rememberMemory(sessionId, { key, value, scope = 'project', pinned = false, fileHashes = {} } = {}) {
    const normalizedScope = normalizeMemoryScope(scope);
    const recordKey = String(key ?? '').slice(0, 240);
    const recordValue = String(value ?? '').slice(0, 4000);
    const memoryRecord = {
      id: `mem-${randomBytes(8).toString('hex')}`,
      key: recordKey,
      value: recordValue,
      scope: normalizedScope,
      pinned: Boolean(pinned),
      file_hashes: boundedHashes(fileHashes),
      createdAt: Date.now(),
    };

    if (normalizedScope === 'session') {
      if (sessionId) {
        let sessionMap = this.#sessionMemories.get(sessionId);
        if (!sessionMap) { sessionMap = new Map(); this.#sessionMemories.set(sessionId, sessionMap); }
        sessionMap.set(recordKey, memoryRecord);
      }
    } else {
      const store = normalizedScope === 'global' ? this.#globalStore : this.#projectStore;
      await withMemoryStore(store, async (canonical) => {
        const map = await this.#loadMemories(canonical);
        map.set(recordKey, memoryRecord);
        await this.#saveMemories(canonical, map);
      });
    }
    return memoryRecord;
  }

  async #forgetMemory(sessionId, key) {
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
    const normalized = normalizeMemoryScope(scope);
    if (normalized === 'session' && sessionId) {
      this.#sessionMemories.delete(sessionId);
    } else if (normalized !== 'session') {
      const store = normalized === 'global' ? this.#globalStore : this.#projectStore;
      await withMemoryStore(store, (canonical) => this.#saveMemories(canonical, new Map()));
    }
    return { cleared: true };
  }

  async observeMemory(sessionId, observation) {
    if (observation?.scope === 'session' && typeof observation.key === 'string' && observation.key.startsWith('user_message:')) {
      return this.rememberMemory(sessionId, observation);
    }
    return { observed: true };
  }

  async recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash) {
    return { recorded: true };
  }

  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0) {
    return { context: '', memories: [] };
  }

  async refreshStm(input) {
    return { ok: true };
  }

  async turnCompleted(sessionId) {
    return { ok: true };
  }

  async close() {
    this.#sessionMemories.clear();
    this.#cachedFiles = null;
  }

  async #scanFiles(prefix = '') {
    const cleanPrefix = normalizePrefix(prefix);
    if (cleanPrefix === null) return { files: [], capped: false };
    const now = Date.now();
    if (!cleanPrefix) {
      if (this.#cachedFiles && now - this.#cacheTimestamp < 3000) return { files: this.#cachedFiles, capped: this.#indexCapped };
      const files = [];
      await walkDir(this.#projectRoot, this.#projectRoot, files, MAX_INDEXED_FILES);
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
    await walkDir(this.#projectRoot, startPath, files, MAX_INDEXED_FILES);
    files.sort((a, b) => a.localeCompare(b));
    return { files, capped: files.length >= MAX_INDEXED_FILES };
  }

  async #loadMemories(storeDir) {
    const filePath = join(storeDir, 'memory.json');
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
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
    try { await writeFile(temp, JSON.stringify([...memoryMap.values()], null, 2), 'utf8'); await rename(temp, filePath); }
    catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
}

async function walkDir(rootDir, currentDir, accumulator, maxFiles) {
  if (accumulator.length >= maxFiles) return;
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (accumulator.length >= maxFiles) break;
    const name = entry.name;
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;

    const fullPath = join(currentDir, name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name)) continue;   // '.git' is in the set; .github/.gitlab/etc. are ordinary source directories
      await walkDir(rootDir, fullPath, accumulator, maxFiles);
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
