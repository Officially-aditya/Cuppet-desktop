import { ToolRuntime } from './tool-runtime.mjs';

export class JournaledToolRuntime {
  #inner; #journal; #captures = new Map(); #emit;

  constructor({ journal, emit = () => {}, ...options }) {
    this.#journal = journal;
    this.#emit = emit;
    this.#inner = new ToolRuntime({ ...options, emit: (event) => this.#onToolEvent(event) });
  }

  definitions(options) { return this.#inner.definitions(options); }

  async run(options) {
    const capture = new ToolMutationCapture({ journal: this.#journal, sessionId: options.sessionId, projectRoot: options.projectRoot, adapter: options.adapter });
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
    this.#captures.get(event?.sessionId)?.onToolEvent(event);
    this.#emit(event);
  }
}

class ToolMutationCapture {
  #journal; #sessionId; #projectRoot; #adapter; #pending = new Map(); #lastFinished = null; #failure = null;
  constructor({ journal, sessionId, projectRoot, adapter }) { this.#journal = journal; this.#sessionId = sessionId; this.#projectRoot = projectRoot; this.#adapter = adapter; }

  async stream(messages, options) {
    if (this.#failure) throw this.#failure;
    const executeTool = typeof options?.executeTool === 'function'
      ? async (call) => {
          await this.#prepareCall(call);
          return options.executeTool(call);
        }
      : undefined;
    const response = await this.#adapter.stream(messages, { ...options, ...(executeTool ? { executeTool } : {}) });
    if (!this.#journal || !this.#projectRoot) return response;
    for (const call of Array.isArray(response?.toolCalls) ? response.toolCalls : []) await this.#prepareCall(call);
    return response;
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

function parseArguments(value) {
  try { const decoded = JSON.parse(typeof value === 'string' ? value : '{}'); return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {}; }
  catch { return {}; }
}
