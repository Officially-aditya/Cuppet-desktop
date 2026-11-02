import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TstBridge, TST_PROTOCOL_VERSION } from './tst-client.mjs';
import { checkTstSignal, tstOptions, waitForTst, withTstRequest } from './tst-request.mjs';
import { WorkspaceTstHandle, WORKSPACE_TST_CAPABILITIES } from './workspace-tst-handle.mjs';

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
const EXIT_TIMEOUT_MS = 3_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const STDERR_LIMIT = 8_000;
const SAFE_RETRY_METHODS = new Set(['status', 'graph.query', 'graph.search', 'graph.search_page', 'graph.revision', 'graph.locate', 'graph.list', 'graph.workspace', 'graph.trace', 'graph.trace_summary', 'memory.query', 'edit.resolve_targets', 'edit.parse_staged']);
const transportFailure = (error) => ['TST_TIMEOUT', 'TST_DISCONNECTED', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOENT'].includes(error?.code);
const here = dirname(fileURLToPath(import.meta.url));

export class ManagedTstManager {
  #dataDir; #binaryPath; #external; #recordsByRoot = new Map(); #rootByProject = new Map(); #sessionBindings = new Map();
  #supervisorFactory; #realpath; #idleMs; #exists; #unavailableReason;

  constructor({
    dataDir,
    binaryPath,
    resourcesPath = process.env.CUPPET_RESOURCES_PATH,
    externalSocket = process.env.CUPPET_TST_SOCKET,
    externalToken = process.env.CUPPET_TST_TOKEN,
    idleMs = DEFAULT_IDLE_MS,
    supervisorFactory = (options) => new TstSupervisor(options),
    realpathImpl = realpath,
    existsImpl = existsSync,
  } = {}) {
    if (!dataDir) throw new Error('ManagedTstManager requires dataDir');
    this.#dataDir = resolve(dataDir);
    this.#supervisorFactory = supervisorFactory;
    this.#realpath = realpathImpl;
    this.#idleMs = Math.max(0, Number.isFinite(idleMs) ? Math.trunc(idleMs) : DEFAULT_IDLE_MS);
    this.#exists = existsImpl;
    if (externalSocket && externalToken) {
      this.#external = new TstBridge({ socketPath: externalSocket, token: externalToken });
      this.#binaryPath = null;
      return;
    }
    if (externalSocket || externalToken) this.#unavailableReason = 'Both CUPPET_TST_SOCKET and CUPPET_TST_TOKEN are required for the external developer override.';
    this.#binaryPath = binaryPath ? resolve(binaryPath) : resolveManagedTstBinary({ resourcesPath, existsImpl });
    if (!this.#binaryPath && !this.#unavailableReason) this.#unavailableReason = unsupportedReason();
    if (this.#binaryPath && !this.#exists(this.#binaryPath)) this.#unavailableReason = `Managed TST runtime is missing for ${runtimeKey() ?? 'this platform'}.`;
  }

  get #hasNative() { return Boolean(this.#binaryPath && this.#exists(this.#binaryPath)); }
  get configured() { return true; }
  get status() {
    if (this.#external) return { ...this.#external.status, mode: 'external-developer-override', managed: false, projects: [] };
    const projects = [...this.#recordsByRoot.values()].map((record) => ({
      projectIds: [...record.projectIds].sort(), projectKey: record.projectKey, ...record.supervisor.status,
    }));
    const hasNative = this.#hasNative;
    const mode = hasNative ? 'managed-native' : 'workspace-fallback';
    return {
      configured: true,
      connected: hasNative ? projects.some((project) => project.connected) : true,
      protocol: TST_PROTOCOL_VERSION,
      capabilities: hasNative
        ? [...new Set(projects.flatMap((project) => project.capabilities ?? []))].sort()
        : [...WORKSPACE_TST_CAPABILITIES],
      mode,
      managed: true,
      runtime: runtimeKey(),
      runningProjects: projects.filter((project) => project.running).length,
      projects,
      unavailableReason: null,
    };
  }

  async bindSession(sessionId, projectId, projectRoot) {
    if (!sessionId || !projectId || !projectRoot) throw new Error('TST session binding requires sessionId, projectId, and projectRoot');
    if (this.#external) {
      this.#sessionBindings.set(sessionId, { projectId, root: resolve(projectRoot) });
      return this.#external;
    }
    const record = await this.#ensureProject(projectId, projectRoot);
    this.#sessionBindings.set(sessionId, { projectId, root: record.root });
    return record.handle;
  }

  async forProject(projectId, projectRoot) {
    if (this.#external) return this.#external;
    return (await this.#ensureProject(projectId, projectRoot)).handle;
  }

  async forProjectRoot(projectRoot) {
    if (this.#external) return this.#external;
    const root = await this.#canonicalRoot(projectRoot);
    let record = this.#recordsByRoot.get(root);
    if (!record) record = await this.#createRecord(root);
    return record.handle;
  }

  async unregisterProject(projectId) {
    if (!projectId) return { closed: false };
    const root = this.#rootByProject.get(projectId);
    this.#rootByProject.delete(projectId);
    for (const [sessionId, binding] of this.#sessionBindings) if (binding.projectId === projectId) this.#sessionBindings.delete(sessionId);
    if (this.#external || !root) return { closed: false };
    const record = this.#recordsByRoot.get(root);
    if (!record) return { closed: false };
    record.projectIds.delete(projectId);
    if (record.projectIds.size) return { closed: false };
    this.#recordsByRoot.delete(root);
    await record.supervisor.close();
    return { closed: true, projectKey: record.projectKey };
  }

  async close() {
    this.#sessionBindings.clear();
    this.#rootByProject.clear();
    if (this.#external) { this.#external.close(); return; }
    const records = [...this.#recordsByRoot.values()];
    this.#recordsByRoot.clear();
    await Promise.all(records.map((record) => Promise.resolve(record.supervisor.close()).catch(() => undefined)));
  }

  async call(method, params = {}, options = {}) {
    const sessionId = typeof params?.session_id === 'string' ? params.session_id : null;
    if (!sessionId) throw new Error(`Project-scoped TST method ${method} requires an explicit project handle or session_id`);
    return (await this.#forSession(sessionId)).call(method, params, options);
  }
  async supports(capability, sessionId, options = {}) { return (await this.#forSession(sessionId)).supports(capability, options); }
  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0, options = {}) { return (await this.#forSession(sessionId)).prepareContext(sessionId, query, hints, observations, mode, projectionBudget, options); }
  async refreshStm(input, options = {}) { return (await this.#forSession(input?.session_id)).refreshStm(input, options); }
  async turnCompleted(sessionId, options = {}) { return (await this.#forSession(sessionId)).turnCompleted(sessionId, options); }
  async observeMemory(sessionId, observation, options = {}) { return (await this.#forSession(sessionId)).observeMemory(sessionId, observation, options); }
  async queryMemory(sessionId, query, limit = 20, options = {}) { return (await this.#forSession(sessionId)).queryMemory(sessionId, query, limit, options); }
  async rememberMemory(sessionId, value = {}, options = {}) { return (await this.#forSession(sessionId)).rememberMemory(sessionId, value, options); }
  async forgetMemory(sessionId, key, options = {}) { return (await this.#forSession(sessionId)).forgetMemory(sessionId, key, options); }
  async clearMemory(sessionId, scope = 'session', options = {}) { return (await this.#forSession(sessionId)).clearMemory(sessionId, scope, options); }
  async recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash, options = {}) { return (await this.#forSession(sessionId)).recordEvidence(sessionId, memoryId, kind, reference, success, contentHash, options); }
  async forSession(sessionId) { return this.#forSession(sessionId); }
  sessionBinding(sessionId) { return this.#sessionBindings.get(sessionId) ?? null; }

  async #forSession(sessionId) {
    if (this.#external) return this.#external;
    if (!sessionId) throw new Error('TST session is not bound to a project');
    const binding = this.#sessionBindings.get(sessionId);
    if (!binding) throw new Error(`TST session is not bound to a project: ${sessionId}`);
    const record = this.#recordsByRoot.get(binding.root);
    if (!record) throw new Error(`TST project runtime is unavailable for session: ${sessionId}`);
    return record.handle;
  }

  async #ensureProject(projectId, projectRoot) {
    if (!this.configured) throw new Error(this.#unavailableReason ?? 'Managed TST runtime is unavailable');
    const root = await this.#canonicalRoot(projectRoot);
    const previousRoot = this.#rootByProject.get(projectId);
    if (previousRoot && previousRoot !== root) await this.unregisterProject(projectId);
    let record = this.#recordsByRoot.get(root);
    if (!record) record = await this.#createRecord(root);
    record.projectIds.add(projectId);
    this.#rootByProject.set(projectId, root);
    return record;
  }

  async #createRecord(root) {
    const projectKey = createHash('sha256').update(root).digest('hex');
    const projectStore = join(this.#dataDir, 'projects', projectKey);
    const globalStore = join(this.#dataDir, 'global');
    const runRoot = join(this.#dataDir, 'run');

    if (this.#hasNative) {
      const supervisor = this.#supervisorFactory({
        binaryPath: this.#binaryPath,
        projectRoot: root,
        projectStore,
        globalStore,
        runRoot,
        idleMs: this.#idleMs,
        projectKey,
      });
      const record = { root, projectKey, projectIds: new Set(), supervisor, handle: new ProjectTstHandle(supervisor) };
      this.#recordsByRoot.set(root, record);
      return record;
    }

    const handle = new WorkspaceTstHandle({
      projectRoot: root,
      projectKey,
      projectStore,
      globalStore,
    });
    const record = { root, projectKey, projectIds: new Set(), supervisor: handle, handle };
    this.#recordsByRoot.set(root, record);
    return record;
  }

  async #canonicalRoot(projectRoot) {
    try { return await this.#realpath(resolve(projectRoot)); }
    catch { throw new Error(`TST project root is unavailable: ${projectRoot}`); }
  }
}

export class TstSupervisor {
  #binaryPath; #projectRoot; #projectStore; #globalStore; #runRoot; #idleMs; #projectKey;
  #recovering; #stopping; #activeCalls = 0; #failures = 0; #restarts = []; #recoveryBlockedUntil = 0;
  #healthTimeoutMs; #failureThreshold; #maxRestarts; #restartWindowMs; #startController;
  #child; #bridge; #starting; #runDir; #idleTimer; #stderr = ''; #lastError; #starts = 0; #closed = false; #verified = false; #spawnError;

  constructor({ binaryPath, projectRoot, projectStore, globalStore, runRoot, idleMs = DEFAULT_IDLE_MS, projectKey = null, healthTimeoutMs = 1000, failureThreshold = 2, maxRestarts = 2, restartWindowMs = 60000 }) {
    this.#binaryPath = binaryPath;
    this.#projectRoot = projectRoot;
    this.#projectStore = projectStore;
    this.#globalStore = globalStore;
    this.#runRoot = runRoot;
    this.#idleMs = idleMs;
    this.#projectKey = projectKey;
    this.#healthTimeoutMs = Math.max(20, healthTimeoutMs);
    this.#failureThreshold = Math.max(1, failureThreshold);
    this.#maxRestarts = Math.max(0, maxRestarts);
    this.#restartWindowMs = Math.max(1000, restartWindowMs);
  }

  get status() {
    return {
      running: Boolean(this.#child && this.#child.exitCode === null),
      connected: Boolean(this.#bridge?.status?.connected),
      capabilities: this.#bridge?.status?.capabilities ?? [],
      starts: this.#starts,
      recoveryBlockedUntil: this.#recoveryBlockedUntil || null,
      lastError: this.#lastError ?? null,
      projectKey: this.#projectKey,
    };
  }

  async call(method, params = {}, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    if (this.#closed) throw new Error('TST supervisor is closed');
    if (Date.now() < this.#recoveryBlockedUntil) throw new Error('TST recovery limit reached; retry after the recovery window');
    if (this.#recovering) await waitForTst(this.#recovering, options.signal);
    if (this.#closed) throw new Error('TST supervisor is closed');
    if (Date.now() < this.#recoveryBlockedUntil) throw new Error('TST recovery limit reached; retry after the recovery window');
    this.#activeCalls++; this.#clearIdle();
    let bridge;
    try {
      bridge = await waitForTst(this.#ensureStarted(), options.signal);
      checkTstSignal(options.signal);
      try {
        const result = await bridge.call(method, params, options);
        this.#failures = 0; this.#lastError = undefined;
        return result;
      } catch (error) {
        if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
        this.#lastError = cleanError(error);
        if (!transportFailure(error)) throw error;
        const recovered = await waitForTst(this.#recover(bridge), options.signal);
        checkTstSignal(options.signal);
        if (!recovered || !SAFE_RETRY_METHODS.has(method)) throw error;
        // One retry per safe request. An uncertain mutation must be reconciled by its caller.
        const current = await waitForTst(this.#ensureStarted(), options.signal);
        try {
          const result = await current.call(method, params, options);
          this.#failures = 0; this.#lastError = undefined; return result;
        } catch (retryError) {
          if (retryError?.name !== 'AbortError' && !options.signal?.aborted && transportFailure(retryError)) {
            await waitForTst(this.#recover(current), options.signal);
          }
          throw retryError;
        }
      }
    } finally { this.#activeCalls--; this.#scheduleIdle(); }
  }

  async #recover(failedBridge) {
    if (this.#closed) return false;
    if (this.#recovering) return this.#recovering;
    if (failedBridge !== this.#bridge && this.#bridge?.status.connected) return true;
    const recovering = withTstRequest({ signal: undefined }, async () => {
      this.#failures++;
      let healthy = false;
      try { await failedBridge.call('status', {}, { timeoutMs: this.#healthTimeoutMs, signal: undefined }); healthy = true; }
      catch { this.#failures++; failedBridge.close(); }
      if (this.#closed) return false;
      if (healthy && this.#failures < this.#failureThreshold) return true;
      const now = Date.now();
      this.#restarts = this.#restarts.filter((time) => now - time < this.#restartWindowMs);
      if (this.#restarts.length >= this.#maxRestarts) {
        this.#recoveryBlockedUntil = (this.#restarts[0] ?? now) + this.#restartWindowMs;
        this.#lastError = 'TST recovery limit reached after repeated daemon failures';
        await this.#stop(true);
        return false;
      }
      this.#restarts.push(now);
      await this.#stop(true);
      if (this.#closed) return false;
      await this.#ensureStarted();
      this.#failures = 0;
      return true;
    }).finally(() => { if (this.#recovering === recovering) this.#recovering = undefined; });
    this.#recovering = recovering;
    return recovering;
  }

  async supports(capability, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    await this.call('status', {}, options);
    return this.#bridge?.supports(capability, options) ?? false;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#startController?.abort();
    await this.#starting?.catch(() => undefined);
    await this.#recovering?.catch(() => undefined);
    await this.#stop();
  }

  async #ensureStarted() {
    if (this.#closed) throw new Error('TST supervisor is closed');
    // One start at a time: concurrent cold-start callers used to spawn one daemon each and orphan all but the last.
    if (this.#stopping) await this.#stopping;
    if (this.#closed) throw new Error('TST supervisor is closed');
    if (this.#starting) { await this.#starting; return this.#bridge; }
    if (this.#child && this.#child.exitCode === null && this.#bridge) return this.#bridge;
    this.#startController = new AbortController();
    this.#starting = withTstRequest({ signal: undefined }, () => this.#start(this.#startController.signal)).finally(() => { this.#starting = undefined; this.#startController = undefined; });
    await this.#starting;
    return this.#bridge;
  }

  async #start(signal) {
    if (!this.#binaryPath) throw new Error('Managed TST binary is unavailable');
    if (!this.#verified) {
      const protocol = (await capture(this.#binaryPath, ['--protocol'], 5_000)).trim();
      if (protocol !== TST_PROTOCOL_VERSION) throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${protocol || 'no identity'}`);
      this.#verified = true;
    }
    await Promise.all([
      privateDirectory(this.#projectStore), privateDirectory(this.#globalStore), privateDirectory(this.#runRoot),
    ]);
    checkTstSignal(signal); if (this.#closed) throw new Error('TST supervisor is closed');
    const launchId = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const runDir = join(this.#runRoot, launchId);
    await privateDirectory(runDir);
    const socketPath = join(runDir, 'tst.sock');
    const token = randomBytes(32).toString('hex');
    this.#stderr = '';
    this.#spawnError = undefined;
    const child = spawn(this.#binaryPath, [
      '--socket', socketPath,
      '--project-root', this.#projectRoot,
      '--project-store', this.#projectStore,
      '--global-store', this.#globalStore,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CUPPET_TST_TOKEN: token },
      windowsHide: true,
    });
    this.#child = child;
    this.#runDir = runDir;
    this.#starts++;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_LIMIT); });
    child.once('error', (error) => { this.#spawnError = error; this.#lastError = cleanError(error); });
    child.once('exit', (code, signal) => {
      if (this.#child !== child) return;
      if (code && !this.#closed) this.#lastError = `TST daemon exited (${code}${signal ? `, ${signal}` : ''})${this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-1000)}` : ''}`;
      this.#bridge?.close();
      this.#bridge = undefined;
      this.#child = undefined;
      const staleRun = this.#runDir;
      this.#runDir = undefined;
      if (staleRun) void rm(staleRun, { recursive: true, force: true }).catch(() => undefined);
    });

    const bridge = new TstBridge({ socketPath, token, connectTimeoutMs: 2_000 });
    this.#bridge = bridge;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
      if (this.#closed || signal.aborted) { bridge.close(); await this.#stop(true); checkTstSignal(signal); throw new Error('TST supervisor is closed'); }
      if (this.#spawnError) { await this.#stop(true); throw this.#spawnError; }
      if (child.exitCode !== null) throw new Error(`TST daemon exited during startup (${child.exitCode})${this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-1000)}` : ''}`);
      try {
        // Bounded probe: without a timeout a wedged daemon made this loop (and its 10s deadline) wait forever.
        await bridge.call('status', {}, { timeoutMs: Math.max(250, Math.min(2_000, deadline - Date.now())), signal });
        this.#lastError = undefined;
        this.#scheduleIdle();
        return;
      } catch (error) {
        lastError = error;
        await sleep(75);
      }
    }
    this.#lastError = cleanError(lastError ?? new Error('socket unavailable'));
    await this.#stop();
    throw new Error(`Timed out waiting for managed TST daemon: ${this.#lastError}`);
  }

  #scheduleIdle() {
    this.#clearIdle();
    if (this.#closed || this.#activeCalls || this.#recovering || this.#idleMs <= 0) return;
    this.#idleTimer = setTimeout(() => void this.#stop().catch(() => undefined), this.#idleMs);
    this.#idleTimer.unref?.();
  }
  #clearIdle() { if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined; }

  async #stop(force = false) {
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stopNow(force).finally(() => { if (this.#stopping === stopping) this.#stopping = undefined; });
    this.#stopping = stopping;
    return stopping;
  }

  async #stopNow(force) {
    this.#clearIdle();
    const child = this.#child;
    const bridge = this.#bridge;
    const runDir = this.#runDir;
    this.#child = undefined;
    this.#bridge = undefined;
    this.#runDir = undefined;
    if (bridge) {
      if (!force) { try { await settleBefore(bridge.call('shutdown', {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS, signal: undefined }), SHUTDOWN_TIMEOUT_MS); } catch {} }
      bridge.close();
    }
    if (child && child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      if (force) child.kill('SIGTERM');
      if (!await settleBefore(exited, EXIT_TIMEOUT_MS)) {
        child.kill('SIGTERM');
        if (!await settleBefore(exited, 1_000) && child.exitCode === null) child.kill('SIGKILL');
      }
    }
    if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

class ProjectTstHandle {
  #supervisor;
  constructor(supervisor) { this.#supervisor = supervisor; }
  get configured() { return true; }
  get status() { return { configured: true, protocol: TST_PROTOCOL_VERSION, ...this.#supervisor.status }; }
  call(method, params = {}, options = {}) { return this.#supervisor.call(method, params, options); }
  supports(capability, options = {}) { return this.#supervisor.supports(capability, options); }
  prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0, options = {}) { return this.call('context.prepare', { session_id: sessionId, query: String(query).slice(0, 6000), mode, projection_budget: Math.min(Math.max(Math.floor(projectionBudget), 0), 16384), hints: hints.slice(0, 32), observations: observations.slice(0, 256) }, options); }
  refreshStm(input, options = {}) { return this.call('stm.refresh', boundedRefresh(input), options); }
  turnCompleted(sessionId, options = {}) { return this.call('turn.completed', { session_id: sessionId }, options); }
  observeMemory(sessionId, observation, options = {}) { return this.call('memory.observe', { session_id: sessionId, ...observation }, options); }
  queryMemory(sessionId, query, limit = 20, options = {}) { return this.call('memory.query', { session_id: sessionId, query, limit: Math.min(Math.max(limit, 1), 40) }, options); }
  rememberMemory(sessionId, { key, value, scope = 'project', pinned = false, fileHashes = {} } = {}, options = {}) { return this.call('memory.remember', { session_id: sessionId, key: String(key ?? '').slice(0, 240), value: String(value ?? '').slice(0, 4000), scope: normalizeMemoryScope(scope), pinned: Boolean(pinned), file_hashes: boundedHashes(fileHashes) }, options); }
  forgetMemory(sessionId, key, options = {}) { return this.call('memory.forget', { session_id: sessionId, key: String(key ?? '').slice(0, 240) }, options); }
  clearMemory(sessionId, scope = 'session', options = {}) { return this.call('memory.forget', { session_id: sessionId, clear_scope: normalizeMemoryScope(scope) }, options); }
  recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash, options = {}) { return this.call('evidence.record', { session_id: sessionId, memory_id: memoryId, kind, reference: String(reference).slice(0, 500), success, ...(contentHash ? { content_hash: String(contentHash).slice(0, 128) } : {}) }, options); }
  graphQuery(query, prefix, limit = 12, options = {}) { return this.call('graph.query', { query: String(query).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 32) }, options); }
  graphLocate(pattern, prefix, limit = 12, options = {}) { return this.call('graph.locate', { pattern: String(pattern).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 12) }, options); }
  graphList(prefix, limit = 100, options = {}) { return this.call('graph.list', { ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 512) }, options); }
  graphWorkspace(limit = 100, options = {}) { return this.call('graph.workspace', { limit: clamp(limit, 1, 512) }, options); }
  graphTraceSummary(query, direction = 'both', depth = 2, limit = 12, options = {}) { return this.call('graph.trace_summary', { query: String(query).slice(0, 512), direction: ['callers', 'callees', 'both'].includes(direction) ? direction : 'both', depth: clamp(depth, 1, 4), limit: clamp(limit, 1, 12) }, options); }
  async resolveEditTargets(path, query, expectedHash, limit = 12, options = {}) { if (!await this.supports('edit.resolve_targets', options)) throw new Error('Connected TST daemon does not support revision-bound edit targets.'); return this.call('edit.resolve_targets', { path: String(path).slice(0, 1024), query: String(query).slice(0, 512), ...(expectedHash ? { expected_hash: String(expectedHash).slice(0, 128) } : {}), limit: clamp(limit, 1, 64) }, options); }
  async parseStaged(path, baseHash, content, options = {}) { if (!await this.supports('edit.parse_staged', options)) throw new Error('Connected TST daemon does not support staged parsing.'); return this.call('edit.parse_staged', { path: String(path).slice(0, 1024), base_hash: baseHash || null, content: String(content) }, options); }
  async refreshGraphPaths(paths, options = {}) { if (!await this.supports('graph.refresh_paths', options)) throw new Error('Connected TST daemon does not support the graph refresh barrier.'); return this.call('graph.refresh_paths', { paths: [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 1024)))].slice(0, 64) }, options); }
  close() {}
}

export function resolveManagedTstBinary({ resourcesPath = process.env.CUPPET_RESOURCES_PATH, existsImpl = existsSync } = {}) {
  const key = runtimeKey();
  if (!key) return null;
  const binaryName = process.platform === 'win32' ? 'tst-daemon.exe' : 'tst-daemon';
  const candidates = [
    process.env.CUPPET_TST_BIN ? resolve(process.env.CUPPET_TST_BIN) : null,
    resourcesPath ? join(resolve(resourcesPath), 'tst', key, binaryName) : null,
    resourcesPath ? join(resolve(resourcesPath), 'tst', binaryName) : null,
    resolve(here, '..', '..', 'vendor', 'tst', key, binaryName),
    resolve(here, '..', '..', 'node_modules', `@cuppet-code/runtime-${key}`, 'bin', binaryName),
    resolve(here, '..', '..', 'node_modules', `@cuppet/runtime-${key}`, 'bin', binaryName),
    process.env.npm_config_prefix ? join(process.env.npm_config_prefix, 'lib', 'node_modules', `@cuppet-code/runtime-${key}`, 'bin', binaryName) : null,
    process.env.NVM_BIN ? resolve(process.env.NVM_BIN, '..', 'lib', 'node_modules', `@cuppet-code/runtime-${key}`, 'bin', binaryName) : null,
    process.env.HOME ? join(process.env.HOME, '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', `@cuppet-code/runtime-${key}`, 'bin', binaryName) : null,
    process.env.HOME ? join(process.env.HOME, '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', `@cuppet/runtime-${key}`, 'bin', binaryName) : null,
    `/usr/local/lib/node_modules/@cuppet-code/runtime-${key}/bin/${binaryName}`,
    `/opt/homebrew/lib/node_modules/@cuppet-code/runtime-${key}/bin/${binaryName}`,
  ].filter(Boolean);
  return candidates.find((candidate) => existsImpl(candidate)) ?? candidates[0] ?? null;
}

export function runtimeKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `darwin-${arch}`;
  if (platform === 'linux' && ['arm64', 'x64'].includes(arch)) return `linux-${arch}-gnu`;
  return null;
}

function unsupportedReason() { return runtimeKey() ? 'Managed TST runtime path could not be resolved.' : `Managed native TST is not released for ${process.platform}-${process.arch}.`; }
async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') await chmod(path, 0o700); }
function clamp(value, min, max) { const parsed = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : min; return Math.min(max, Math.max(min, parsed)); }
function normalizeMemoryScope(value) { const scope = String(value ?? 'session').toLowerCase(); return ['session', 'project', 'global'].includes(scope) ? scope : 'session'; }
function boundedHashes(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).slice(0, 64).flatMap(([path, hash]) => typeof path === 'string' && typeof hash === 'string' ? [[path.slice(0, 512), hash.slice(0, 128)]] : [])); }
function boundedRefresh(input = {}) { return { ...input, query: typeof input.query === 'string' ? input.query.slice(0, 6000) : undefined, prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 6000) : undefined, requirements: input.requirements?.slice?.(0, 64), outcomes: input.outcomes?.slice?.(0, 64), constraints: input.constraints?.slice?.(0, 64), observations: input.observations?.slice?.(0, 64), candidates: input.candidates?.slice?.(0, 64), explicit_paths: input.explicit_paths?.slice?.(0, 128), tool_paths: input.tool_paths?.slice?.(0, 128), validated_paths: input.validated_paths?.slice?.(0, 128), graph_paths: input.graph_paths?.slice?.(0, 128), file_evidence: input.file_evidence?.slice?.(0, 128) }; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
async function settleBefore(promise, timeoutMs) { return Promise.race([Promise.resolve(promise).then(() => true).catch(() => true), new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs))]); }
function capture(command, arguments_, timeoutMs) { return new Promise((resolveCapture, rejectCapture) => { const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); rejectCapture(new Error(`TST protocol probe timed out after ${timeoutMs}ms`)); }, timeoutMs); child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); }); child.once('error', (error) => { clearTimeout(timer); rejectCapture(error); }); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveCapture(stdout) : rejectCapture(new Error(`${command} --protocol exited ${code}: ${stderr.trim()}`)); }); }); }
