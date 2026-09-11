import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { recordProviderUsage } from '../usage-ledger.mjs';
import { AcpSessionRuntime } from './transports/acp/acp-session.mjs';
import { activityToLegacyEvent } from './runtime-manager-legacy.mjs';

const DEFAULT_IDLE_MS = 5 * 60_000;

export class ProviderRuntimeManager {
  #openCodeRuntimeFactory;
  #usageRecorder;
  #idleMs;
  #entries = new Map();
  #closed = false;

  constructor({ openCodeRuntimeFactory, usageRecorder = recordProviderUsage, idleMs = DEFAULT_IDLE_MS } = {}) {
    this.#openCodeRuntimeFactory = openCodeRuntimeFactory ?? (({ configuration, projectRoot }) => new AcpSessionRuntime({
      descriptor: localCliDescriptor('opencode'),
      configuration,
      projectRoot,
    }));
    this.#usageRecorder = usageRecorder;
    this.#idleMs = positiveMs(idleMs, DEFAULT_IDLE_MS);
  }

  adapterFor({ sessionId, projectRoot = null, adapter }) {
    if (this.#closed) throw new Error('Provider runtime manager is closed.');
    const managed = typeof adapter?.cuppetManagedRuntime === 'function' ? adapter.cuppetManagedRuntime() : null;
    if (!managed || managed.backendId !== 'opencode') return adapter;
    const id = requiredText(sessionId, 'sessionId');
    const providerConfig = record(managed.configuration);
    return {
      stream: (messages, options = {}) => this.#runOpenCode({
        sessionId: id,
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

  async #runOpenCode({ sessionId, providerConfig, projectRoot, messages, options }) {
    const fingerprint = openCodeRuntimeFingerprint(providerConfig, projectRoot);
    let entry = this.#entries.get(sessionId);
    if (entry && entry.fingerprint !== fingerprint) {
      this.#entries.delete(sessionId);
      clearTimeout(entry.idleTimer);
      await entry.runtime.close().catch(() => undefined);
      entry = null;
    }
    if (!entry) {
      const runtime = this.#openCodeRuntimeFactory({ configuration: providerConfig, projectRoot });
      entry = { runtime, fingerprint, started: false, turns: 0, idleTimer: null, busy: false };
      this.#entries.set(sessionId, entry);
    }
    if (entry.busy) throw new Error('This Cuppet session already has an active managed provider turn.');
    entry.busy = true;
    clearTimeout(entry.idleTimer);

    const legacyState = new Map();
    try {
      if (!entry.started) {
        await entry.runtime.start();
        entry.started = true;
      } else {
        // Reuse the provider process, but open a new ACP logical session for each turn until
        // Conversation Bridge can prove exactly which compiled context the provider already owns.
        await entry.runtime.newSession();
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
        providerID: 'opencode',
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

export function openCodeRuntimeFingerprint(configuration = {}, projectRoot = null) {
  const source = record(configuration);
  const primary = record(source.primary);
  const payload = {
    providerID: providerId(source),
    projectRoot: resolve(projectRoot || tmpdir()),
    cliCommand: text(source.cliCommand),
    cliArgs: Array.isArray(source.cliArgs) ? source.cliArgs.map((item) => String(item)) : [],
    model: text(primary.modelID || source.model || source.modelID),
    effort: text(source.primaryEffort || primary.variant),
    runtimeSettings: stableValue(source.runtimeSettings),
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
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
