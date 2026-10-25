import { ToolRuntime } from './tool-runtime.mjs';
import { redactCredentials } from './credential-sanitization.mjs';
import { ProviderRuntimeManager } from './providers/runtime-manager.mjs';
import { ExecutionKernel } from './execution/execution-kernel.mjs';
import { executionCapabilities } from './execution/execution-capabilities.mjs';
import { diffExecutionSnapshots } from './execution/benchmark.mjs';
import { activityFromToolRuntimeEvent, isProviderActivity, providerActivity } from './providers/activity.mjs';

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
  async close() { await Promise.all([Promise.resolve(this.#inner.close?.()), Promise.resolve(this.#providerRuntimes.close?.())]); }

  async run(options) {
    const initialMessageId = latestAssistantMessageID(this.#db, options.sessionId);
    const currentMessageId = () => options.getAssistantMessageId?.() || latestAssistantMessageID(this.#db, options.sessionId) || initialMessageId;
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
    let textRunMessageId = null;
    let pendingReasoning = null;
    let reasoningTimer = null;
    const flushReasoning = () => {
      clearTimeout(reasoningTimer);
      reasoningTimer = null;
      if (!pendingReasoning) return;
      const pending = pendingReasoning;
      pendingReasoning = null;
      this.#emitActivity({ source: 'provider', sessionId: options.sessionId, ...pending });
    };
    const flushActivities = () => { flushReasoning(); textRunMessageId = null; };
    const emitProviderActivity = (activity) => {
      const messageId = currentMessageId();
      if (!messageId || !isProviderActivity(activity)) return;
      if (activity.type === 'activity.reasoning.delta') {
        textRunMessageId = null;
        if (pendingReasoning && (pendingReasoning.messageId !== messageId || pendingReasoning.activity.kind !== activity.kind)) flushReasoning();
        if (!pendingReasoning) pendingReasoning = { messageId, activity: { ...activity } };
        else {
          const previous = pendingReasoning.activity;
          pendingReasoning.activity = { ...previous, ...activity, text: previous.text + activity.text,
            ...(previous.startedAt !== undefined ? { startedAt: previous.startedAt } : {}) };
        }
        if (!reasoningTimer) {
          reasoningTimer = setTimeout(flushReasoning, 50);
          reasoningTimer.unref?.();
        }
        return;
      }
      flushReasoning();
      if (activity.type === 'activity.text.delta') {
        if (textRunMessageId === messageId) return;
        textRunMessageId = messageId;
      } else textRunMessageId = null;
      this.#emitActivity({ source: 'provider', sessionId: options.sessionId, messageId, activity });
    };
    const capture = new ToolMutationCapture({
      journal: this.#journal,
      sessionId: options.sessionId,
      getMessageId: currentMessageId,
      projectRoot: options.projectRoot,
      adapter,
      previewPolicy,
      contextWindow: options.contextWindow,
      executionKernel: this.#executionKernel,
      takeSteering: options.takeSteering,
      applySteering: (...args) => { flushActivities(); return options.applySteering?.(...args) ?? []; },
      flushActivities,
      onReasoning: (segment, timing) => {
        if (!currentMessageId() || !segment) return;
        emitProviderActivity(providerActivity('activity.reasoning.delta', { text: segment, kind: 'commentary', ...timing }));
      },
      onPreview: (preview) => {
        const messageId = currentMessageId();
        if (!messageId) return;
        this.#safeEmit({ type: 'message.preview', sessionId: options.sessionId, messageId, ...preview });
      },
      onActivity: emitProviderActivity,
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
      flushActivities();
      if (this.#benchmark) {
        const after = this.executionSnapshot(options.sessionId) ?? {};
        this.#safeEmit({
          type: 'runtime.benchmark.sample',
          sessionId: options.sessionId,
          messageId: currentMessageId() || null,
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
    capture?.flushActivities();
    capture?.onToolEvent(event);
    const decorated = capture ? capture.decorateToolEvent(event) : event;
    this.#safeEmit(decorated);
    let activity = null;
    try { activity = activityFromToolRuntimeEvent(decorated); } catch {}
    const messageId = String(decorated?.messageId ?? '');
    if (activity && messageId) {
      this.#emitActivity({
        source: 'execution',
        sessionId: decorated.sessionId,
        messageId,
        activity,
      });
    }
  }

  #emitActivity({ source, sessionId, messageId, activity }) {
    let persisted = null;
    try {
      persisted = this.#db?.appendMessageActivity?.({ sessionId, messageId, source, activity }) ?? null;
    } catch {
      // Activity persistence must never break foreground generation. The event
      // still reaches live clients, but the renderer will not pretend it is durable.
    }
    this.#safeEmit({
      type: 'runtime.activity',
      source,
      sessionId,
      messageId,
      activity,
      createdAt: persisted?.createdAt ?? Date.now(),
      ...(persisted?.sequence !== undefined ? { sequence: persisted.sequence } : {}),
    });
  }

  #safeEmit(event) {
    try { this.#emit(event); } catch {}
  }
}

class ToolMutationCapture {
  #journal; #sessionId; #getMessageId; #projectRoot; #adapter; #previewPolicy; #contextWindow; #executionKernel; #takeSteering; #applySteering; #pending = new Map(); #calls = new Map(); #lastFinished = null; #failure = null; #onReasoning; #onPreview; #onActivity; #flushActivities;
  constructor({ journal, sessionId, getMessageId = () => '', projectRoot, adapter, previewPolicy = 'live', contextWindow, executionKernel, takeSteering = () => [], applySteering = () => [], onReasoning = () => {}, onPreview = () => {}, onActivity = () => {}, flushActivities = () => {} }) {
    this.#journal = journal; this.#sessionId = sessionId; this.#getMessageId = getMessageId; this.#projectRoot = projectRoot; this.#adapter = adapter; this.#previewPolicy = previewPolicy; this.#contextWindow = contextWindow; this.#executionKernel = executionKernel; this.#takeSteering = takeSteering; this.#applySteering = applySteering; this.#onReasoning = onReasoning; this.#onPreview = onPreview; this.#onActivity = onActivity;
    this.#flushActivities = flushActivities;
  }

  flushActivities() { this.#flushActivities(); }

  async stream(messages, options) {
    if (this.#failure) throw this.#failure;
    const finalDelta = typeof options?.onDelta === 'function' ? options.onDelta : async () => {};
    let pendingText = '';
    let pendingStartedAt = null;
    let receivedText = false;
    let streamedText = '';
    let pendingPreview = '';
    let previewSeq = 0;
    let previewSnapshotLength = 0;
    let previewTimer = null;
    const flushPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = null;
      if (!pendingPreview) return;
      previewSeq += pendingPreview.length;
      // Occasional snapshots let newly subscribed views recover a missing prefix.
      // Doubling their spacing keeps total snapshot traffic linear in answer size.
      if (previewSeq >= previewSnapshotLength * 2) {
        this.#onPreview({ content: pendingText });
        previewSnapshotLength = previewSeq;
      } else this.#onPreview({ delta: pendingPreview, seq: previewSeq });
      pendingPreview = '';
    };
    const clearPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = null;
      pendingPreview = '';
      previewSeq = 0;
      previewSnapshotLength = 0;
      this.#onPreview({ content: '' });
    };

    const previewDelta = (delta) => {
      const text = typeof delta === 'string' ? delta : String(delta ?? '');
      if (!text) return;
      receivedText = true;
      streamedText += text;
      pendingStartedAt ??= Date.now();
      pendingText += text;
      if (this.#previewPolicy !== 'defer-unclassified') {
        pendingPreview += text;
        if (!previewSeq) flushPreview();
        else if (!previewTimer) {
          previewTimer = setTimeout(flushPreview, 50);
          previewTimer.unref?.();
        }
      }
    };

    const flushReasoning = async () => {
      const segment = pendingText.trim();
      if (segment) await this.#onReasoning(segment, { startedAt: pendingStartedAt ?? Date.now(), completedAt: Date.now() });
      pendingText = '';
      pendingStartedAt = null;
      clearPreview();
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
    const definitions = typeof options?.getTools === 'function' ? options.getTools() : options?.tools;
    const providerTools = this.#executionKernel.toolsForProvider?.(definitions, { sessionId: this.#sessionId, projectRoot: this.#projectRoot }) ?? definitions;
    if (Number.isFinite(this.#contextWindow) && this.#contextWindow > 0) {
      const requestText = JSON.stringify({
        messages: messages.map(({ role, content, tool_calls }) => ({ role, content, tool_calls })),
        tools: providerTools,
      });
      this.#onActivity(providerActivity('activity.usage', {
        contextUsage: { usedTokens: Math.ceil(requestText.length / 4), windowTokens: this.#contextWindow, estimated: true },
      }));
    }
    let response;
    try {
      response = await this.#adapter.stream(messages, {
        ...options,
        tools: providerTools,
        onDelta: previewDelta,
        onActivity: async (activity) => {
          if (activity?.type?.startsWith('activity.tool.') && pendingText) await flushReasoning();
          await this.#onActivity(activity);
        },
        ...(executeTool ? { executeTool } : {}),
      });
    } catch (error) {
      const stopped = options?.signal?.aborted || error?.name === 'AbortError';
      if (this.#previewPolicy !== 'defer-unclassified' && pendingText) {
        await finalDelta(pendingText, stopped ? { stoppedPartial: true } : {});
        pendingText = '';
      }
      clearPreview();
      throw error;
    } finally {
      clearTimeout(previewTimer);
    }
    if (!receivedText && typeof response?.text === 'string') pendingText = response.text;
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.length) {
      await flushReasoning();
      for (const call of toolCalls) this.#rememberCall(call);
      if (this.#journal && this.#projectRoot) for (const call of toolCalls) await this.#prepareCall(call);
      if (!executeTool) return response;

      const conversation = [
        ...messages,
        {
          role: 'assistant',
          content: response?.text || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments ?? '{}' },
          })),
        },
      ];
      const appliedSteering = [];
      for (const call of toolCalls) {
        const result = await executeTool(call);
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: result?.output ?? '',
        };
        conversation.push(toolMessage);
        const steering = this.#drainSteering();
        if (!steering.length) continue;
        const applied = await this.#applySteering(steering);
        toolMessage.content = `${toolMessage.content ?? ''}${toolMessage.content ? '\n\n' : ''}${steeringNote(steering)}`;
        appliedSteering.push(...applied);
      }
      for (const user of appliedSteering) conversation.push(userConversationMessage(user));
      return this.stream(conversation, options);
    }
    if (pendingText) await finalDelta(pendingText);
    pendingText = '';
    clearPreview();
    const steering = this.#drainSteering();
    if (steering.length) {
      const applied = await this.#applySteering(steering);
      if (applied.length) {
        const conversation = [...messages];
        const assistantText = typeof response?.text === 'string' && response.text ? response.text : streamedText;
        if (String(assistantText ?? '').trim()) conversation.push({ role: 'assistant', content: assistantText });
        for (const user of applied) conversation.push(userConversationMessage(user));
        return this.stream(conversation, options);
      }
    }
    return response;
  }

  #drainSteering() {
    try {
      const items = this.#takeSteering?.();
      return Array.isArray(items) ? items.filter((item) => String(item?.text ?? '').trim()) : [];
    } catch {
      return [];
    }
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
    const messageId = String(this.#getMessageId?.() || '');
    return {
      ...event,
      ...(messageId ? { messageId } : {}),
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
    } else if (call?.name === 'bash' || call?.name === 'package_dmg') {
      this.#pending.set(callId, { kind: 'barrier', tool: call.name });
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
        await this.#journal.recordBarrier({ sessionId: this.#sessionId, executionId: String(finished.event.executionId || finished.callId), tool: finished.pending.tool, projectRoot: this.#projectRoot, paths, reason: 'Command output has no byte-exact preimage; undo will not cross this boundary.' });
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
    if (typeof db?.getLatestStreamingAssistantMessageId === 'function') {
      return String(db.getLatestStreamingAssistantMessageId(sessionId) ?? '');
    }
    const messages = db?.getSession?.(sessionId)?.messages;
    if (!Array.isArray(messages)) return '';
    return String([...messages].reverse().find((message) => message?.role === 'assistant' && message?.status === 'streaming')?.id ?? '');
  } catch { return ''; }
}

