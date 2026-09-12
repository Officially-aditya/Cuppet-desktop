import { ToolRuntime } from './tool-runtime.mjs';
import { ProviderRuntimeManager } from './providers/runtime-manager.mjs';
import { ExecutionKernel } from './execution/execution-kernel.mjs';
import { executionCapabilities } from './execution/execution-capabilities.mjs';
import { diffExecutionSnapshots } from './execution/benchmark.mjs';
import { activityFromLegacyProviderEvent, activityFromToolRuntimeEvent, isProviderActivity, providerActivity } from './providers/activity.mjs';

export class JournaledToolRuntime {
  #inner; #journal; #captures = new Map(); #emit; #db; #providerRuntimes; #executionKernel; #benchmark; #executionCapabilitySource;

  constructor({ journal, emit = () => {}, db = null, providerRuntimeManager = null, executionKernel = null, benchmark = undefined, ...options }) {
    this.#journal = journal;
    this.#emit = emit;
    this.#db = db;
    this.#benchmark = benchmark === undefined ? benchmarkFromEnvironment() : normalizeBenchmark(benchmark);
    this.#providerRuntimes = providerRuntimeManager ?? new ProviderRuntimeManager();
    this.#executionKernel = executionKernel ?? new ExecutionKernel({ emit: (event) => this.#safeEmit(event), benchmarkPolicy: this.#benchmark?.policy ?? 'optimized' });
    this.#executionCapabilitySource = {
      tst: options.tst,
      batchEdits: options.batchEdits,
      planStore: options.planStore,
      externalTools: options.externalTools,
    };
    this.#inner = new ToolRuntime({ ...options, db, emit: (event) => this.#onToolEvent(event) });
  }

  definitions(options) { return this.#inner.definitions(options); }
  executionCapabilities({ projectRoot = null, integrations = [] } = {}) {
    const browserEnabled = Array.isArray(integrations) && integrations.includes('browserControl');
    let browserAvailable = false;
    if (browserEnabled) {
      try {
        const definitions = this.#executionCapabilitySource.externalTools?.definitions?.();
        browserAvailable = Array.isArray(definitions) && definitions.length > 0;
      } catch {}
    }
    return executionCapabilities({
      projectBound: Boolean(projectRoot),
      tstConfigured: this.#executionCapabilitySource.tst?.configured === true,
      batchEditAvailable: Boolean(this.#executionCapabilitySource.batchEdits),
      planAvailable: typeof this.#executionCapabilitySource.planStore?.toolResult === 'function',
      browserAvailable,
    });
  }
  executionSnapshot(sessionId) { return this.#executionKernel.snapshot?.(sessionId) ?? null; }
  async forgetSession(sessionId) {
    this.#executionKernel.forget?.(sessionId);
    return this.#providerRuntimes.forget?.(sessionId) ?? false;
  }
  close() { return this.#providerRuntimes.close?.() ?? Promise.resolve(); }

  async run(options) {
    const messageId = latestAssistantMessageID(this.#db, options.sessionId);
    const benchmarkBefore = this.#benchmark ? this.executionSnapshot(options.sessionId) ?? {} : null;
    const benchmarkStartedAt = this.#benchmark ? Date.now() : 0;
    let benchmarkResult = null;
    let benchmarkError = null;
    const previewPolicy = providerPreviewPolicy(options.adapter);
    const adapter = this.#providerRuntimes.adapterFor({
      sessionId: options.sessionId,
      projectRoot: options.projectRoot,
      adapter: options.adapter,
    });
    const emitProviderActivity = (activity) => {
      if (!messageId || !isProviderActivity(activity)) return;
      this.#safeEmit({ type: 'runtime.activity', source: 'provider', sessionId: options.sessionId, messageId, activity });
    };
    const capture = new ToolMutationCapture({
      journal: this.#journal,
      sessionId: options.sessionId,
      messageId,
      projectRoot: options.projectRoot,
      adapter,
      previewPolicy,
      executionKernel: this.#executionKernel,
      onReasoning: (segment) => {
        if (!messageId || !segment) return;
        emitProviderActivity(providerActivity('activity.reasoning.delta', { text: segment }));
        // Temporary compatibility event for remote/older non-renderer consumers.
        this.#safeEmit({ type: 'message.reasoning', sessionId: options.sessionId, messageId, segment });
      },
      onPreview: (content) => {
        if (!messageId) return;
        this.#safeEmit({ type: 'message.preview', sessionId: options.sessionId, messageId, content });
      },
      onActivity: emitProviderActivity,
      onProviderEvent: (event) => {
        if (!messageId || !event || typeof event !== 'object') return;
        try {
          const activity = activityFromLegacyProviderEvent(event);
          if (activity) emitProviderActivity(activity);
        } catch {
          emitProviderActivity(providerActivity('activity.warning', {
            code: 'malformed_provider_event',
            message: 'Provider telemetry was ignored because it did not match the Cuppet Activity contract.',
          }));
        }
        // Keep legacy runtime events for remote/older consumers during migration.
        if (event.type === 'reasoning') {
          const segment = typeof event.text === 'string' ? event.text.trim() : '';
          if (segment) this.#safeEmit({ type: 'message.reasoning', sessionId: options.sessionId, messageId, segment });
          return;
        }
        if (event.type === 'tool.started' || event.type === 'tool.finished') {
          this.#safeEmit({ ...event, sessionId: options.sessionId, messageId });
        }
      },
    });
    this.#captures.set(options.sessionId, capture);
    try {
      benchmarkResult = await this.#inner.run({
        ...options,
        adapter: capture,
        onPaths: async (paths, mutation, details = null) => {
          await capture.onPaths(paths, mutation);
          await options.onPaths?.(paths, mutation, details);
        },
      });
      capture.assertHealthy();
      return benchmarkResult;
    } catch (error) {
      benchmarkError = error;
      throw error;
    } finally {
      if (this.#benchmark) {
        const after = this.executionSnapshot(options.sessionId) ?? {};
        this.#safeEmit({
          type: 'runtime.benchmark.sample',
          sessionId: options.sessionId,
          messageId: messageId || null,
          policy: this.#benchmark.policy,
          sample: {
            schemaVersion: 1,
            policy: this.#benchmark.policy,
            execution: diffExecutionSnapshots(benchmarkBefore ?? {}, after),
            usage: benchmarkResult?.usage ?? null,
            elapsedMs: Math.max(0, Date.now() - benchmarkStartedAt),
            ...(benchmarkError ? { error: cleanError(benchmarkError) } : {}),
          },
        });
      }
      if (this.#captures.get(options.sessionId) === capture) this.#captures.delete(options.sessionId);
    }
  }

  #onToolEvent(event) {
    const capture = this.#captures.get(event?.sessionId);
    capture?.onToolEvent(event);
    const decorated = capture ? capture.decorateToolEvent(event) : event;
    this.#safeEmit(decorated);
    let activity = null;
    try { activity = activityFromToolRuntimeEvent(decorated); } catch {}
    const messageId = String(decorated?.messageId ?? '');
    if (activity && messageId) {
      this.#safeEmit({
        type: 'runtime.activity',
        source: 'execution',
        sessionId: decorated.sessionId,
        messageId,
        activity,
      });
    }
  }

  #safeEmit(event) {
    try { this.#emit(event); } catch {}
  }
}

