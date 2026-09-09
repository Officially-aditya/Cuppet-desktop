import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConversationDatabase } from './database.mjs';
import { createChatProvider } from './provider-factory.mjs';
import { ProjectManager } from './projects.mjs';
import { TstBridge } from './tst-client.mjs';
import { LosslessPlanStore } from './lossless-plan.mjs';
import { CognitiveStateStore } from './cognitive-state.mjs';
import { ContextCompiler } from './context-compiler.mjs';
import { BackgroundEnricher } from './background-enricher.mjs';
import { Pe3ProjectRouter } from './pe3/router.mjs';
import { PermissionBroker } from './permissions.mjs';
import { QuestionBroker } from './questions.mjs';
import { MutationJournal } from './mutation-journal.mjs';
import { JournaledToolRuntime } from './journaled-tool-runtime.mjs';
import { TstBatchEditManager } from './tst-edit-batches.mjs';
import { ProjectWriter } from './project-writer.mjs';
import { parseSlashCommand } from './commands.mjs';

export class RuntimeService {
  #db; #emit; #providerFactory; #runs = new Map(); #projects; #tst; #plans; #cognitive; #compiler; #permissions; #questions; #journal; #batchEdits; #writer; #tools; #backgrounds = new Map(); #backgroundFactory; #pe3Routers = new Map(); #pe3Factory; #dataDir; #ready; #closed = false;

