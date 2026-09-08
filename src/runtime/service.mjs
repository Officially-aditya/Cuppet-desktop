import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConversationDatabase } from './database.mjs';
import { OpenAICompatibleChatProvider } from './provider.mjs';
import { ProjectManager } from './projects.mjs';
import { TstBridge } from './tst-client.mjs';
import { LosslessPlanStore } from './lossless-plan.mjs';
import { CognitiveStateStore } from './cognitive-state.mjs';
import { ContextCompiler } from './context-compiler.mjs';
import { BackgroundEnricher } from './background-enricher.mjs';

export class RuntimeService {
  #db; #emit; #providerFactory; #runs = new Map(); #projects; #tst; #plans; #cognitive; #compiler; #backgrounds = new Map(); #backgroundFactory; #dataDir; #ready;

  constructor({
    databasePath,
    dataDir = dirname(databasePath),
    emit = () => {},
    providerFactory = (config) => new OpenAICompatibleChatProvider(config),
    projectManagerFactory = (db) => new ProjectManager({ db }),
    tst = new TstBridge(),
    planStore,
    cognitiveState,
    contextCompiler,
    backgroundFactory,
  }) {
    this.#dataDir = dataDir;
    this.#db = new ConversationDatabase(databasePath);
    this.#emit = emit;
    this.#providerFactory = providerFactory;
    this.#projects = projectManagerFactory(this.#db);
    this.#tst = tst;
    this.#plans = planStore ?? new LosslessPlanStore(join(dataDir, 'lossless-plans'));
    this.#cognitive = cognitiveState ?? new CognitiveStateStore(join(dataDir, 'cognitive-state.json'));
    this.#compiler = contextCompiler ?? new ContextCompiler({ tst: this.#tst, planStore: this.#plans, cognitiveState: this.#cognitive });
    this.#backgroundFactory = backgroundFactory ?? ((projectId) => new BackgroundEnricher({ providerFactory: this.#providerFactory, tst: this.#tst, projectStore: join(this.#dataDir, 'background', safeStoreName(projectId)), projectID: projectId ?? 'general' }));
    this.#ready = this.#cognitive.ready();
  }

