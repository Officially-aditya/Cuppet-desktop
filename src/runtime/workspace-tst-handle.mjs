import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

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

export class WorkspaceTstHandle {
  #projectRoot;
  #projectKey;
  #projectStore;
  #globalStore;
  #sessionMemories = new Map();
  #cachedFiles = null;
  #cacheTimestamp = 0;

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
        return this.graphWorkspace(params.limit);
      case 'graph.list':
        return this.graphList(params.prefix, params.limit);
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

  async graphWorkspace(limit = 100) {
    const files = await this.#scanFiles();
    const clampedLimit = clamp(Number(limit) || 100, 1, 512);
    return {
      root: this.#projectRoot,
      graph: {
        files: files.length,
        symbols: 0,
        edges: 0,
      },
      files: files.slice(0, clampedLimit),
    };
  }

  async graphList(prefix, limit = 100) {
    const files = await this.#scanFiles();
    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
    const filtered = cleanPrefix
      ? files.filter((path) => path === cleanPrefix || path.startsWith(`${cleanPrefix}/`))
      : files;
    const clampedLimit = clamp(Number(limit) || 100, 1, 512);
    return {
      prefix: cleanPrefix,
      total: filtered.length,
      paths: filtered.slice(0, clampedLimit),
    };
  }

  async graphLocate(pattern, prefix, limit = 12) {
    const query = String(pattern ?? '').trim();
    const clampedLimit = clamp(Number(limit) || 12, 1, 12);
    if (!query) return { query, matches: [] };

    const files = await this.#scanFiles();
    const cleanPrefix = typeof prefix === 'string' ? prefix.trim().replace(/^\/+|\/+$/g, '') : '';
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
      const map = await this.#loadMemories(this.#projectStore);
      allRecords.push(...map.values());
    }

    if (this.#globalStore) {
      const map = await this.#loadMemories(this.#globalStore);
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

  async rememberMemory(sessionId, { key, value, scope = 'project', pinned = false, fileHashes = {} } = {}) {
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
    } else if (normalizedScope === 'project') {
      if (this.#projectStore) {
        const map = await this.#loadMemories(this.#projectStore);
        map.set(recordKey, memoryRecord);
        await this.#saveMemories(this.#projectStore, map);
      }
    } else if (normalizedScope === 'global') {
      if (this.#globalStore) {
        const map = await this.#loadMemories(this.#globalStore);
        map.set(recordKey, memoryRecord);
        await this.#saveMemories(this.#globalStore, map);
      }
    }
    return memoryRecord;
  }

  async forgetMemory(sessionId, key) {
    const targetKey = String(key ?? '').slice(0, 240);
    if (sessionId && this.#sessionMemories.has(sessionId)) {
      this.#sessionMemories.get(sessionId).delete(targetKey);
    }
    if (this.#projectStore) {
      const map = await this.#loadMemories(this.#projectStore);
      if (map.delete(targetKey)) await this.#saveMemories(this.#projectStore, map);
    }
    if (this.#globalStore) {
      const map = await this.#loadMemories(this.#globalStore);
      if (map.delete(targetKey)) await this.#saveMemories(this.#globalStore, map);
    }
    return { forgotten: true };
  }

  async clearMemory(sessionId, scope = 'session') {
    const normalized = normalizeMemoryScope(scope);
    if (normalized === 'session' && sessionId) {
      this.#sessionMemories.delete(sessionId);
    } else if (normalized === 'project' && this.#projectStore) {
      await this.#saveMemories(this.#projectStore, new Map());
    } else if (normalized === 'global' && this.#globalStore) {
      await this.#saveMemories(this.#globalStore, new Map());
    }
    return { cleared: true };
  }

  async observeMemory(sessionId, observation) {
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

  async #scanFiles() {
    const now = Date.now();
    if (this.#cachedFiles && now - this.#cacheTimestamp < 3000) {
      return this.#cachedFiles;
    }
    const files = [];
    await walkDir(this.#projectRoot, this.#projectRoot, files, 5000);
    files.sort((a, b) => a.localeCompare(b));
    this.#cachedFiles = files;
    this.#cacheTimestamp = now;
    return files;
  }

  async #loadMemories(storeDir) {
    if (!storeDir) return new Map();
    try {
      const filePath = join(storeDir, 'memory.json');
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Map(parsed.map((item) => [item.key, item]));
      }
    } catch {}
    return new Map();
  }

  async #saveMemories(storeDir, memoryMap) {
    if (!storeDir) return;
    try {
      await mkdir(storeDir, { recursive: true });
      const filePath = join(storeDir, 'memory.json');
      const records = [...memoryMap.values()];
      await writeFile(filePath, JSON.stringify(records, null, 2), 'utf8');
    } catch {}
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

  for (const entry of entries) {
    if (accumulator.length >= maxFiles) break;
    const name = entry.name;
    if (name === '.DS_Store' || name === 'Thumbs.db') continue;

    const fullPath = join(currentDir, name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name) || name.startsWith('.git')) continue;
      await walkDir(rootDir, fullPath, accumulator, maxFiles);
    } else if (entry.isFile()) {
      const rel = relative(rootDir, fullPath).replaceAll('\\', '/');
      accumulator.push(rel);
    }
  }
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
