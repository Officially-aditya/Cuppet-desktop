import { AsyncLocalStorage } from 'node:async_hooks';
import { ManagedTstManager } from './tst-supervisor.mjs';

export class RuntimeTstManager {
  #manager; #context = new AsyncLocalStorage();

  constructor(options = {}) { this.#manager = options.manager ?? new ManagedTstManager(options); }
  get configured() { return this.#manager.configured; }
  get status() { return this.#manager.status; }

  async runWithProject({ sessionId = null, projectId = null, projectRoot = null } = {}, operation) {
    if (typeof operation !== 'function') throw new Error('TST project context requires an operation');
    if (projectId && projectRoot && sessionId) await this.#manager.bindSession(sessionId, projectId, projectRoot);
    else if (projectId && projectRoot) await this.#manager.forProject(projectId, projectRoot);
    return this.#context.run({ sessionId, projectId, projectRoot }, operation);
  }

  unregisterProject(projectId) { return this.#manager.unregisterProject(projectId); }
  close() { return this.#manager.close(); }
  forProject(projectId, projectRoot) { return this.#manager.forProject(projectId, projectRoot); }
  forProjectRoot(projectRoot) { return this.#manager.forProjectRoot(projectRoot); }

  async call(method, params = {}) {
    const sessionId = typeof params?.session_id === 'string' ? params.session_id : null;
    if (sessionId) { await this.#ensureSession(sessionId); return this.#manager.call(method, params); }
    return (await this.#projectHandle()).call(method, params);
  }
  async supports(capability, sessionId) {
    if (sessionId) { await this.#ensureSession(sessionId); return this.#manager.supports(capability, sessionId); }
    return (await this.#projectHandle()).supports(capability);
  }

  async prepareContext(sessionId, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0) { await this.#ensureSession(sessionId); return this.#manager.prepareContext(sessionId, query, hints, observations, mode, projectionBudget); }
  async refreshStm(input) { await this.#ensureSession(input?.session_id); return this.#manager.refreshStm(input); }
  async turnCompleted(sessionId) { await this.#ensureSession(sessionId); return this.#manager.turnCompleted(sessionId); }
  async observeMemory(sessionId, observation) { await this.#ensureSession(sessionId); return this.#manager.observeMemory(sessionId, observation); }
  async queryMemory(sessionId, query, limit = 20) { await this.#ensureSession(sessionId); return this.#manager.queryMemory(sessionId, query, limit); }
  async rememberMemory(sessionId, value = {}) { await this.#ensureSession(sessionId); return this.#manager.rememberMemory(sessionId, value); }
  async forgetMemory(sessionId, key) { await this.#ensureSession(sessionId); return this.#manager.forgetMemory(sessionId, key); }
  async clearMemory(sessionId, scope = 'session') { await this.#ensureSession(sessionId); return this.#manager.clearMemory(sessionId, scope); }
  async recordEvidence(sessionId, memoryId, kind, reference, success = true, contentHash) { await this.#ensureSession(sessionId); return this.#manager.recordEvidence(sessionId, memoryId, kind, reference, success, contentHash); }

  async graphQuery(query, prefix, limit = 12) { return (await this.#projectHandle()).graphQuery(query, prefix, limit); }
  async graphLocate(pattern, prefix, limit = 12) { return (await this.#projectHandle()).graphLocate(pattern, prefix, limit); }
  async graphList(prefix, limit = 100) { return (await this.#projectHandle()).graphList(prefix, limit); }
  async graphWorkspace(limit = 100) { return (await this.#projectHandle()).graphWorkspace(limit); }
  async graphTraceSummary(query, direction = 'both', depth = 2, limit = 12) { return (await this.#projectHandle()).graphTraceSummary(query, direction, depth, limit); }
  async resolveEditTargets(path, query, expectedHash, limit = 12) { return (await this.#projectHandle()).resolveEditTargets(path, query, expectedHash, limit); }
  async parseStaged(path, baseHash, content) { return (await this.#projectHandle()).parseStaged(path, baseHash, content); }
  async refreshGraphPaths(paths) { return (await this.#projectHandle()).refreshGraphPaths(paths); }

  async #ensureSession(sessionId) {
    if (!sessionId) throw new Error('TST session is not bound to a project');
    const current = this.#context.getStore();
    if (current?.projectId && current?.projectRoot) {
      await this.#manager.bindSession(sessionId, current.projectId, current.projectRoot);
    }
  }

  async #projectHandle() {
    const current = this.#context.getStore();
    if (!current?.projectId || !current?.projectRoot) throw new Error('Project-scoped TST operation has no active project context');
    return this.#manager.forProject(current.projectId, current.projectRoot);
  }
}