  async close() {
    for (const run of this.#runs.values()) run.controller.abort();
    this.#runs.clear();
    await Promise.all([...this.#backgrounds.values()].map((worker) => worker.close().catch(() => undefined)));
    this.#tst.close?.();
    this.#db.close();
  }

  async handle(method, params = {}) {
    await this.#ready;
    switch (method) {
      case 'health': return { ok: true, runtime: 'independent', activeRuns: this.#runs.size, cognitive: this.#cognitiveStatus() };
      case 'cognitive.status': return this.#cognitiveStatus();
      case 'orchestrator.status': return { enabled: this.#cognitive.snapshot().orchestratorEnabled };
      case 'orchestrator.set': return this.#setOrchestrator(params.enabled);
      case 'background.status': return this.#backgroundStatus();
      case 'background.pause': return this.#setBackgroundPaused(true);
      case 'background.resume': return this.#setBackgroundPaused(false);
      case 'background.flush': return this.#flushBackground(params.sessionId);
      case 'session.mode.get': return { sessionId: params.sessionId, mode: this.#cognitive.mode(params.sessionId) };
      case 'session.mode.set': return this.#cognitive.setMode(params.sessionId, params.mode);
      case 'context.compact': return this.#compact(params);
      case 'plan.get': return this.#plans.toolResult(params.sessionId, params.request ?? { action: 'overview' });
      case 'memory.query': return this.#queryMemory(params);
      case 'project.list': return this.#projects.list();
      case 'project.get': return this.#projects.get(params.projectId);
      case 'project.open': return this.#projects.open(params.projectId);
      case 'project.add-local': return this.#addProject(() => this.#projects.addLocal({ id: `project_${randomUUID()}`, ...params }));
      case 'project.clone-url': return this.#addProject(() => this.#projects.cloneUrl({ id: `project_${randomUUID()}`, ...params }));
      case 'project.github-list': return this.#projects.listGithubRepositories(params);
      case 'project.github-clone': return this.#addProject(() => this.#projects.cloneGithubRepository({ id: `project_${randomUUID()}`, ...params }));
      case 'project.relocate': return this.#updateProject(() => this.#projects.relocate(params.projectId, params.path));
      case 'project.remove': {
        const result = await this.#projects.remove(params.projectId);
        this.#emit({ type: 'project.removed', projectId: params.projectId });
        return result;
      }
      case 'session.list': return this.#db.listSessions(params.projectId === undefined ? {} : { projectId: params.projectId });
      case 'session.create': return this.createSession(params.projectId ?? null);
      case 'session.get': return this.requireSession(params.sessionId);
      case 'session.send': return this.send(params);
      case 'session.stop': return this.stop(params.sessionId);
      default: throw new Error(`unknown runtime method: ${method}`);
    }
  }

  async #setOrchestrator(enabled) {
    const result = await this.#cognitive.setOrchestrator(enabled);
    this.#emit({ type: 'cognitive.updated', cognitive: this.#cognitiveStatus() });
    return result;
  }
  async #setBackgroundPaused(paused) {
    await this.#cognitive.setBackgroundPaused(paused);
    for (const worker of this.#backgrounds.values()) paused ? worker.pause() : worker.resume();
    this.#emit({ type: 'cognitive.updated', cognitive: this.#cognitiveStatus() });
    return { paused };
  }
  #backgroundStatus() {
    const state = this.#cognitive.snapshot();
    return { paused: state.backgroundPaused, workers: [...this.#backgrounds.entries()].map(([projectId, worker]) => ({ projectId, ...worker.stats })) };
  }
  #cognitiveStatus() {
    const state = this.#cognitive.snapshot();
    return {
      orchestratorEnabled: state.orchestratorEnabled,
      backgroundPaused: state.backgroundPaused,
      tst: this.#tst.status ?? { configured: false, connected: false },
      roles: { foreground: 'primary', plan: 'primary', background: 'secondary', orchestratorMaster: 'primary', worker: 'secondary' },
    };
  }
  async #compact(params) {
    const session = this.requireSession(params.sessionId);
    const prompt = typeof params.prompt === 'string' ? params.prompt : [...session.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    return this.#compiler.stmCompactionDirective({ sessionId: session.id, prompt, messages: session.messages, usableTokens: contextWindow(params.provider) });
  }
  async #queryMemory(params) {
    if (!this.#tst.configured) return { available: false, records: [], reason: 'TST is not configured' };
    try { return { available: true, records: await this.#tst.queryMemory(params.sessionId, String(params.query ?? ''), params.limit ?? 20) }; }
    catch (error) { return { available: false, records: [], reason: cleanError(error) }; }
  }
  async #flushBackground(sessionId) {
    const session = this.requireSession(sessionId);
    return this.#backgroundFor(session.projectId).flushNow(sessionId);
  }
  async #addProject(factory) { const project = await factory(); this.#emit({ type: 'project.created', project }); return project; }
  async #updateProject(factory) { const project = await factory(); this.#emit({ type: 'project.updated', project }); return project; }

  createSession(projectId = null) {
    if (projectId && !this.#db.getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
    const session = this.#db.createSession({ id: `session_${randomUUID()}`, projectId });
    this.#emit({ type: 'session.created', session });
    return session;
  }
  requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const session = this.#db.getSession(sessionId); if (!session) throw new Error(`unknown session: ${sessionId}`); return session;
  }

  async send(params) {
    const sessionId = params.sessionId; const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new Error('message text is required');
    if (this.#runs.has(sessionId)) throw new Error('this session is already generating');
    const existing = this.requireSession(sessionId);
    if (existing.projectId) {
      const project = await this.#projects.get(existing.projectId);
      if (project.missing) throw new Error(`Project folder is missing for ${project.name}. Relocate the project before continuing.`);
    }

    for (const worker of this.#backgrounds.values()) worker.foregroundStarted();
    const user = this.#db.appendMessage({ id: `msg_${randomUUID()}`, sessionId, role: 'user', content: text, status: 'complete' });
    this.#emit({ type: 'message.created', message: user });
    if (existing.title === 'New chat') {
      const renamed = this.#db.renameSession(sessionId, titleFromMessage(text)); this.#emit({ type: 'session.updated', session: renamed });
    }
    const assistant = this.#db.appendMessage({ id: `msg_${randomUUID()}`, sessionId, role: 'assistant', content: '', status: 'streaming' });
    this.#emit({ type: 'message.created', message: assistant });
    const controller = new AbortController();
    this.#runs.set(sessionId, { controller, assistantId: assistant.id, userId: user.id, userText: text, projectId: existing.projectId ?? null });
    this.#emit({ type: 'run.started', sessionId, messageId: assistant.id, projectId: existing.projectId ?? null, mode: this.#cognitive.mode(sessionId) });
    void this.#generate({ sessionId, assistantId: assistant.id, userId: user.id, provider: params.provider, signal: controller.signal });
    return { accepted: true, sessionId, messageId: assistant.id, projectId: existing.projectId ?? null, mode: this.#cognitive.mode(sessionId) };
  }

  stop(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const run = this.#runs.get(sessionId); if (!run) return { stopped: false, sessionId };
    run.controller.abort(); return { stopped: true, sessionId, messageId: run.assistantId, projectId: run.projectId };
  }

  async #generate({ sessionId, assistantId, userId, provider, signal }) {
    let completedMessage;
    try {
      const durable = this.#db.getSession(sessionId).messages.filter((message) => message.id !== assistantId && message.status !== 'streaming');
      const compiled = await this.#compiler.compile({ sessionId, messages: durable, usableTokens: contextWindow(provider), estimatedTokens: estimateMessages(durable), userMessageId: userId });
      this.#emit({ type: 'context.compiled', sessionId, mode: compiled.mode, injected: compiled.injected, trimmed: compiled.trimmed, budgetTokens: compiled.budgetTokens ?? 0, tst: compiled.tst });
      const adapter = this.#providerFactory(provider ?? {});
      await adapter.stream(compiled.messages.map(({ role, content }) => ({ role, content })), {
        signal,
        onDelta: async (delta) => {
          if (signal.aborted) return;
          const message = this.#db.appendMessageContent(assistantId, delta);
          this.#emit({ type: 'message.delta', sessionId, messageId: assistantId, delta, content: message.content });
        },
      });
      if (signal.aborted) throw abortError();
      completedMessage = this.#db.updateMessage(assistantId, { status: 'complete' });
      this.#emit({ type: 'message.completed', message: completedMessage });
    } catch (error) {
      const stopped = signal.aborted || error?.name === 'AbortError';
      const current = this.#db.getMessage(assistantId);
      completedMessage = this.#db.updateMessage(assistantId, { status: stopped ? 'stopped' : 'error', content: stopped ? current?.content ?? '' : current?.content || `Generation failed: ${cleanError(error)}` });
      this.#emit({ type: 'message.completed', message: completedMessage });
      if (!stopped) this.#emit({ type: 'runtime.error', sessionId, message: cleanError(error) });
    } finally {
      const run = this.#runs.get(sessionId); this.#runs.delete(sessionId);
      const session = this.#db.getSessionSummary(sessionId); if (session) this.#emit({ type: 'session.updated', session });
      this.#emit({ type: 'run.finished', sessionId, messageId: assistantId, projectId: run?.projectId ?? session?.projectId ?? null });
      if (run && completedMessage?.status === 'complete') {
        const worker = this.#backgroundFor(run.projectId);
        worker.setProviderConfig(provider ?? {});
        await worker.recordTurn({ sessionID: sessionId, projectID: run.projectId ?? 'general', userText: run.userText, assistantText: completedMessage.content }).catch(() => undefined);
        worker.foregroundIdle(sessionId);
      }
    }
  }

  #backgroundFor(projectId) {
    const key = projectId ?? 'general';
    let worker = this.#backgrounds.get(key);
    if (!worker) {
      worker = this.#backgroundFactory(key);
      if (this.#cognitive.snapshot().backgroundPaused) worker.pause();
      this.#backgrounds.set(key, worker);
      void worker.ready().catch(() => undefined);
    }
    return worker;
  }
}

function titleFromMessage(value) { const oneLine = value.replace(/\s+/g, ' ').trim(); return oneLine.length <= 56 ? oneLine : `${oneLine.slice(0, 53).trimEnd()}…`; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
function contextWindow(provider) { const value = Number(provider?.contextWindow ?? process.env.CUPPET_CONTEXT_WINDOW_TOKENS ?? 128000); return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 4096), 2_000_000) : 128000; }
function estimateMessages(messages) { return Math.ceil(messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / 4); }
function safeStoreName(value) { return String(value ?? 'general').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'general'; }
