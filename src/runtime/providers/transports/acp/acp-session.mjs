import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { findRuntimeSetting, modelRuntimeSetting, reasoningRuntimeSetting, settingAdvertisesValue } from '../../capabilities.mjs';
import { providerActivity } from '../../activity.mjs';
import { AcpProcess } from './acp-process.mjs';
import { AcpRpcChannel } from './acp-rpc.mjs';
import { AcpHostBridge } from './acp-host-bridge.mjs';
import { capabilitiesFromAcpSession, withAcpConfigOptions } from './acp-capabilities.mjs';
import { AcpActivityNormalizer } from './acp-activity.mjs';
import { AcpTurnCompletionGate } from './acp-turn-completion.mjs';

const REQUEST_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 15_000;

export class AcpSessionRuntime {
  #descriptor;
  #configuration;
  #projectRoot;
  #process;
  #rpc;
  #hostBridge;
  #environment;
  #initialized = null;
  #session = null;
  #capabilities = null;
  #state = 'idle';
  #activeTurn = null;
  #normalizer = new AcpActivityNormalizer();
  #inactivityTimeoutMs;
  #cancelGraceMs;

  constructor({ descriptor, configuration = {}, projectRoot = null, executeTool, requestAgentPermission, liveness = {} }) {
    this.#descriptor = descriptor;
    this.#configuration = configuration;
    this.#inactivityTimeoutMs = positiveMs(liveness.inactivityMs, DEFAULT_INACTIVITY_TIMEOUT_MS);
    this.#cancelGraceMs = positiveMs(liveness.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
    this.#projectRoot = projectRoot ? resolve(projectRoot) : tmpdir();
    const command = text(configuration.cliCommand) || text(process.env[descriptor.envOverride]) || descriptor.command;
    const args = Array.isArray(configuration.cliArgs) && configuration.cliArgs.length
      ? configuration.cliArgs.map((value) => String(value))
      : [...descriptor.args];
    this.#environment = providerEnvironment(descriptor, configuration);
    this.#process = new AcpProcess({ command, args, cwd: this.#projectRoot, env: this.#environment, label: descriptor.label });
    this.#rpc = new AcpRpcChannel({ processHandle: this.#process, label: descriptor.label });
    this.#hostBridge = new AcpHostBridge({ providerId: descriptor.id, projectRoot: this.#projectRoot, executeTool, requestAgentPermission });
    this.#rpc.setRequestHandler(async (message) => {
      this.#touchActiveTurn();
      const finishCompletionRequest = this.#activeTurn?.completion?.beginRequest?.() ?? (() => {});
      try {
        return await this.#hostBridge.handle(message);
      } finally {
        finishCompletionRequest();
      }
    });
  }

  async start({ mcpServers = [], selection } = {}) {
    if (this.#state === 'ready' || this.#state === 'running') return this.snapshot();
    if (this.#state === 'closed') throw new Error(`${this.#descriptor.label} runtime is closed.`);
    if (this.#state === 'starting') throw new Error(`${this.#descriptor.label} runtime is already starting.`);
    this.#state = 'starting';
    try {
      await this.#rpc.ready();
      this.#initialized = await this.#rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'Cuppet Desktop', version: '0.9.0-alpha.1' },
      }, REQUEST_TIMEOUT_MS);
      await authenticateIfNeeded(this.#rpc, this.#descriptor, this.#initialized, this.#environment);
      await this.#openSession(mcpServers, selection);
      this.#state = 'ready';
      return this.snapshot();
    } catch (error) {
      this.#state = 'error';
      throw enrichProviderError(this.#descriptor, error, this.#rpc.stderr());
    }
  }

  async newSession({ mcpServers = [], selection } = {}) {
    if (this.#state === 'idle') return this.start({ mcpServers, selection });
    if (this.#state !== 'ready') throw new Error(`${this.#descriptor.label} runtime must be ready before opening another ACP session.`);
    await this.#openSession(mcpServers, selection);
    return this.snapshot();
  }

  setHostHandlers(handlers = {}) {
    this.#hostBridge.setHandlers(handlers);
  }

  async capabilities() {
    if (this.#state === 'idle') await this.start();
    return this.#capabilities;
  }

  snapshot() {
    return Object.freeze({ state: this.#state, sessionId: text(this.#session?.sessionId) || null });
  }

  async runTurn(input = {}, hooks = {}) {
    if (this.#state === 'idle') await this.start();
    if (this.#state !== 'ready') throw new Error(`${this.#descriptor.label} runtime is not ready.`);
    if (this.#activeTurn) throw new Error(`${this.#descriptor.label} runtime already has an active turn.`);
    this.setHostHandlers({ executeTool: hooks.executeTool, requestAgentPermission: hooks.requestAgentPermission });
    const sessionId = text(this.#session?.sessionId);
    const signal = hooks.signal;
    if (signal?.aborted) throw abortError();
    const turn = {
      cancelled: false,
      stalled: false,
      activityTimer: null,
      terminateTimer: null,
      completion: new AcpTurnCompletionGate(this.#descriptor),
      hooks,
      sessionId,
    };
    this.#activeTurn = turn;
    this.#state = 'running';
    let output = '';
    const emit = async (activity) => {
      if (!activity) return;
      this.#touchActiveTurn();
      if (activity.type === 'activity.text.delta') {
        output += activity.text;
        await notifyObserver(hooks.onText, activity.text);
      }
      await notifyObserver(hooks.onActivity, activity);
    };
    this.#rpc.setNotificationHandler(async (message) => {
      if (message.method !== 'session/update' && message.method !== 'session/notification') return;
      const params = record(message.params);
      if (params.sessionId && String(params.sessionId) !== sessionId) return;
      const update = params.update ?? params;
      turn.completion.observeUpdate(update);
      this.#touchActiveTurn();
      await emit(this.#normalizer.normalize(update));
    });
    const onAbort = () => {
      turn.cancelled = true;
      turn.completion.cancel();
      this.#rpc.notify('session/cancel', { sessionId });
      this.#armTermination(turn);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    this.#armActivityWatchdog(turn);
    try {
      const prompt = await this.#rpc.request(
        'session/prompt',
        sessionPromptParams(this.#descriptor, sessionId, serializeConversation(input.messages ?? [])),
        PROMPT_TIMEOUT_MS,
      );
      if (turn.stalled) throw stalledError(this.#descriptor);
      if (signal?.aborted || turn.cancelled) throw abortError();
      await turn.completion.afterPrompt(prompt);
      if (turn.stalled) throw stalledError(this.#descriptor);
      if (signal?.aborted || turn.cancelled) throw abortError();
      return { text: output, toolCalls: [], usage: normalizeUsage(prompt?.usage ?? prompt?._meta?.usage), stopReason: text(prompt?.stopReason) || null };
    } catch (error) {
      if (turn.stalled) throw stalledError(this.#descriptor);
      if (signal?.aborted || turn.cancelled || error?.name === 'AbortError') throw abortError();
      throw enrichProviderError(this.#descriptor, error, this.#rpc.stderr());
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      turn.completion.cancel();
      clearTimeout(turn.activityTimer);
      clearTimeout(turn.terminateTimer);
      this.#rpc.setNotificationHandler();
      this.setHostHandlers();
      this.#activeTurn = null;
      if (this.#state !== 'closed') this.#state = 'ready';
    }
  }

  async cancel() {
    const sessionId = text(this.#session?.sessionId);
    if (!sessionId || !this.#activeTurn) return;
    const turn = this.#activeTurn;
    turn.cancelled = true;
    turn.completion?.cancel?.();
    this.#rpc.notify('session/cancel', { sessionId });
    this.#armTermination(turn);
  }

  async close() {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    if (this.#activeTurn) await this.cancel().catch(() => undefined);
    this.setHostHandlers();
    this.#rpc.close();
  }

  #touchActiveTurn() {
    const turn = this.#activeTurn;
    if (!turn || turn.stalled || turn.cancelled) return;
    this.#armActivityWatchdog(turn);
  }

  #armActivityWatchdog(turn) {
    clearTimeout(turn.activityTimer);
    turn.activityTimer = setTimeout(() => {
      if (this.#activeTurn !== turn || turn.cancelled || turn.stalled) return;
      turn.stalled = true;
      turn.completion?.cancel?.();
      void notifyObserver(turn.hooks.onActivity, providerActivity('activity.warning', {
        code: 'provider_stalled',
        message: `${this.#descriptor.label} stopped producing ACP activity.`,
      }));
      this.#rpc.notify('session/cancel', { sessionId: turn.sessionId });
      this.#armTermination(turn);
    }, this.#inactivityTimeoutMs);
  }

  #armTermination(turn) {
    if (turn.terminateTimer) return;
    turn.terminateTimer = setTimeout(() => {
      if (this.#activeTurn === turn) this.#rpc.terminate();
    }, this.#cancelGraceMs);
  }

  async #openSession(mcpServers = [], selection) {
    const descriptorMeta = record(this.#descriptor?.sessionMeta);
    const params = {
      cwd: this.#projectRoot,
      mcpServers: normalizeMcpServers(mcpServers),
      ...(Object.keys(descriptorMeta).length ? { _meta: { ...descriptorMeta } } : {}),
    };
    this.#session = await this.#rpc.request('session/new', params, REQUEST_TIMEOUT_MS);
    if (!text(this.#session?.sessionId)) throw new Error(`${this.#descriptor.label} ACP did not return a session id.`);
    this.#refreshCapabilities();
    await this.#applyRequiredSessionSettings();
    await this.#applyConfiguredSettings(selection);
  }

  async #applyRequiredSessionSettings() {
    for (const raw of Array.isArray(this.#descriptor?.requiredSessionSettings) ? this.#descriptor.requiredSessionSettings : []) {
      const requirement = record(raw);
      const envName = text(requirement.valueFromEnv);
      const requested = envName ? text(this.#environment?.[envName]) : text(requirement.value);
      const selector = { id: text(requirement.id), category: text(requirement.category) };
      const label = text(requirement.label) || selector.category || selector.id || 'required session setting';
      if (!requested) throw new Error(`${this.#descriptor.label} is missing the required ${label} value.`);
      const setting = findRuntimeSetting(this.#capabilities, selector);
      await this.#applySelectSetting(setting, requested, label);
      const applied = findRuntimeSetting(this.#capabilities, { id: setting?.id, category: selector.category });
      if (applied?.value !== requested) {
        throw new Error(`${this.#descriptor.label} did not confirm required ${label} '${requested}'. Refusing to run without the provider isolation setting.`);
      }
    }
  }

  async #applyConfiguredSettings(selection) {
    const configured = selection === undefined ? sessionSelection(this.#configuration) : normalizeSessionSelection(selection);
    const configuredModel = text(configured.model);
    if (configuredModel && configuredModel !== 'cli-default') {
      const modelSetting = modelRuntimeSetting(this.#capabilities);
      await this.#applySelectSetting(modelSetting, configuredModel, 'model');
    }
    const configuredEffort = text(configured.effort);
    if (configuredEffort) {
      const reasoningSetting = reasoningRuntimeSetting(this.#capabilities);
      await this.#applySelectSetting(reasoningSetting, configuredEffort, 'reasoning effort');
    }
  }

  async #applySelectSetting(setting, requested, label) {
    if (!setting) throw new Error(`${this.#descriptor.label} does not advertise a switchable ${label}; leaving its provider default unchanged.`);
    if (!settingAdvertisesValue(setting, requested)) throw new Error(`${this.#descriptor.label} no longer advertises ${label} '${requested}'. Refresh provider capabilities.`);
    if (setting.value === requested) return;
    const result = await this.#rpc.request('session/set_config_option', {
      sessionId: text(this.#session?.sessionId),
      configId: setting.id,
      value: requested,
    }, REQUEST_TIMEOUT_MS);
    this.#session = withAcpConfigOptions(this.#session, result);
    this.#refreshCapabilities();
  }

  #refreshCapabilities() {
    this.#capabilities = capabilitiesFromAcpSession(this.#session, this.#initialized);
  }
}

async function authenticateIfNeeded(rpc, descriptor, initialized, environment) {
  const policy = record(descriptor?.authentication);
  const preferred = Array.isArray(policy.methods) ? policy.methods : [];
  if (!preferred.length) return;
  const advertised = new Set((Array.isArray(initialized?.authMethods) ? initialized.authMethods : []).map((item) => text(item?.id)).filter(Boolean));
  if (!advertised.size) return;
  const selected = preferred.find((raw) => {
    const item = record(raw);
    const id = text(item.id);
    const requiredEnv = text(item.requiresEnv);
    return id && advertised.has(id) && (!requiredEnv || text(environment?.[requiredEnv]));
  });
  const methodId = text(record(selected).id);
  if (!methodId) throw new Error(descriptor.loginHint);
  const meta = record(policy.meta);
  await rpc.request('authenticate', { methodId, ...(Object.keys(meta).length ? { _meta: meta } : {}) }, REQUEST_TIMEOUT_MS);
}

function normalizeMcpServers(value) {
  return (Array.isArray(value) ? value : []).slice(0, 16).flatMap((raw) => {
    const server = record(raw);
    const name = text(server.name);
    const command = text(server.command);
    if (!name || !command) return [];
    const args = Array.isArray(server.args) ? server.args.slice(0, 64).map((item) => String(item)) : [];
    const env = (Array.isArray(server.env) ? server.env : []).slice(0, 64).flatMap((item) => {
      const variable = record(item);
      const variableName = text(variable.name);
      return variableName ? [{ name: variableName, value: String(variable.value ?? '') }] : [];
    });
    return [{ name, command, args, env }];
  });
}
function providerEnvironment(descriptor, configuration) {
  let environment = { ...process.env };
  const overrides = record(configuration?.cliEnv);
  for (const [key, value] of Object.entries(overrides).slice(0, 128)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === undefined || value === null) delete environment[key];
    else environment[key] = String(value).slice(0, 32_768);
  }
  // Provider descriptors own mandatory process policy. Apply that policy last so
  // generic launch overrides can supply credentials/test flags but cannot weaken a
  // provider's execution-isolation environment.
  if (typeof descriptor?.environment === 'function') {
    const transformed = descriptor.environment(environment, configuration);
    if (transformed && typeof transformed === 'object' && !Array.isArray(transformed)) environment = { ...transformed };
  }
  return environment;
}
function sessionSelection(configuration) {
  const source = record(configuration);
  const primary = record(source.primary);
  return {
    model: text(primary.modelID || source.model || source.modelID) || null,
    effort: text(source.primaryEffort || primary.variant) || null,
  };
}
function normalizeSessionSelection(selection) {
  const source = record(selection);
  return {
    model: text(source.model) || null,
    effort: text(source.effort) || null,
  };
}
function sessionPromptParams(descriptor, sessionId, textValue) {
  const content = [{ type: 'text', text: textValue }];
  const parameter = descriptor?.promptParameter === 'content' ? 'content' : 'prompt';
  return { sessionId, [parameter]: content };
}
function serializeConversation(messages) { const value=(Array.isArray(messages)?messages:[]).map((m)=>`[${String(m?.role??'user').toUpperCase()}]\n${typeof m?.content==='string'?m.content:JSON.stringify(m?.content??'')}`).join('\n\n'); const bytes=Buffer.from(value,'utf8'); return bytes.length<=MAX_PROMPT_BYTES?value:`${bytes.subarray(bytes.length-MAX_PROMPT_BYTES).toString('utf8')}\n\n[Earlier compiled context truncated by Cuppet before ACP transport.]`; }
function normalizeUsage(value){const s=record(value); if(!Object.keys(s).length)return null; const n=(v)=>Number.isFinite(Number(v))?Number(v):0; return {inputTokens:n(s.inputTokens??s.input_tokens),outputTokens:n(s.outputTokens??s.output_tokens),totalTokens:n(s.totalTokens??s.total_tokens),cachedInputTokens:n(s.cachedInputTokens??s.cached_input_tokens??s.cachedReadTokens),reasoningTokens:n(s.reasoningTokens??s.reasoning_tokens)};}
async function notifyObserver(callback, ...args){if(typeof callback!=='function')return; try{await callback(...args);}catch{}}
function enrichProviderError(descriptor,error,stderr){const message=cleanError(error); const detail=cleanError(stderr).trim(); if(/not found|ENOENT/i.test(message)) return new Error(`${descriptor.label} CLI was not found. ${descriptor.loginHint}`); return new Error(detail && !message.includes(detail) ? `${descriptor.label}: ${message}\n${detail}` : `${descriptor.label}: ${message}`);}
function cleanError(error){return error instanceof Error?error.message:String(error??'');}
function stalledError(descriptor){const error=new Error(`${descriptor.label} stopped responding via ACP. The provider/model may be unavailable, rate-limited, out of quota, or the agent process may have stalled.`); error.code='ACP_STALLED'; return error;}
function abortError(){const error=new Error('Provider request aborted.'); error.name='AbortError'; return error;}
function positiveMs(value,fallback){const number=Number(value); return Number.isFinite(number)&&number>0?number:fallback;}
function text(value){return typeof value==='string'?value.trim():'';}
function record(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