class ToolMutationCapture {
  #journal; #sessionId; #messageId; #projectRoot; #adapter; #previewPolicy; #executionKernel; #pending = new Map(); #calls = new Map(); #lastFinished = null; #failure = null; #onReasoning; #onPreview; #onActivity; #onProviderEvent;
  constructor({ journal, sessionId, messageId = '', projectRoot, adapter, previewPolicy = 'live', executionKernel, onReasoning = () => {}, onPreview = () => {}, onActivity = () => {}, onProviderEvent = () => {} }) {
    this.#journal = journal; this.#sessionId = sessionId; this.#messageId = messageId; this.#projectRoot = projectRoot; this.#adapter = adapter; this.#previewPolicy = previewPolicy; this.#executionKernel = executionKernel; this.#onReasoning = onReasoning; this.#onPreview = onPreview; this.#onActivity = onActivity; this.#onProviderEvent = onProviderEvent;
  }

  async stream(messages, options) {
    if (this.#failure) throw this.#failure;
    const finalDelta = typeof options?.onDelta === 'function' ? options.onDelta : async () => {};
    let pendingText = '';
    const previewDelta = (delta) => {
      const text = typeof delta === 'string' ? delta : String(delta ?? '');
      if (!text) return;
      pendingText += text;
      if (this.#previewPolicy !== 'defer-unclassified') this.#onPreview(pendingText);
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
          return this.#executionKernel.execute(call, {
            sessionId: this.#sessionId,
            projectRoot: this.#projectRoot,
            execute: options.executeTool,
          });
        }
      : undefined;
    const providerTools = this.#executionKernel.toolsForProvider?.(options?.tools, { sessionId: this.#sessionId, projectRoot: this.#projectRoot }) ?? options?.tools;
    let response;
    try {
      response = await this.#adapter.stream(messages, {
        ...options,
        tools: providerTools,
        onDelta: previewDelta,
        onActivity: async (activity) => this.#onActivity(activity),
        onProviderEvent: async (event) => this.#onProviderEvent(event),
        ...(executeTool ? { executeTool } : {}),
      });
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

function benchmarkFromEnvironment() {
  if (process.env.CUPPET_PROVIDER_BENCHMARK !== '1') return null;
  return normalizeBenchmark({ policy: process.env.CUPPET_EXECUTION_BENCHMARK_POLICY });
}
function normalizeBenchmark(value) {
  if (!value) return null;
  const source = value && typeof value === 'object' ? value : {};
  return { policy: source.policy === 'raw-baseline' ? 'raw-baseline' : 'optimized' };
}
function providerPreviewPolicy(adapter) {
  try {
    const managed = typeof adapter?.cuppetManagedRuntime === 'function' ? adapter.cuppetManagedRuntime() : null;
    const preview = managed?.descriptor?.textStream?.preview;
    return typeof preview === 'string' && preview.trim() ? preview.trim().toLowerCase() : 'live';
  } catch {
    return 'live';
  }
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
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? 'Unknown error')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 1000); }
