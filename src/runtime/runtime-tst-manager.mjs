import { AsyncLocalStorage } from 'node:async_hooks';
import { checkTstSignal, tstOptions, withTstRequest } from './tst-request.mjs';
import { ManagedTstManager } from './tst-supervisor.mjs';
import { prepareManagedTstDataDir } from './tst-data-alias.mjs';

export class RuntimeTstManager {
  #manager; #context = new AsyncLocalStorage(); #closing; #resolveProject;

  constructor(options = {}) {
    this.#resolveProject = typeof options.resolveProjectForSession === 'function' ? options.resolveProjectForSession : null;
    if (options.manager) this.#manager = options.manager;
    else this.#manager = new ManagedTstManager({ ...options, dataDir: prepareManagedTstDataDir(options.dataDir) });
  }
  get configured() { return this.#manager.configured; }
  get status() { return this.#manager.status; }

  async runWithProject({ sessionId = null, projectId = null, projectRoot = null, signal } = {}, operation) {
    if (typeof operation !== 'function') throw new Error('TST project context requires an operation');
    // Keep ordinary runtime/session operations independent from managed TST health.
    // TST-backed methods bind lazily through #ensureSession/#projectHandle when they actually need it.
    return this.#context.run({ sessionId, projectId, projectRoot }, () => withTstRequest({ ...(signal ? { signal } : {}) }, operation));
  }

  unregisterProject(projectId) { return this.#manager.unregisterProject(projectId); }
  close() {
    if (!this.#closing) this.#closing = Promise.resolve(this.#manager.close());
    return this.#closing;
  }
  forProject(projectId, projectRoot) { return this.#manager.forProject(projectId, projectRoot); }
  forProjectRoot(projectRoot) { return this.#manager.forProjectRoot(projectRoot); }

  async call(method, params = {}, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    const sessionId = typeof params?.session_id === 'string' ? params.session_id : null;
    if (sessionId) { await this.#ensureSession(sessionId); return this.#manager.call(method, params, options); }
    return (await this.#projectHandle()).call(method, params, options);
  }
  async supports(capability, sessionId, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    if (sessionId) { await this.#ensureSession(sessionId); return this.#manager.supports(capability, sessionId, options); }
    return (await this.#projectHandle()).supports(capability, options);
  }

  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0, options = {}) { await this.#ensureSession(sessionId); return this.#manager.prepareContext(sessionId, query, hints, observations, mode, projectionBudget, tstOptions(options)); }
  async refreshStm(input, options = {}) { await this.#ensureSession(input?.session_id); return this.#manager.refreshStm(input, tstOptions(options)); }
  async turnCompleted(sessionId, options = {}) { await this.#ensureSession(sessionId); return this.#manager.turnCompleted(sessionId, tstOptions(options)); }
  async observeMemory(sessionId, observation, options = {}) { await this.#ensureSession(sessionId); return this.#manager.observeMemory(sessionId, observation, tstOptions(options)); }
  async queryMemory(sessionId, query, limit = 20, options = {}) { await this.#ensureSession(sessionId); return this.#manager.queryMemory(sessionId, query, limit, tstOptions(options)); }
  async rememberMemory(sessionId, value = {}, options = {}) { await this.#ensureSession(sessionId); return this.#manager.rememberMemory(sessionId, value, tstOptions(options)); }
  async forgetMemory(sessionId, key, options = {}) { await this.#ensureSession(sessionId); return this.#manager.forgetMemory(sessionId, key, tstOptions(options)); }
  async clearMemory(sessionId, scope = 'session', options = {}) { await this.#ensureSession(sessionId); return this.#manager.clearMemory(sessionId, scope, tstOptions(options)); }
  async recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash, options = {}) { await this.#ensureSession(sessionId); return this.#manager.recordEvidence(sessionId, memoryId, kind, reference, success, contentHash, tstOptions(options)); }

  async graphQuery(query, prefix, limit = 12, options = {}) { return (await this.#projectHandle()).graphQuery(query, prefix, limit, tstOptions(options)); }
  async graphLocate(pattern, prefix, limit = 12, options = {}) { return (await this.#projectHandle()).graphLocate(pattern, prefix, limit, tstOptions(options)); }
  async graphList(prefix, limit = 100, options = {}) { return (await this.#projectHandle()).graphList(prefix, limit, tstOptions(options)); }
  async graphWorkspace(limit = 100, options = {}) { return (await this.#projectHandle()).graphWorkspace(limit, tstOptions(options)); }
  async graphTraceSummary(query, direction = 'both', depth = 2, limit = 12, options = {}) { return (await this.#projectHandle()).graphTraceSummary(query, direction, depth, limit, tstOptions(options)); }
  async resolveEditTargets(path, query, expectedHash, limit = 12, options = {}) { return (await this.#projectHandle()).resolveEditTargets(path, query, expectedHash, limit, tstOptions(options)); }
  async parseStaged(path, baseHash, content, options = {}) { return (await this.#projectHandle()).parseStaged(path, baseHash, content, tstOptions(options)); }
  async refreshGraphPaths(paths, options = {}) { return (await this.#projectHandle()).refreshGraphPaths(paths, tstOptions(options)); }

  async #ensureSession(sessionId) {
    if (!sessionId) throw new Error('TST session is not bound to a project');
    const current = this.#context.getStore();
    if (current?.projectId && current?.projectRoot) {
      await this.#manager.bindSession(sessionId, current.projectId, current.projectRoot);
      return;
    }
    if (this.#resolveProject) {
      try {
        const resolved = await this.#resolveProject(sessionId);
        if (resolved?.projectId && resolved?.projectRoot) {
          await this.#manager.bindSession(sessionId, resolved.projectId, resolved.projectRoot);
        }
      } catch {}
    }
  }

  async #projectHandle() {
    const current = this.#context.getStore();
    if (current?.projectId && current?.projectRoot) {
      if (!current.handle) {
        const pending = Promise.resolve(this.#manager.forProject(current.projectId, current.projectRoot));
        current.handle = pending;
        void pending.catch(() => { if (current.handle === pending) current.handle = undefined; });
      }
      return current.handle;
    }
    if (current?.sessionId) {
      if (this.#resolveProject) {
        try {
          const resolved = await this.#resolveProject(current.sessionId);
          if (resolved?.projectId && resolved?.projectRoot) {
            await this.#manager.bindSession(current.sessionId, resolved.projectId, resolved.projectRoot).catch(() => undefined);
            return this.#manager.forProject(resolved.projectId, resolved.projectRoot);
          }
        } catch {}
      }
      if (typeof this.#manager.forSession === 'function') {
        try {
          return await this.#manager.forSession(current.sessionId);
        } catch {}
      }
    }
    if (!current?.projectId || !current?.projectRoot) throw new Error('Project-scoped TST operation has no active project context');
    return this.#manager.forProject(current.projectId, current.projectRoot);
  }
}
