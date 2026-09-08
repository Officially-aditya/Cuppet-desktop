import { randomUUID } from 'node:crypto';
import { ConversationDatabase } from './database.mjs';
import { OpenAICompatibleChatProvider } from './provider.mjs';

export class RuntimeService {
  #db;
  #emit;
  #providerFactory;
  #runs = new Map();

  constructor({ databasePath, emit = () => {}, providerFactory = (config) => new OpenAICompatibleChatProvider(config) }) {
    this.#db = new ConversationDatabase(databasePath);
    this.#emit = emit;
    this.#providerFactory = providerFactory;
  }

  close() {
    for (const run of this.#runs.values()) run.controller.abort();
    this.#runs.clear();
    this.#db.close();
  }

  async handle(method, params = {}) {
    switch (method) {
      case 'health': return { ok: true, runtime: 'independent', activeRuns: this.#runs.size };
      case 'session.list': return this.#db.listSessions();
      case 'session.create': return this.createSession();
      case 'session.get': return this.requireSession(params.sessionId);
      case 'session.send': return this.send(params);
      case 'session.stop': return this.stop(params.sessionId);
      default: throw new Error(`unknown runtime method: ${method}`);
    }
  }

  createSession() {
    const session = this.#db.createSession({ id: `session_${randomUUID()}` });
    this.#emit({ type: 'session.created', session });
    return session;
  }

  requireSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const session = this.#db.getSession(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  send(params) {
    const sessionId = params.sessionId;
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new Error('message text is required');
    if (this.#runs.has(sessionId)) throw new Error('this session is already generating');
    this.requireSession(sessionId);

    const user = this.#db.appendMessage({ id: `msg_${randomUUID()}`, sessionId, role: 'user', content: text, status: 'complete' });
    this.#emit({ type: 'message.created', message: user });

    const summary = this.#db.getSessionSummary(sessionId);
    if (summary?.title === 'New chat') {
      const renamed = this.#db.renameSession(sessionId, titleFromMessage(text));
      this.#emit({ type: 'session.updated', session: renamed });
    }

    const assistant = this.#db.appendMessage({ id: `msg_${randomUUID()}`, sessionId, role: 'assistant', content: '', status: 'streaming' });
    this.#emit({ type: 'message.created', message: assistant });

    const controller = new AbortController();
    this.#runs.set(sessionId, { controller, assistantId: assistant.id });
    this.#emit({ type: 'run.started', sessionId, messageId: assistant.id });
    void this.#generate({ sessionId, assistantId: assistant.id, provider: params.provider, signal: controller.signal });
    return { accepted: true, sessionId, messageId: assistant.id };
  }

  stop(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    const run = this.#runs.get(sessionId);
    if (!run) return { stopped: false, sessionId };
    run.controller.abort();
    return { stopped: true, sessionId, messageId: run.assistantId };
  }

  async #generate({ sessionId, assistantId, provider, signal }) {
    try {
      const completionMessages = this.#db.getSession(sessionId).messages
        .filter((message) => message.id !== assistantId && message.status !== 'streaming')
        .map(({ role, content }) => ({ role, content }));
      const adapter = this.#providerFactory(provider ?? {});
      await adapter.stream(completionMessages, {
        signal,
        onDelta: async (delta) => {
          if (signal.aborted) return;
          const message = this.#db.appendMessageContent(assistantId, delta);
          this.#emit({ type: 'message.delta', sessionId, messageId: assistantId, delta, content: message.content });
        },
      });
      if (signal.aborted) throw abortError();
      const complete = this.#db.updateMessage(assistantId, { status: 'complete' });
      this.#emit({ type: 'message.completed', message: complete });
    } catch (error) {
      const stopped = signal.aborted || error?.name === 'AbortError';
      const current = this.#db.getMessage(assistantId);
      const next = this.#db.updateMessage(assistantId, {
        status: stopped ? 'stopped' : 'error',
        content: stopped ? current?.content ?? '' : current?.content || `Generation failed: ${cleanError(error)}`,
      });
      this.#emit({ type: 'message.completed', message: next });
      if (!stopped) this.#emit({ type: 'runtime.error', sessionId, message: cleanError(error) });
    } finally {
      this.#runs.delete(sessionId);
      const session = this.#db.getSessionSummary(sessionId);
      if (session) this.#emit({ type: 'session.updated', session });
      this.#emit({ type: 'run.finished', sessionId, messageId: assistantId });
    }
  }
}

function titleFromMessage(value) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 56 ? oneLine : `${oneLine.slice(0, 53).trimEnd()}…`;
}

function cleanError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500);
}

function abortError() {
  const error = new Error('Generation stopped');
  error.name = 'AbortError';
  return error;
}
