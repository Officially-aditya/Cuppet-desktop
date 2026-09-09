import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TstBridge, TST_PROTOCOL_VERSION } from './tst-client.mjs';

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
const EXIT_TIMEOUT_MS = 3_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const STDERR_LIMIT = 8_000;
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

  get configured() { return Boolean(this.#external?.configured || (this.#binaryPath && this.#exists(this.#binaryPath))); }
  get status() {
    if (this.#external) return { ...this.#external.status, mode: 'external-developer-override', managed: false, projects: [] };
    const projects = [...this.#recordsByRoot.values()].map((record) => ({
      projectIds: [...record.projectIds].sort(), projectKey: record.projectKey, ...record.supervisor.status,
    }));
    return {
      configured: this.configured,
      connected: projects.some((project) => project.connected),
      protocol: TST_PROTOCOL_VERSION,
      capabilities: [...new Set(projects.flatMap((project) => project.capabilities ?? []))].sort(),
      mode: this.configured ? 'managed-native' : 'unavailable',
      managed: true,
      runtime: runtimeKey(),
      runningProjects: projects.filter((project) => project.running).length,
      projects,
      unavailableReason: this.configured ? null : this.#unavailableReason ?? 'Managed TST runtime is unavailable.',
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
    await Promise.all(records.map((record) => record.supervisor.close().catch(() => undefined)));
  }

  async call(method, params = {}) {
    const sessionId = typeof params?.session_id === 'string' ? params.session_id : null;
    if (!sessionId) throw new Error(`Project-scoped TST method ${method} requires an explicit project handle or session_id`);
    return (await this.#forSession(sessionId)).call(method, params);
  }
  async supports(capability, sessionId) { return (await this.#forSession(sessionId)).supports(capability); }
  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0) { return (await this.#forSession(sessionId)).prepareContext(sessionId, query, hints, observations, mode, projectionBudget); }
  async refreshStm(input) { return (await this.#forSession(input?.session_id)).refreshStm(input); }
  async turnCompleted(sessionId) { return (await this.#forSession(sessionId)).turnCompleted(sessionId); }
  async observeMemory(sessionId, observation) { return (await this.#forSession(sessionId)).observeMemory(sessionId, observation); }
  async queryMemory(sessionId, query, limit = 20) { return (await this.#forSession(sessionId)).queryMemory(sessionId, query, limit); }
  async rememberMemory(sessionId, value = {}) { return (await this.#forSession(sessionId)).rememberMemory(sessionId, value); }
  async forgetMemory(sessionId, key) { return (await this.#forSession(sessionId)).forgetMemory(sessionId, key); }
  async clearMemory(sessionId, scope = 'session') { return (await this.#forSession(sessionId)).clearMemory(sessionId, scope); }
  async recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash) { return (await this.#forSession(sessionId)).recordEvidence(sessionId, memoryId, kind, reference, success, contentHash); }

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
    const supervisor = this.#supervisorFactory({
      binaryPath: this.#binaryPath,
      projectRoot: root,
      projectStore: join(this.#dataDir, 'projects', projectKey),
      globalStore: join(this.#dataDir, 'global'),
      runRoot: join(this.#dataDir, 'run'),
      idleMs: this.#idleMs,
      projectKey,
    });
    const record = { root, projectKey, projectIds: new Set(), supervisor, handle: new ProjectTstHandle(supervisor) };
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
  #child; #bridge; #runDir; #idleTimer; #stderr = ''; #lastError; #starts = 0; #closed = false; #verified = false; #spawnError;

  constructor({ binaryPath, projectRoot, projectStore, globalStore, runRoot, idleMs = DEFAULT_IDLE_MS, projectKey = null }) {
    this.#binaryPath = binaryPath;
    this.#projectRoot = projectRoot;
    this.#projectStore = projectStore;
    this.#globalStore = globalStore;
    this.#runRoot = runRoot;
    this.#idleMs = idleMs;
    this.#projectKey = projectKey;
  }

  get status() {
    return {
      running: Boolean(this.#child && this.#child.exitCode === null),
      connected: Boolean(this.#bridge?.status?.connected),
      capabilities: this.#bridge?.status?.capabilities ?? [],
      starts: this.#starts,
      lastError: this.#lastError ?? null,
      projectKey: this.#projectKey,
    };
  }

  async call(method, params = {}) {
    const bridge = await this.#ensureStarted();
    this.#clearIdle();
    try {
      const result = await bridge.call(method, params);
      this.#lastError = undefined;
      return result;
    } catch (error) {
      this.#lastError = cleanError(error);
      throw error;
    } finally { this.#scheduleIdle(); }
  }

  async supports(capability) {
    const bridge = await this.#ensureStarted();
    this.#clearIdle();
    try { return await bridge.supports(capability); }
    finally { this.#scheduleIdle(); }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#stop();
  }

  async #ensureStarted() {
    if (this.#closed) throw new Error('TST supervisor is closed');
    if (this.#child && this.#child.exitCode === null && this.#bridge) return this.#bridge;
    await this.#start();
    return this.#bridge;
  }

  async #start() {
    if (!this.#binaryPath) throw new Error('Managed TST binary is unavailable');
    if (!this.#verified) {
      const protocol = (await capture(this.#binaryPath, ['--protocol'], 5_000)).trim();
      if (protocol !== TST_PROTOCOL_VERSION) throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${protocol || 'no identity'}`);
      this.#verified = true;
    }
    await Promise.all([
      privateDirectory(this.#projectStore), privateDirectory(this.#globalStore), privateDirectory(this.#runRoot),
    ]);
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

    const bridge = new TstBridge({ socketPath, token });
    this.#bridge = bridge;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
      if (this.#spawnError) throw this.#spawnError;
      if (child.exitCode !== null) throw new Error(`TST daemon exited during startup (${child.exitCode})${this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-1000)}` : ''}`);
      try {
        await bridge.call('status');
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
    if (this.#closed || this.#idleMs <= 0) return;
    this.#idleTimer = setTimeout(() => void this.#stop().catch(() => undefined), this.#idleMs);
    this.#idleTimer.unref?.();
  }
  #clearIdle() { if (this.#idleTimer) clearTimeout(this.#idleTimer); this.#idleTimer = undefined; }

  async #stop() {
    this.#clearIdle();
    const child = this.#child;
    const bridge = this.#bridge;
    const runDir = this.#runDir;
    this.#child = undefined;
    this.#bridge = undefined;
    this.#runDir = undefined;
    if (bridge) {
      try { await settleBefore(bridge.call('shutdown'), SHUTDOWN_TIMEOUT_MS); } catch {}
      bridge.close();
    }
    if (child && child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
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
  call(method, params = {}) { return this.#supervisor.call(method, params); }
  supports(capability) { return this.#supervisor.supports(capability); }
  prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0) { return this.call('context.prepare', { session_id: sessionId, query: String(query).slice(0, 6000), mode, projection_budget: Math.min(Math.max(Math.floor(projectionBudget), 0), 16384), hints: hints.slice(0, 32), observations: observations.slice(0, 256) }); }
  refreshStm(input) { return this.call('stm.refresh', boundedRefresh(input)); }
  turnCompleted(sessionId) { return this.call('turn.completed', { session_id: sessionId }); }
  observeMemory(sessionId, observation) { return this.call('memory.observe', { session_id: sessionId, ...observation }); }
  queryMemory(sessionId, query, limit = 20) { return this.call('memory.query', { session_id: sessionId, query, limit: Math.min(Math.max(limit, 1), 40) }); }
  rememberMemory(sessionId, { key, value, scope = 'project', pinned = false, fileHashes = {} } = {}) { return this.call('memory.remember', { session_id: sessionId, key: String(key ?? '').slice(0, 240), value: String(value ?? '').slice(0, 4000), scope: normalizeMemoryScope(scope), pinned: Boolean(pinned), file_hashes: boundedHashes(fileHashes) }); }
  forgetMemory(sessionId, key) { return this.call('memory.forget', { session_id: sessionId, key: String(key ?? '').slice(0, 240) }); }
  clearMemory(sessionId, scope = 'session') { return this.call('memory.forget', { session_id: sessionId, clear_scope: normalizeMemoryScope(scope) }); }
  recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash) { return this.call('evidence.record', { session_id: sessionId, memory_id: memoryId, kind, reference: String(reference).slice(0, 500), success, ...(contentHash ? { content_hash: String(contentHash).slice(0, 128) } : {}) }); }
  graphQuery(query, prefix, limit = 12) { return this.call('graph.query', { query: String(query).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 32) }); }
  graphLocate(pattern, prefix, limit = 12) { return this.call('graph.locate', { pattern: String(pattern).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 12) }); }
  graphList(prefix, limit = 100) { return this.call('graph.list', { ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: clamp(limit, 1, 512) }); }
  graphWorkspace(limit = 100) { return this.call('graph.workspace', { limit: clamp(limit, 1, 512) }); }
  graphTraceSummary(query, direction = 'both', depth = 2, limit = 12) { return this.call('graph.trace_summary', { query: String(query).slice(0, 512), direction: ['callers', 'callees', 'both'].includes(direction) ? direction : 'both', depth: clamp(depth, 1, 4), limit: clamp(limit, 1, 12) }); }
  async resolveEditTargets(path, query, expectedHash, limit = 12) { if (!await this.supports('edit.resolve_targets')) throw new Error('Connected TST daemon does not support revision-bound edit targets.'); return this.call('edit.resolve_targets', { path: String(path).slice(0, 1024), query: String(query).slice(0, 512), ...(expectedHash ? { expected_hash: String(expectedHash).slice(0, 128) } : {}), limit: clamp(limit, 1, 64) }); }
  async parseStaged(path, baseHash, content) { if (!await this.supports('edit.parse_staged')) throw new Error('Connected TST daemon does not support staged parsing.'); return this.call('edit.parse_staged', { path: String(path).slice(0, 1024), base_hash: baseHash || null, content: String(content) }); }
  async refreshGraphPaths(paths) { if (!await this.supports('graph.refresh_paths')) throw new Error('Connected TST daemon does not support the graph refresh barrier.'); return this.call('graph.refresh_paths', { paths: [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 1024)))].slice(0, 64) }); }
  close() {}
}

export function resolveManagedTstBinary({ resourcesPath = process.env.CUPPET_RESOURCES_PATH, existsImpl = existsSync } = {}) {
  const key = runtimeKey();
  if (!key) return null;
  const binaryName = process.platform === 'win32' ? 'tst-daemon.exe' : 'tst-daemon';
  const candidates = [
    process.env.CUPPET_TST_BIN ? resolve(process.env.CUPPET_TST_BIN) : null,
    resourcesPath ? join(resolve(resourcesPath), 'tst', key, binaryName) : null,
    resolve(here, '..', '..', 'vendor', 'tst', key, binaryName),
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
