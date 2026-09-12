import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSessionRuntime, codexSessionSelection } from '../codex-provider.mjs';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { recordProviderUsage } from '../usage-ledger.mjs';
import { ConversationBridge } from './conversation-bridge.mjs';
import { AcpSessionRuntime } from './transports/acp/acp-session.mjs';
import { CuppetMcpToolSession } from './transports/acp/cuppet-mcp-tool-session.mjs';
import { AcpTextStreamAssembler } from './transports/acp/acp-text-stream.mjs';
import { activityToLegacyEvent } from './runtime-manager-legacy.mjs';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_WARM_RUNTIMES = 3;

export class ProviderRuntimeManager {
  #acpRuntimeFactory;
  #codexRuntimeFactory;
  #toolSessionFactory;
  #usageRecorder;
  #conversationBridge;
  #idleMs;
  #maxWarmRuntimes;
  #useCounter = 0;
  #entries = new Map();
  #closed = false;

  constructor({ acpRuntimeFactory, openCodeRuntimeFactory, codexRuntimeFactory, toolSessionFactory, usageRecorder = recordProviderUsage, conversationBridge = new ConversationBridge(), idleMs = DEFAULT_IDLE_MS, maxWarmRuntimes = DEFAULT_MAX_WARM_RUNTIMES } = {}) {
    this.#acpRuntimeFactory = acpRuntimeFactory ?? openCodeRuntimeFactory ?? (({ descriptor, configuration, projectRoot }) => new AcpSessionRuntime({
      descriptor,
      configuration,
      projectRoot,
    }));
    this.#codexRuntimeFactory = codexRuntimeFactory ?? (({ configuration }) => new CodexSessionRuntime({ configuration }));
    this.#toolSessionFactory = toolSessionFactory ?? (({ sessionId, backendId }) => new CuppetMcpToolSession({ sessionId, backendId }));
    this.#usageRecorder = usageRecorder;
    this.#conversationBridge = conversationBridge;
    this.#idleMs = positiveMs(idleMs, DEFAULT_IDLE_MS);
    this.#maxWarmRuntimes = positiveInteger(maxWarmRuntimes, DEFAULT_MAX_WARM_RUNTIMES);
  }

  adapterFor({ sessionId, projectRoot = null, adapter }) {
    if (this.#closed) throw new Error('Provider runtime manager is closed.');
    const managed = typeof adapter?.cuppetManagedRuntime === 'function' ? adapter.cuppetManagedRuntime() : null;
    if (!managed) return adapter;
    const id = requiredText(sessionId, 'sessionId');
    const protocol = text(managed.protocol).toLowerCase();
    const backendId = requiredText(managed.backendId, 'backendId').toLowerCase();
    const providerConfig = record(managed.configuration);

    if (protocol === 'acp') {
      const descriptor = managed.descriptor ?? localCliDescriptor(backendId);
      if (!descriptor || descriptor.transport !== 'acp') throw new Error(`Managed ACP backend '${backendId}' has no ACP descriptor.`);
      return {
        stream: (messages, options = {}) => this.#runAcp({
          sessionId: id,
          backendId,
          descriptor,
          providerConfig,
          projectRoot,
          messages,
          options,
        }),
      };
    }

    if (protocol === 'codex-app-server' && backendId === 'codex') {
      return {
        stream: (messages, options = {}) => this.#runCodex({
          sessionId: id,
          backendId,
          providerConfig,
          projectRoot,
          messages,
          options,
        }),
      };
    }

    return adapter;
  }

  async cancel(sessionId) {
    const group = this.#entries.get(String(sessionId ?? ''));
    if (!group) return false;
    const entry = group.activeFingerprint ? group.routes.get(group.activeFingerprint) : null;
    if (!entry) return true;
    const toolSession = entry.activeToolSession;
    if (entry.activeToolSession === toolSession) entry.activeToolSession = null;
    await Promise.allSettled([
      Promise.resolve(entry.runtime?.cancel?.()),
      Promise.resolve(toolSession?.close?.()),
    ]);
    return true;
  }

  async forget(sessionId) {
    const id = String(sessionId ?? '');
    const group = this.#entries.get(id);
    this.#conversationBridge.forget?.(id);
    if (!group) return false;
    this.#entries.delete(id);
    await closeManagedGroup(group);
    return true;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const groups = [...this.#entries.values()];
    this.#entries.clear();
    this.#conversationBridge.clear?.();
    await Promise.all(groups.map((group) => closeManagedGroup(group)));
  }

  get size() {
    let count = 0;
    for (const group of this.#entries.values()) count += group.routes.size;
    return count;
  }
  conversationSnapshot(sessionId) { return this.#conversationBridge.snapshot?.(sessionId) ?? null; }

  async #runAcp({ sessionId, backendId, descriptor, providerConfig, projectRoot, messages, options }) {
    const fingerprint = acpRuntimeFingerprint({ backendId, descriptor, configuration: providerConfig, projectRoot });
    const selection = acpSessionSelection(providerConfig);
    const { group, staleGroup } = this.#claimConversationGroup(sessionId, projectRoot);

    let entry = null;
    let bridgePlan = null;
    let toolSession = null;
    let abortToolSession = null;
    try {
      if (staleGroup) await closeManagedGroup(staleGroup);

      entry = group.routes.get(fingerprint) ?? null;
      if (entry && selectionRequiresFreshProcess(entry.selection, selection)) {
        group.routes.delete(fingerprint);
        this.#conversationBridge.forgetRuntime?.(sessionId, fingerprint);
        clearTimeout(entry.idleTimer);
        await closeManagedEntry(entry);
        entry = null;
      }
      if (!entry) {
        await this.#makeRoomForRuntime(sessionId, group);
        const runtime = this.#acpRuntimeFactory({ backendId, descriptor, configuration: providerConfig, projectRoot });
        entry = createManagedEntry({ runtime, backendId, fingerprint, lastUsed: ++this.#useCounter });
        group.routes.set(fingerprint, entry);
      }

      group.activeFingerprint = fingerprint;
      entry.busy = true;
      entry.lastUsed = ++this.#useCounter;
      clearTimeout(entry.idleTimer);
      bridgePlan = this.#conversationBridge.beginTurn({
        conversationId: sessionId,
        runtimeFingerprint: fingerprint,
        messages,
      });

      const legacyState = new Map();
      const textStream = new AcpTextStreamAssembler(descriptor.textStream);
      const activityTextStream = new AcpTextStreamAssembler(descriptor.textStream);
      let reasoningStream = usesTokenizedWhitespace(descriptor.textStream)
        ? new AcpTextStreamAssembler(descriptor.textStream)
        : null;
      const forwardActivity = async (activity) => {
        if (typeof options.onActivity === 'function') {
          await options.onActivity(activity);
          return;
        }
        // Compatibility for callers that have not moved to Cuppet Activity yet.
        const legacy = activityToLegacyEvent(activity, legacyState);
        if (legacy) await options.onProviderEvent?.(legacy);
      };
      const flushReasoning = async () => {
        if (!reasoningStream) return;
        reasoningStream.flush();
        const reasoning = reasoningStream.text;
        reasoningStream = new AcpTextStreamAssembler(descriptor.textStream);
        if (reasoning) await forwardActivity({ type: 'activity.reasoning.delta', text: reasoning });
      };
      const allowExternalMcp = descriptor?.mcpToolBridge === true;
      if (allowExternalMcp && Array.isArray(options.tools) && options.tools.length && typeof options.executeTool === 'function') {
        toolSession = this.#toolSessionFactory({ sessionId, backendId, projectRoot });
        await toolSession.start();
        toolSession.setTurn({ tools: options.tools, executeTool: options.executeTool, signal: options.signal });
        entry.activeToolSession = toolSession;
        if (options.signal?.addEventListener) {
          abortToolSession = () => {
            if (entry.activeToolSession === toolSession) entry.activeToolSession = null;
            void Promise.resolve(toolSession?.close?.()).catch(() => undefined);
          };
          options.signal.addEventListener('abort', abortToolSession, { once: true });
          if (options.signal.aborted) abortToolSession();
        }
      }
      const sessionOptions = { mcpServers: toolSession ? [toolSession.descriptor()] : [], selection };
      if (bridgePlan.providerSessionAction === 'start') {
        if (entry.started) throw new Error('Conversation Bridge requested a provider start for an already-started runtime.');
        await entry.runtime.start(sessionOptions);
        entry.started = true;
      } else {
        if (!entry.started) throw new Error('Conversation Bridge requested a new logical session before the provider runtime started.');
        await entry.runtime.newSession(sessionOptions);
      }
      entry.selection = selection;
      const result = await entry.runtime.runTurn({ messages: bridgePlan.messages }, {
        signal: options.signal,
        executeTool: options.executeTool,
        requestAgentPermission: options.requestAgentPermission,
        onText: async (rawDelta) => {
          const delta = textStream.push(rawDelta);
          if (delta) await options.onDelta?.(delta);
        },
        onActivity: async (activity) => {
          if (reasoningStream && activity?.type === 'activity.reasoning.delta') {
            reasoningStream.push(activity.text);
            return;
          }
          await flushReasoning();
          if (activity?.type === 'activity.text.delta') {
            const delta = activityTextStream.push(activity.text);
            if (!delta) return;
            await forwardActivity({ ...activity, text: delta });
            return;
          }
          await forwardActivity(activity);
        },
      });
      await flushReasoning();
      textStream.flush();
      activityTextStream.flush();
      const normalizedResult = { ...result, text: textStream.text || result?.text || '' };
      this.#completeManagedTurn({ bridgePlan, entry });
      bridgePlan = null;
      await this.#recordUsage(backendId, selection.model, normalizedResult?.usage);
      return normalizedResult;
    } catch (error) {
      await this.#failManagedTurn({ sessionId, fingerprint, group, entry, bridgePlan });
      bridgePlan = null;
      throw error;
    } finally {
      if (abortToolSession) options.signal?.removeEventListener?.('abort', abortToolSession);
      await toolSession?.close().catch(() => undefined);
      if (entry?.activeToolSession === toolSession) entry.activeToolSession = null;
      this.#releaseConversationGroup({ sessionId, fingerprint, group, entry });
    }
  }

  async #runCodex({ sessionId, backendId, providerConfig, projectRoot, messages, options }) {
    const fingerprint = codexRuntimeFingerprint({ configuration: providerConfig, projectRoot });
    const selection = codexSessionSelection(providerConfig);
    const { group, staleGroup } = this.#claimConversationGroup(sessionId, projectRoot);
    let entry = null;
    let bridgePlan = null;
    try {
      if (staleGroup) await closeManagedGroup(staleGroup);
      entry = group.routes.get(fingerprint) ?? null;
      if (!entry) {
        await this.#makeRoomForRuntime(sessionId, group);
        const runtime = this.#codexRuntimeFactory({ backendId, configuration: providerConfig, projectRoot });
        entry = createManagedEntry({ runtime, backendId, fingerprint, lastUsed: ++this.#useCounter });
        group.routes.set(fingerprint, entry);
      }

      group.activeFingerprint = fingerprint;
      entry.busy = true;
      entry.lastUsed = ++this.#useCounter;
      clearTimeout(entry.idleTimer);
      bridgePlan = this.#conversationBridge.beginTurn({
        conversationId: sessionId,
        runtimeFingerprint: fingerprint,
        messages,
      });

      if (!entry.started) {
        await entry.runtime.start();
        entry.started = true;
      }
      entry.selection = selection;
      const result = await entry.runtime.runTurn({ messages: bridgePlan.messages, selection }, {
        signal: options.signal,
        tools: options.tools,
        executeTool: options.executeTool,
        onDelta: options.onDelta,
        onActivity: options.onActivity,
      });
      this.#completeManagedTurn({ bridgePlan, entry });
      bridgePlan = null;
      await this.#recordUsage(backendId, selection.model, result?.usage);
      return result;
    } catch (error) {
      await this.#failManagedTurn({ sessionId, fingerprint, group, entry, bridgePlan });
      bridgePlan = null;
      throw error;
    } finally {
      this.#releaseConversationGroup({ sessionId, fingerprint, group, entry });
    }
  }

  #claimConversationGroup(sessionId, projectRoot) {
    const projectAuthority = resolvedProjectRoot(projectRoot);
    let staleGroup = null;
    let group = this.#entries.get(sessionId);
    if (group && group.projectAuthority !== projectAuthority) {
      staleGroup = group;
      this.#entries.delete(sessionId);
      this.#conversationBridge.forget?.(sessionId);
      group = null;
    }
    if (!group) {
      group = { projectAuthority, routes: new Map(), busy: false, activeFingerprint: null };
      this.#entries.set(sessionId, group);
    }
    if (group.busy) throw new Error('This Cuppet session already has an active managed provider turn.');
    group.busy = true;
    return { group, staleGroup };
  }

  #completeManagedTurn({ bridgePlan, entry }) {
    this.#conversationBridge.completeTurn(bridgePlan);
    entry.turns += 1;
    entry.lastUsed = ++this.#useCounter;
  }

  async #failManagedTurn({ sessionId, fingerprint, group, entry, bridgePlan }) {
    if (bridgePlan) this.#conversationBridge.abortTurn?.(bridgePlan);
    if (entry && group.routes.get(fingerprint) === entry) {
      group.routes.delete(fingerprint);
      clearTimeout(entry.idleTimer);
      await closeManagedEntry(entry);
    }
    if (!group.routes.size && this.#entries.get(sessionId) === group) {
      this.#entries.delete(sessionId);
      this.#conversationBridge.forget?.(sessionId);
    }
  }

  #releaseConversationGroup({ sessionId, fingerprint, group, entry }) {
    if (entry) entry.busy = false;
    if (group.activeFingerprint === fingerprint) group.activeFingerprint = null;
    group.busy = false;
    if (entry && group.routes.get(fingerprint) === entry && this.#entries.get(sessionId) === group) {
      this.#armIdle(sessionId, fingerprint, group, entry);
    }
  }

  async #recordUsage(backendId, model, usage) {
    await this.#usageRecorder?.({
      providerID: backendId,
      modelID: model || 'unknown',
      usage,
    }).catch?.(() => undefined);
  }

  async #makeRoomForRuntime(sessionId, group) {
    if (group.routes.size < this.#maxWarmRuntimes) return;
    let candidate = null;
    for (const [fingerprint, entry] of group.routes) {
      if (entry.busy || group.activeFingerprint === fingerprint) continue;
      if (!candidate || entry.lastUsed < candidate.entry.lastUsed) candidate = { fingerprint, entry };
    }
    if (!candidate) throw new Error('All warm provider runtimes are currently busy.');
    group.routes.delete(candidate.fingerprint);
    this.#conversationBridge.forgetRuntime?.(sessionId, candidate.fingerprint);
    clearTimeout(candidate.entry.idleTimer);
    await closeManagedEntry(candidate.entry);
  }

  #armIdle(sessionId, fingerprint, group, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const currentGroup = this.#entries.get(sessionId);
      if (currentGroup !== group || entry.busy || group.activeFingerprint === fingerprint || group.routes.get(fingerprint) !== entry) return;
      group.routes.delete(fingerprint);
      this.#conversationBridge.forgetRuntime?.(sessionId, fingerprint);
      if (!group.routes.size) {
        this.#entries.delete(sessionId);
        this.#conversationBridge.forget?.(sessionId);
      }
      void closeManagedEntry(entry);
    }, this.#idleMs);
    entry.idleTimer.unref?.();
  }
}

