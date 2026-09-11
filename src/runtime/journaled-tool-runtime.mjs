import { ToolRuntime } from './tool-runtime.mjs';

export class JournaledToolRuntime {
  #inner; #journal; #captures = new Map(); #emit; #db;

  constructor({ journal, emit = () => {}, db = null, ...options }) {
    this.#journal = journal;
    this.#emit = emit;
    this.#db = db;
    this.#inner = new ToolRuntime({ ...options, db, emit: (event) => this.#onToolEvent(event) });
  }

  definitions(options) { return this.#inner.definitions(options); }

  async run(options) {
    const messageId = latestAssistantMessageID(this.#db, options.sessionId);
    const capture = new ToolMutationCapture({
      journal: this.#journal,
      sessionId: options.sessionId,
      messageId,
      projectRoot: options.projectRoot,
      adapter: options.adapter,
      onReasoning: (segment) => {
        if (!messageId || !segment) return;
        this.#emit({ type: 'message.reasoning', sessionId: options.sessionId, messageId, segment });
      },
      onPreview: (content) => {
        if (!messageId) return;
        this.#emit({ type: 'message.preview', sessionId: options.sessionId, messageId, content });
      },
      onProviderEvent: (event) => {
        if (!messageId || !event || typeof event !== 'object') return;
        if (event.type === 'reasoning') {
          const segment = typeof event.text === 'string' ? event.text.trim() : '';
          if (segment) this.#emit({ type: 'message.reasoning', sessionId: options.sessionId, messageId, segment });
          return;
        }
        if (event.type === 'tool.started' || event.type === 'tool.finished') {
          this.#emit({ ...event, sessionId: options.sessionId, messageId });
        }
      },
    });
    this.#captures.set(options.sessionId, capture);
    try {
      const result = await this.#inner.run({
        ...options,
        adapter: capture,
        onPaths: async (paths, mutation, details = null) => {
          await capture.onPaths(paths, mutation);
          await options.onPaths?.(paths, mutation, details);
        },
      });
      capture.assertHealthy();
      return result;
    } finally {
      if (this.#captures.get(options.sessionId) === capture) this.#captures.delete(options.sessionId);
    }
  }

  #onToolEvent(event) {
    const capture = this.#captures.get(event?.sessionId);
    capture?.onToolEvent(event);
    this.#emit(capture ? capture.decorateToolEvent(event) : event);
  }
}

class ToolMutationCapture {
  #journal; #sessionId; #messageId; #projectRoot; #adapter; #pending = new Map(); #calls = new Map(); #lastFinished = null; #failure = null; #onReasoning; #onPreview; #onProviderEvent;
  constructor({ journal, sessionId, messageId = '', projectRoot, adapter, onReasoning = () => {}, onPreview = () => {}, onProviderEvent = () => {} }) {
    this.#journal = journal; this.#sessionId = sessionId; this.#messageId = messageId; this.#projectRoot = projectRoot; this.#adapter = adapter; this.#onReasoning = onReasoning; this.#onPreview = onPreview; this.#onProviderEvent = onProviderEvent;
  }

  async stream(messages, options) {
    if (this.#failure) throw this.#failure;
    const finalDelta = typeof options?.onDelta === 'function' ? options.onDelta : async () => {};
    let pendingText = '';
    const previewDelta = (delta) => {
      const text = typeof delta === 'string' ? delta : String(delta ?? '');
      if (!text) return;
      pendingText += text;
      this.#onPreview(pendingText);
    };
    const flushReasoning = async () => {
      const segment = pendingText.trim();
      if (segment) await this.#onReasoning(segment);
      pendingText = '';
      this.#onPreview('');
    };
    const executeTool = typeof options?.executeTool === 'function'
      ? async (call) => {
          await flushReasoning();
          this.#rememberCall(call);
          await this.#prepareCall(call);
          return options.executeTool(call);
        }
      : undefined;
    let response;
    try {
      response = await this.#adapter.stream(messages, { ...options, onDelta: previewDelta, onProviderEvent: async (event) => this.#onProviderEvent(event), ...(executeTool ? { executeTool } : {}) });
    } catch (error) {
      this.#onPreview('');
      throw error;
    }
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.length) {
      await flushReasoning();
      for (const call of toolCalls) this.#rememberCall(call);
      if (this.#journal && this.#projectRoot) for (const call of toolCalls) await this.#prepareCall(call);
      return response;
    }
    if (!pendingText && typeof response?.text === 'string') pendingText = response.text;
    if (pendingText) await finalDelta(pendingText);
    pendingText = '';
    this.#onPreview('');
    return response;
  }

  #rememberCall(call) {
    const callId = String(call?.id || '');
    if (!callId) return;
    this.#calls.set(callId, {
      tool: String(call?.name || ''),
      argumentsJson: typeof call?.arguments === 'string' ? call.arguments : '{}',
    });
  }

  decorateToolEvent(event) {
    const call = this.#calls.get(String(event?.callId || ''));
    return {
      ...event,
      ...(this.#messageId ? { messageId: this.#messageId } : {}),
      ...(call?.tool ? { tool: call.tool } : {}),
      ...(call?.argumentsJson ? { argumentsJson: call.argumentsJson } : {}),
    };
  }

  async #prepareCall(call) {
    if (!this.#journal || !this.#projectRoot || this.#failure) return;
    const callId = String(call?.id || '');
    if (this.#pending.has(callId)) return;
    if (call?.name === 'workspace_edit' || call?.name === 'workspace_write') {
      const args = parseArguments(call.arguments);
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) return;
      const token = await this.#journal.beginFile({ sessionId: this.#sessionId, executionId: callId, tool: call.name, projectRoot: this.#projectRoot, path });
      this.#pending.set(callId, { kind: 'file', token });
    } else if (call?.name === 'bash') {
      this.#pending.set(callId, { kind: 'barrier', tool: 'bash' });
    }
  }

  onToolEvent(event) {
    if (event?.type !== 'tool.finished') return;
    const callId = String(event.callId || '');
    const pending = this.#pending.get(callId);
    if (!pending) return;
    if (event.success !== true) { this.#pending.delete(callId); return; }
    this.#lastFinished = { callId, pending, event };
  }

  async onPaths(paths, mutation) {
    const finished = this.#lastFinished;
    this.#lastFinished = null;
    if (!finished) return;
    this.#pending.delete(finished.callId);
    try {
      if (finished.pending.kind === 'file') {
        finished.pending.token.executionId = String(finished.event.executionId || finished.pending.token.executionId || finished.callId);
        await this.#journal.commitFile(finished.pending.token);
      } else if (finished.pending.kind === 'barrier' && mutation) {
        await this.#journal.recordBarrier({ sessionId: this.#sessionId, executionId: String(finished.event.executionId || finished.callId), tool: 'bash', paths, reason: 'Shell mutation has no byte-exact preimage; undo will not cross this boundary.' });
      }
    } catch (error) { this.#failure = error instanceof Error ? error : new Error(String(error)); throw this.#failure; }
  }

  assertHealthy() { if (this.#failure) throw this.#failure; }
}

function latestAssistantMessageID(db, sessionId) {
  try {
    const messages = db?.getSession?.(sessionId)?.messages;
    if (!Array.isArray(messages)) return '';
    return String([...messages].reverse().find((message) => message?.role === 'assistant' && message?.status === 'streaming')?.id ?? '');
  } catch { return ''; }
}

function parseArguments(value) {
  try { const decoded = JSON.parse(typeof value === 'string' ? value : '{}'); return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {}; }
  catch { return {}; }
}
