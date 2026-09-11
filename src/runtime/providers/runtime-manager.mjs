import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { recordProviderUsage } from '../usage-ledger.mjs';
import { AcpSessionRuntime } from './transports/acp/acp-session.mjs';
import { CuppetMcpToolSession } from './transports/acp/cuppet-mcp-tool-session.mjs';
import { activityToLegacyEvent } from './runtime-manager-legacy.mjs';

const DEFAULT_IDLE_MS = 5 * 60_000;

export class ProviderRuntimeManager {
  #acpRuntimeFactory;
  #toolSessionFactory;
  #usageRecorder;
  #idleMs;
  #entries = new Map();
  #closed = false;

  constructor({ acpRuntimeFactory, openCodeRuntimeFactory, toolSessionFactory, usageRecorder = recordProviderUsage, idleMs = DEFAULT_IDLE_MS } = {}) {
    this.#acpRuntimeFactory = acpRuntimeFactory ?? openCodeRuntimeFactory ?? (({ descriptor, configuration, projectRoot }) => new AcpSessionRuntime({
      descriptor,
      configuration,
      projectRoot,
    }));
    this.#toolSessionFactory = toolSessionFactory ?? (({ sessionId, backendId }) => new CuppetMcpToolSession({ sessionId, backendId }));
    this.#usageRecorder = usageRecorder;
    this.#idleMs = positiveMs(idleMs, DEFAULT_IDLE_MS);
  }

  adapterFor({ sessionId, projectRoot = null, adapter }) {
    if (this.#closed) throw new Error('Provider runtime manager is closed.');
    const managed = typeof adapter?.cuppetManagedRuntime === 'function' ? adapter.cuppetManagedRuntime() : null;
    if (!managed || managed.protocol !== 'acp') return adapter;
    const id = requiredText(sessionId, 'sessionId');
    const backendId = requiredText(managed.backendId, 'backendId').toLowerCase();
    const descriptor = managed.descriptor ?? localCliDescriptor(backendId);
    if (!descriptor || descriptor.transport !== 'acp') throw new Error(`Managed ACP backend '${backendId}' has no ACP descriptor.`);
    const providerConfig = record(managed.configuration);
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

  async cancel(sessionId) {
    const entry = this.#entries.get(String(sessionId ?? ''));
    await entry?.runtime?.cancel?.();
  }

  async forget(sessionId) {
    const id = String(sessionId ?? '');
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    clearTimeout(entry.idleTimer);
    await entry.runtime.close().catch(() => undefined);
    return true;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) clearTimeout(entry.idleTimer);
    await Promise.all(entries.map((entry) => entry.runtime.close().catch(() => undefined)));
  }

  get size() { return this.#entries.size; }

  async #runAcp({ sessionId, backendId, descriptor, providerConfig, projectRoot, messages, options }) {
    const fingerprint = acpRuntimeFingerprint({ backendId, descriptor, configuration: providerConfig, projectRoot });
    let entry = this.#entries.get(sessionId);
    if (entry && entry.fingerprint !== fingerprint) {
      this.#entries.delete(sessionId);
      clearTimeout(entry.idleTimer);
      await entry.runtime.close().catch(() => undefined);
      entry = null;
    }
    if (!entry) {
      const runtime = this.#acpRuntimeFactory({ backendId, descriptor, configuration: providerConfig, projectRoot });
      entry = { runtime, backendId, fingerprint, started: false, turns: 0, idleTimer: null, busy: false };
      this.#entries.set(sessionId, entry);
    }
    if (entry.busy) throw new Error('This Cuppet session already has an active managed provider turn.');
    entry.busy = true;
    clearTimeout(entry.idleTimer);

    let toolSession = null;
    const legacyState = new Map();
    try {
      if (Array.isArray(options.tools) && options.tools.length && typeof options.executeTool === 'function') {
        toolSession = this.#toolSessionFactory({ sessionId, backendId, projectRoot });
        await toolSession.start();
        toolSession.setTurn({ tools: options.tools, executeTool: options.executeTool, signal: options.signal });
      }
      const sessionOptions = { mcpServers: toolSession ? [toolSession.descriptor()] : [] };
      if (!entry.started) {
        await entry.runtime.start(sessionOptions);
        entry.started = true;
      } else {
        // Reuse the ACP process, but isolate each Cuppet turn in a fresh ACP logical
        // session and a fresh authenticated Cuppet MCP tool session.
        await entry.runtime.newSession(sessionOptions);
      }
      const result = await entry.runtime.runTurn({ messages }, {
        signal: options.signal,
        executeTool: options.executeTool,
        requestAgentPermission: options.requestAgentPermission,
        onText: options.onDelta,
        onActivity: async (activity) => {
          const legacy = activityToLegacyEvent(activity, legacyState);
          if (legacy) await options.onProviderEvent?.(legacy);
        },
      });
      entry.turns += 1;
      await this.#usageRecorder?.({
        providerID: backendId,
        modelID: configuredModel(providerConfig) || 'unknown',
        usage: result?.usage,
      }).catch?.(() => undefined);
      return result;
    } catch (error) {
      if (this.#entries.get(sessionId) === entry) this.#entries.delete(sessionId);
      clearTimeout(entry.idleTimer);
      await entry.runtime.close().catch(() => undefined);
      throw error;
    } finally {
      await toolSession?.close().catch(() => undefined);
      entry.busy = false;
      if (this.#entries.get(sessionId) === entry) this.#armIdle(sessionId, entry);
    }
  }

  #armIdle(sessionId, entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.busy || this.#entries.get(sessionId) !== entry) return;
      this.#entries.delete(sessionId);
      void entry.runtime.close().catch(() => undefined);
    }, this.#idleMs);
    entry.idleTimer.unref?.();
  }
}

export function acpRuntimeFingerprint({ backendId, descriptor = null, configuration = {}, projectRoot = null } = {}) {
  const source = record(configuration);
  const primary = record(source.primary);
  const payload = {
    protocol: 'acp',
    backendId: text(backendId || descriptor?.id || providerId(source)).toLowerCase(),
    projectRoot: resolve(projectRoot || tmpdir()),
    command: text(source.cliCommand || descriptor?.command),
    cliArgs: Array.isArray(source.cliArgs) ? source.cliArgs.map((item) => String(item)) : Array.isArray(descriptor?.args) ? descriptor.args.map(String) : [],
    sessionMeta: stableValue(descriptor?.sessionMeta),
    model: text(primary.modelID || source.model || source.modelID),
    effort: text(source.primaryEffort || primary.variant),
    runtimeSettings: stableValue(source.runtimeSettings),
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function openCodeRuntimeFingerprint(configuration = {}, projectRoot = null) {
  return acpRuntimeFingerprint({ backendId: 'opencode', descriptor: localCliDescriptor('opencode'), configuration, projectRoot });
}

function configuredModel(configuration) {
  const source = record(configuration);
  const primary = record(source.primary);
  return text(primary.modelID || source.model || source.modelID);
}
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
function positiveMs(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function requiredText(value, label) { const result = text(value); if (!result) throw new TypeError(`${label} is required.`); return result; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