function createManagedEntry({ runtime, backendId, fingerprint, lastUsed }) {
  return {
    runtime,
    backendId,
    fingerprint,
    selection: null,
    started: false,
    turns: 0,
    idleTimer: null,
    busy: false,
    activeToolSession: null,
    lastUsed,
  };
}

async function closeManagedGroup(group) {
  const entries = [...(group?.routes?.values?.() ?? [])];
  group?.routes?.clear?.();
  for (const entry of entries) clearTimeout(entry.idleTimer);
  await Promise.all(entries.map((entry) => closeManagedEntry(entry)));
}

async function closeManagedEntry(entry) {
  const toolSession = entry?.activeToolSession;
  if (entry?.activeToolSession === toolSession) entry.activeToolSession = null;
  await Promise.allSettled([
    Promise.resolve(toolSession?.close?.()),
    Promise.resolve(entry?.runtime?.close?.()),
  ]);
}

export function acpRuntimeFingerprint({ backendId, descriptor = null, configuration = {}, projectRoot = null } = {}) {
  const source = record(configuration);
  const payload = {
    protocol: 'acp',
    backendId: text(backendId || descriptor?.id || providerId(source)).toLowerCase(),
    projectRoot: resolvedProjectRoot(projectRoot),
    command: text(source.cliCommand || descriptor?.command),
    cliArgs: Array.isArray(source.cliArgs) ? source.cliArgs.map((item) => String(item)) : Array.isArray(descriptor?.args) ? descriptor.args.map(String) : [],
    cliEnv: stableValue(source.cliEnv),
    sessionMeta: stableValue(descriptor?.sessionMeta),
    mcpToolBridge: descriptor?.mcpToolBridge === true,
    textStream: stableValue(descriptor?.textStream),
    runtimeSettings: stableValue(source.runtimeSettings),
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function codexRuntimeFingerprint({ configuration = {}, projectRoot = null } = {}) {
  const source = record(configuration);
  const payload = {
    protocol: 'codex-app-server',
    backendId: 'codex',
    projectRoot: resolvedProjectRoot(projectRoot),
    codexLaunch: stableValue(source.codexLaunch),
    resourcesPath: text(source.resourcesPath),
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function acpSessionSelection(configuration = {}) {
  const source = record(configuration);
  const primary = record(source.primary);
  return Object.freeze({
    model: text(primary.modelID || source.model || source.modelID) || null,
    effort: text(source.primaryEffort || primary.variant) || null,
  });
}

export function openCodeRuntimeFingerprint(configuration = {}, projectRoot = null) {
  return acpRuntimeFingerprint({ backendId: 'opencode', descriptor: localCliDescriptor('opencode'), configuration, projectRoot });
}

function selectionRequiresFreshProcess(previous, next) {
  if (!previous) return false;
  const previousModel = text(previous.model);
  const nextModel = text(next?.model);
  const previousEffort = text(previous.effort);
  const nextEffort = text(next?.effort);
  const clearsModel = previousModel && previousModel !== 'cli-default' && (!nextModel || nextModel === 'cli-default');
  const clearsEffort = Boolean(previousEffort && !nextEffort);
  return Boolean(clearsModel || clearsEffort);
}
function usesTokenizedWhitespace(value) { return text(record(value).framing).toLowerCase() === 'tokenized-whitespace'; }
function resolvedProjectRoot(projectRoot) { return resolve(projectRoot || tmpdir()); }
function providerId(configuration) {
  const source = record(configuration);
  return text(source.providerID || record(source.primary).providerID).toLowerCase();
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return typeof value === 'function' ? null : value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((key) => typeof value[key] === 'function' ? [] : [[key, stableValue(value[key])]]));
}
function positiveInteger(value, fallback) { const number = Math.floor(Number(value)); return Number.isFinite(number) && number > 0 ? number : fallback; }
function positiveMs(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function requiredText(value, label) { const result = text(value); if (!result) throw new TypeError(`${label} is required.`); return result; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