function steeringNote(items) {
  const body = items.map((item) => {
    const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
    const names = attachments.map((attachment) => [attachment?.name, attachment?.mime, Number.isFinite(attachment?.size) ? `${attachment.size} bytes` : ''].filter(Boolean).join(' · ')).filter(Boolean);
    return `${String(item?.text ?? '').trim()}${names.length ? `\nAttachments: ${names.join(', ')}` : ''}`;
  }).filter(Boolean).join('\n\n');
  return `<CUPPET_USER_STEERING>\nThe user added this guidance while the current turn was running. Apply it now as a real user instruction. Do not restart completed work or repeat tool calls that already succeeded.\n\n${body}\n</CUPPET_USER_STEERING>`;
}

function userConversationMessage(user) {
  const attachments = Array.isArray(user?.attachments) ? user.attachments : [];
  const imageAttachments = attachments.filter((attachment) => typeof attachment?.dataUrl === 'string' && attachment.dataUrl && (!attachment.mime || attachment.mime.startsWith('image/')));
  return {
    role: 'user',
    content: String(user?.content ?? ''),
    ...(imageAttachments.length ? { imageAttachments } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function parseArguments(value) {
  try { const decoded = JSON.parse(typeof value === 'string' ? value : '{}'); return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {}; }
  catch { return {}; }
}
function cleanError(error) { return redactCredentials(error ?? 'Unknown error').slice(0, 1000); }