  constructor({
    databasePath,
    dataDir = dirname(databasePath),
    emit = () => {},
    providerFactory = createChatProvider,
    projectManagerFactory = (db) => new ProjectManager({ db }),
    tst = new TstBridge(),
    planStore,
    cognitiveState,
    contextCompiler,
    permissionBroker,
    questionBroker,
    mutationJournal,
    batchEdits,
    projectWriter,
    toolRuntime,
    interactive = process.env.CUPPET_NONINTERACTIVE !== '1',
    backgroundFactory,
    pe3Factory,
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
    this.#permissions = permissionBroker ?? new PermissionBroker({ emit: this.#emit, interactive });
    this.#questions = questionBroker ?? new QuestionBroker({ emit: this.#emit, interactive });
    this.#journal = mutationJournal ?? new MutationJournal(join(dataDir, 'mutation-journal'));
    this.#writer = projectWriter ?? new ProjectWriter();
    this.#batchEdits = batchEdits ?? new TstBatchEditManager({ tst: this.#tst, journal: this.#journal, writer: this.#writer, emit: this.#emit });
    this.#tools = toolRuntime ?? new JournaledToolRuntime({ journal: this.#journal, tst: this.#tst, planStore: this.#plans, permissions: this.#permissions, questions: this.#questions, db: this.#db, batchEdits: this.#batchEdits, writer: this.#writer, emit: this.#emit });
    this.#backgroundFactory = backgroundFactory ?? ((projectId) => new BackgroundEnricher({ providerFactory: this.#providerFactory, tst: this.#tst, projectStore: join(this.#dataDir, 'background', safeStoreName(projectId)), projectID: projectId ?? 'general' }));
    this.#pe3Factory = pe3Factory ?? (({ projectId, projectRoot }) => new Pe3ProjectRouter({ projectId, projectRoot, projectStore: join(this.#dataDir, 'pe3', safeStoreName(projectId)), db: this.#db, tst: this.#tst }));
    this.#ready = this.#cognitive.ready();
  }

  close() {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    for (const run of this.#runs.values()) run.controller.abort();
    this.#runs.clear();
    this.#permissions.close?.();
    this.#questions.close?.();
    this.#tst.close?.();
    this.#db.close();
    return Promise.all([...this.#backgrounds.values()].map((worker) => worker.close().catch(() => undefined))).then(() => undefined);
  }

  async handle(method, params = {}) {
    await this.#ready;
    switch (method) {
      case 'health': return { ok: true, runtime: 'independent', activeRuns: this.#runs.size, activeProjectWriters: this.#writer.activeProjects, pendingPermissions: this.#permissions.list().length, pendingQuestions: this.#questions.list().length, cognitive: this.#cognitiveStatus(), pe3: { enabled: process.env.CUPPET_PE3 !== '0', projects: this.#pe3Routers.size } };
      case 'cognitive.status': return this.#cognitiveStatus();
      case 'orchestrator.status': return { enabled: this.#cognitive.snapshot().orchestratorEnabled };
      case 'orchestrator.set': return this.#setOrchestrator(params.enabled);
      case 'background.status': return this.#backgroundStatus();
      case 'background.pause': return this.#setBackgroundPaused(true);
      case 'background.resume': return this.#setBackgroundPaused(false);
      case 'background.flush': return this.#flushBackground(params.sessionId);
      case 'session.mode.get': return { sessionId: params.sessionId, mode: this.#cognitive.mode(params.sessionId) };
      case 'session.mode.set': return this.#cognitive.setMode(params.sessionId, params.mode);
      case 'session.auto.get': { const session = this.requireSession(params.sessionId); return this.#permissions.autoStatus(session.id); }
      case 'session.auto.set': {
        const session = this.requireSession(params.sessionId);
        if (params.enabled && !session.projectId) throw new Error('Guarded auto mode requires a project-bound session');
        return this.#permissions.setAuto(session.id, Boolean(params.enabled));
      }
      case 'permission.list': return this.#permissions.list(params.sessionId ?? null);
      case 'permission.reply': return this.#permissions.reply(params.requestId, params.reply);
      case 'question.list': return this.#questions.list(params.sessionId ?? null);
      case 'question.reply': return this.#questions.reply(params.requestId, params.answers);
      case 'question.reject': return this.#questions.reject(params.requestId);
      case 'context.compact': return this.#compact(params);
      case 'plan.get': return this.#plans.toolResult(params.sessionId, params.request ?? { action: 'overview' });
      case 'memory.query': return this.#queryMemory(params);
      case 'memory.remember': return this.#rememberMemory(params);
      case 'memory.forget': return this.#forgetMemory(params);
      case 'memory.clear': return this.#clearMemory(params);
      case 'pe3.status': return this.#pe3Status(params.sessionId ?? null, params.projectId ?? null);
      case 'pe3.observe-paths': return this.#pe3Observe(params.sessionId, params.paths, false);
      case 'pe3.workspace-mutation': return this.#pe3Observe(params.sessionId, params.paths, true);
      case 'project.list': return this.#projects.list();
      case 'project.get': return this.#projects.get(params.projectId);
      case 'project.open': return this.#projects.open(params.projectId);
      case 'project.add-local': return this.#addProject(() => this.#projects.addLocal({ id: `project_${randomUUID()}`, ...params }));
      case 'project.clone-url': return this.#addProject(() => this.#projects.cloneUrl({ id: `project_${randomUUID()}`, ...params }));
      case 'project.github-list': return this.#projects.listGithubRepositories(params);
      case 'project.github-clone': return this.#addProject(() => this.#projects.cloneGithubRepository({ id: `project_${randomUUID()}`, ...params }));
      case 'project.relocate': {
        const project = await this.#updateProject(() => this.#projects.relocate(params.projectId, params.path));
        this.#pe3Routers.delete(project.id);
        return project;
      }
      case 'project.remove': {
        const result = await this.#projects.remove(params.projectId);
        this.#pe3Routers.delete(params.projectId);
        this.#emit({ type: 'project.removed', projectId: params.projectId });
        return result;
      }
      case 'session.list': return this.#db.listSessions(params.projectId === undefined ? {} : { projectId: params.projectId });
      case 'session.create': return this.createSession(params.projectId ?? null);
      case 'session.get': return this.requireSession(params.sessionId);
      case 'session.send': return this.send(params);
      case 'session.steer': return this.#steer(params);
      case 'session.stop': return this.stop(params.sessionId);
      case 'session.undo.status': return this.#journal.status(this.requireSession(params.sessionId).id);
      case 'session.undo': return this.#undo(params.sessionId);
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
    const userMessageId = [...session.messages].reverse().find((message) => message.role === 'user')?.id;
    return this.#compiler.stmCompactionDirective({ sessionId: session.id, prompt, messages: session.messages, usableTokens: contextWindow(params.provider), estimatedTokens: estimateMessages(session.messages), userMessageId });
  }
  async #queryMemory(params) {
    if (!this.#tst.configured) return { available: false, records: [], reason: 'TST is not configured' };
    try { return { available: true, records: await this.#tst.queryMemory(params.sessionId, String(params.query ?? ''), params.limit ?? 20) }; }
    catch (error) { return { available: false, records: [], reason: cleanError(error) }; }
  }
  async #rememberMemory(params) {
    const session = this.requireSession(params.sessionId);
    if (!this.#tst.configured) throw new Error('TST is not configured');
    const key = String(params.key ?? '').trim().slice(0, 240);
    const value = String(params.value ?? '').trim().slice(0, 4000);
    if (!key || !value) throw new Error('memory remember requires key and value');
    return this.#tst.rememberMemory(session.id, { key, value, scope: memoryScope(params.scope), pinned: params.pinned === true });
  }
  async #forgetMemory(params) {
    const session = this.requireSession(params.sessionId);
    if (!this.#tst.configured) throw new Error('TST is not configured');
    const key = String(params.key ?? '').trim().slice(0, 240);
    if (!key) throw new Error('memory forget requires key');
    return this.#tst.forgetMemory(session.id, key);
  }
  async #clearMemory(params) {
    const session = this.requireSession(params.sessionId);
    if (!this.#tst.configured) throw new Error('TST is not configured');
    return this.#tst.clearMemory(session.id, memoryScope(params.scope));
  }
  async #flushBackground(sessionId) {
    const session = this.requireSession(sessionId);
    return this.#backgroundFor(session.projectId).flushNow(sessionId);
  }
  async #pe3Status(sessionId, projectId) {
    const session = sessionId ? this.requireSession(sessionId) : null;
    const id = projectId ?? session?.projectId;
    if (!id) return { enabled: false, reason: 'PE3 requires a project-bound chat' };
    const project = await this.#projects.get(id);
    const router = await this.#pe3For(id, project);
    return { enabled: process.env.CUPPET_PE3 !== '0', ...router.status() };
  }
  async #pe3Observe(sessionId, paths, mutation) {
    const session = this.requireSession(sessionId);
    if (!session.projectId) return { observed: false, reason: 'PE3 requires a project-bound chat' };
    const boundedPaths = Array.isArray(paths) ? paths.slice(0, 64).map((value) => String(value).slice(0, 512)) : [];
    const project = await this.#projects.get(session.projectId);
    const router = await this.#pe3For(session.projectId, project);
    if (mutation) await router.noteWorkspaceMutation(sessionId, boundedPaths); else await router.noteObservedPaths(sessionId, boundedPaths);
    return { observed: true, mutation, sessionId, paths: boundedPaths };
  }
  async #recordValidation(sessionId, validation) {
    if (!validation || validation.kind !== 'tst_validate' || !validation.success || !this.#tst.configured) return { recorded: false };
    const fileHashes = validation.fileHashes && typeof validation.fileHashes === 'object' ? validation.fileHashes : {};
    if (!Object.keys(fileHashes).length) return { recorded: false };
    const commandText = (validation.commands ?? []).map((item) => `${item.command} [${item.exitCode}]`).join('; ').slice(0, 1200);
    const observed = await this.#tst.observeMemory(sessionId, {
      key: `validation:${Object.keys(fileHashes).sort().join(',').slice(0, 120)}`,
      value: `Validation passed for current workspace hashes using: ${commandText}`,
      kind: 'behavioral_claim', scope: 'session', provenance: 'verifier', file_hashes: fileHashes,
    });
    const memoryId = observed?.id;
    if (!memoryId) return { recorded: false };
    for (const item of validation.commands ?? []) {
      if (item?.exitCode === 0 && item?.command) {
        await this.#tst.recordEvidence(sessionId, memoryId, 'command_success', `validation:${String(item.command).slice(0, 420)}`, true).catch(() => undefined);
      }
    }
    for (const [path, hash] of Object.entries(fileHashes)) {
      await this.#tst.recordEvidence(sessionId, memoryId, 'content_hash', `validation:${path}:${commandText}`, true, hash).catch(() => undefined);
    }
    return { recorded: true, memoryId };
  }
  async #refreshMutationGraph(paths) {
    if (!this.#tst.configured || !paths?.length) return { refreshed: false, reason: 'TST unavailable or no paths' };
    try { return { refreshed: true, result: await this.#tst.refreshGraphPaths(paths) }; }
    catch (error) { this.#emit({ type: 'graph.refresh.failed', paths, message: cleanError(error) }); return { refreshed: false, reason: cleanError(error) }; }
  }
  async #undo(sessionId) {
    const session = this.requireSession(sessionId);
    if (this.#runs.has(session.id)) throw new Error('Cannot undo while this session is generating. Stop it first.');
    if (!session.projectId) throw new Error('Undo requires a project-bound session.');
    const project = await this.#projects.get(session.projectId);
    if (!project || project.missing) throw new Error('Undo requires the original project workspace to be available.');
    const result = await this.#writer.withProject(project.canonicalPath, () => this.#journal.undoLatest({ sessionId: session.id, projectRoot: project.canonicalPath }));
    const paths = Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : [];
    if (result.undone && paths.length) {
      await this.#refreshMutationGraph(paths);
      if (process.env.CUPPET_PE3 !== '0') await this.#pe3Observe(session.id, paths, true).catch(() => undefined);
      this.#emit({ type: 'mutation.undone', sessionId: session.id, projectId: session.projectId, mutationId: result.mutationId, path: result.path ?? null, paths, tool: result.tool });
      this.#emit({ type: 'session.updated', session: this.#db.getSessionSummary(session.id) });
    }
    return result;
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
    const sourceSessionId = params.sessionId; const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new Error('message text is required');
    const slash = parseSlashCommand(text);
    if (slash.kind === 'command') throw new Error(`Slash command /${slash.name} must be executed through the command registry`);
    if (slash.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${slash.name}`);
    if (this.#runs.has(sourceSessionId)) throw new Error('this session is already generating');
    const existing = this.requireSession(sourceSessionId);
    const projectBinding={projectId:existing.projectId??null};
    let project = null;
    if (existing.projectId) {
      project = await this.#projects.get(existing.projectId);
      if (project.missing) throw new Error(`Project folder is missing for ${project.name}. Relocate the project before continuing.`);
    }

    for (const worker of this.#backgrounds.values()) worker.foregroundStarted();
    const ids = { user: `msg_${randomUUID()}`, assistant: `msg_${randomUUID()}`, marker: `msg_${randomUUID()}` };
    let route = fallbackRoute(sourceSessionId, existing.projectId, 'PE3 not applicable');
    let router;
    if (existing.projectId && process.env.CUPPET_PE3 !== '0') {
      try {
        router = await this.#pe3For(existing.projectId, project);
        route = await router.prepare({ sourceSessionId, prompt: text, attachments: params.attachments });
        route = router.accept(route.token, { targetAvailable: (targetSessionId) => !this.#runs.has(targetSessionId) });
      } catch (error) {
        if (router && route?.token) router.abort(route.token, cleanError(error));
        route = fallbackRoute(sourceSessionId, existing.projectId, `PE3 preserved source after routing fallback: ${cleanError(error)}`);
        router = undefined;
      }
    }

    let delivery;
    if (router && route.state === 'accepted') {
      try {
        const committed = await router.commit(route.token, (tx) => this.#db.transaction(() => this.#writeRoutedTurn({ tx, ids, text, projectId: existing.projectId })));
        route = committed.route;
        delivery = committed.result;
      } catch (error) {
        router.abort(route.token, cleanError(error));
        route = fallbackRoute(sourceSessionId, existing.projectId, `PE3 handoff aborted; source preserved: ${cleanError(error)}`);
        delivery = this.#db.transaction(() => this.#writeDirectTurn({ sessionId: sourceSessionId, ids, text }));
      }
    } else {
      delivery = this.#db.transaction(() => this.#writeDirectTurn({ sessionId: sourceSessionId, ids, text }));
    }

    const targetSessionId = delivery.user.sessionId;
    if (delivery.createdSession) this.#emit({ type: 'session.created', session: delivery.createdSession });
    if (delivery.sourceSession) this.#emit({ type: 'session.updated', session: delivery.sourceSession });
    if (delivery.targetSession) this.#emit({ type: 'session.updated', session: delivery.targetSession });
    if (route.action !== 'continue') this.#emit({ type: 'pe3.routed', ...route });
    this.#emit({ type: 'message.created', message: delivery.user });
    this.#emit({ type: 'message.created', message: delivery.assistant });

    const controller = new AbortController();
    this.#runs.set(targetSessionId, { controller, assistantId: delivery.assistant.id, userId: delivery.user.id, userText: text, projectId:existing.projectId??null, projectRoot:project?.canonicalPath??null, sourceSessionId, route });
    this.#emit({ type: 'run.started', sessionId: targetSessionId, sourceSessionId, messageId: delivery.assistant.id, projectId: projectBinding.projectId, mode: this.#cognitive.mode(targetSessionId), pe3: route });
    void this.#generate({ sessionId: targetSessionId, assistantId: delivery.assistant.id, userId: delivery.user.id, provider: params.provider, signal: controller.signal, projectId: existing.projectId ?? null, projectRoot: project?.canonicalPath ?? null, refreshPaths: route.refreshPaths ?? [], attachments: route.attachments ?? [] });
    return { accepted: true, sessionId: targetSessionId, sourceSessionId, messageId: delivery.assistant.id, projectId: projectBinding.projectId, mode: this.#cognitive.mode(targetSessionId), pe3: route };
  }

  #writeRoutedTurn({ tx, ids, text, projectId }) {
    let createdSession = null;
    if (tx.action === 'create') createdSession = this.#db.createSession({ id: tx.targetSessionId, projectId, title: titleFromMessage(text) });
    let sourceSession = null;
    if (tx.targetSessionId !== tx.sourceSessionId) {
      this.#db.appendMessage({ id: ids.marker, sessionId: tx.sourceSessionId, role: 'system', content: routingMarker(tx), status: 'complete' });
      sourceSession = this.#db.getSessionSummary(tx.sourceSessionId);
    }
    const targetBefore = this.#db.getSessionSummary(tx.targetSessionId);
    const user = this.#db.appendMessage({ id: ids.user, sessionId: tx.targetSessionId, role: 'user', content: text, status: 'complete' });
    if (!createdSession && targetBefore?.title === 'New chat') this.#db.renameSession(tx.targetSessionId, titleFromMessage(text));
    const assistant = this.#db.appendMessage({ id: ids.assistant, sessionId: tx.targetSessionId, role: 'assistant', content: '', status: 'streaming' });
    return { user, assistant, createdSession, sourceSession, targetSession: this.#db.getSessionSummary(tx.targetSessionId) };
  }
  #writeDirectTurn({ sessionId, ids, text }) {
    const before = this.#db.getSessionSummary(sessionId);
    const user = this.#db.appendMessage({ id: ids.user, sessionId, role: 'user', content: text, status: 'complete' });
    if (before?.title === 'New chat') this.#db.renameSession(sessionId, titleFromMessage(text));
    const assistant = this.#db.appendMessage({ id: ids.assistant, sessionId, role: 'assistant', content: '', status: 'streaming' });
    return { user, assistant, createdSession: null, sourceSession: null, targetSession: this.#db.getSessionSummary(sessionId) };
  }

  stop(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const run = this.#runs.get(sessionId); if (!run) return { stopped: false, sessionId };
    run.controller.abort(); return { stopped: true, sessionId, messageId: run.assistantId, projectId: run.projectId };
  }

  async #steer(params) {
    const sessionId = String(params.sessionId ?? '');
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!sessionId) throw new Error('sessionId is required');
    if (!text) throw new Error('steer text is required');
    this.requireSession(sessionId);
    if (this.#runs.has(sessionId)) this.stop(sessionId);
    for (let attempt = 0; attempt < 250; attempt++) {
      if (!this.#runs.has(sessionId)) return this.send({ sessionId, text, provider: params.provider ?? {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('session did not stop before steer');
  }

  async #generate({ sessionId, assistantId, userId, provider, signal, projectId = null, projectRoot = null, refreshPaths = [], attachments = [] }) {
    let completedMessage;
    try {
      const durable = this.#db.getSession(sessionId).messages.filter((message) => message.id !== assistantId && message.status !== 'streaming');
      const compiled = await this.#compiler.compile({ sessionId, messages: durable, usableTokens: contextWindow(provider), estimatedTokens: estimateMessages(durable), userMessageId: userId });
      const providerMessages = injectPe3Context(compiled.messages, refreshPaths, attachments);
      this.#emit({ type: 'context.compiled', sessionId, mode: compiled.mode, injected: compiled.injected || providerMessages.length !== compiled.messages.length, trimmed: compiled.trimmed, budgetTokens: compiled.budgetTokens ?? 0, tst: compiled.tst });
      const adapter = this.#providerFactory(provider ?? {});
      await this.#tools.run({
        adapter,
        messages: providerMessages.map(({ role, content }) => ({ role, content })),
        sessionId,
        projectId,
        projectRoot,
        mode: this.#cognitive.mode(sessionId),
        signal,
        onDelta: async (delta) => {
          if (signal.aborted || this.#closed) return;
          const message = this.#db.appendMessageContent(assistantId, delta);
          this.#emit({ type: 'message.delta', sessionId, messageId: assistantId, delta, content: message.content });
        },
        onPaths: async (paths, mutation, details = null) => {
          if (mutation && details?.graphHandled !== true) await this.#refreshMutationGraph(paths);
          if (!projectId || process.env.CUPPET_PE3 === '0') return;
          await this.#pe3Observe(sessionId, paths, mutation);
        },
        onValidation: async (validation) => {
          await this.#recordValidation(sessionId, validation).catch(() => undefined);
          this.#emit({ type: 'validation.completed', sessionId, validation });
        },
      });
      if (signal.aborted || this.#closed) throw abortError();
      completedMessage = this.#db.updateMessage(assistantId, { status: 'complete' });
      this.#emit({ type: 'message.completed', message: completedMessage });
    } catch (error) {
      if (this.#closed) return;
      const stopped = signal.aborted || error?.name === 'AbortError';
      const current = this.#db.getMessage(assistantId);
      completedMessage = this.#db.updateMessage(assistantId, { status: stopped ? 'stopped' : 'error', content: stopped ? current?.content ?? '' : current?.content || `Generation failed: ${cleanError(error)}` });
      this.#emit({ type: 'message.completed', message: completedMessage });
      if (!stopped) this.#emit({ type: 'runtime.error', sessionId, message: cleanError(error) });
    } finally {
      if (this.#closed) return;
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

  async #pe3For(projectId, project) {
    let pending = this.#pe3Routers.get(projectId);
    if (!pending) {
      pending = (async () => {
        const resolved = project ?? await this.#projects.get(projectId);
        const router = this.#pe3Factory({ projectId, projectRoot: resolved.canonicalPath });
        await router.ready();
        return router;
      })();
      this.#pe3Routers.set(projectId, pending);
      pending.catch(() => { if (this.#pe3Routers.get(projectId) === pending) this.#pe3Routers.delete(projectId); });
    }
    return pending;
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

function fallbackRoute(sessionId, projectId, reason) { return { token: null, state: 'committed', projectId, sourceSessionId: sessionId, targetSessionId: sessionId, action: 'continue', reason, affinity: { score: 0, pathOverlap: 0, symbolOverlap: 0, termOverlap: 0, lexicalRatio: 0, weightedOverlap: 0 }, refreshPaths: [], attachments: [] }; }
function routingMarker(tx) { return `[PE3 routing marker] action=${tx.action} target=${tx.targetSessionId} reason=${String(tx.reason).replace(/\s+/g, ' ').slice(0, 220)}`; }
function injectPe3Context(messages, refreshPaths, attachments) {
  const blocks = [];
  if (refreshPaths.length) blocks.push(`<CUPPET_PE3_REFRESH ephemeral="true">\nThe workspace changed while this task was dormant. Refresh these paths from current filesystem truth before relying on old file-specific assumptions: ${refreshPaths.slice(0, 12).join(', ')}\n</CUPPET_PE3_REFRESH>`);
  if (attachments.length) blocks.push(`<CUPPET_PE3_ATTACHMENTS ephemeral="true">\nAttachment metadata routed with this turn (metadata only; do not invent unread contents):\n${attachments.slice(0, 16).map((item) => `- ${[item.name, item.path, item.mime, Number.isFinite(item.size) ? `${item.size} bytes` : ''].filter(Boolean).join(' · ')}`).join('\n')}\n</CUPPET_PE3_ATTACHMENTS>`);
  if (!blocks.length) return messages.map((message) => ({ ...message }));
  const output = messages.map((message) => ({ ...message })); let index = output.length - 1; while (index >= 0 && output[index].role !== 'user') index--;
  output.splice(Math.max(0, index), 0, { role: 'system', content: blocks.join('\n\n') }); return output;
}
function titleFromMessage(value) { const oneLine = value.replace(/\s+/g, ' ').trim(); return oneLine.length <= 56 ? oneLine : `${oneLine.slice(0, 53).trimEnd()}…`; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
function contextWindow(provider) { const value = Number(provider?.contextWindow ?? process.env.CUPPET_CONTEXT_WINDOW_TOKENS ?? 128000); return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 4096), 2_000_000) : 128000; }
function estimateMessages(messages) { return Math.ceil(messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / 4); }
function safeStoreName(value) { return String(value ?? 'general').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'general'; }
function memoryScope(value) { const scope = String(value ?? 'session').toLowerCase(); return ['session', 'project', 'global'].includes(scope) ? scope : 'session'; }
