import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { modelRuntimeSetting, reasoningRuntimeSetting, settingAdvertisesValue } from '../../capabilities.mjs';
import { providerActivity } from '../../activity.mjs';
import { AcpProcess } from './acp-process.mjs';
import { AcpRpcChannel } from './acp-rpc.mjs';
import { AcpHostBridge } from './acp-host-bridge.mjs';
import { capabilitiesFromAcpSession, withAcpConfigOptions } from './acp-capabilities.mjs';
import { AcpActivityNormalizer } from './acp-activity.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
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
    this.#process = new AcpProcess({ command, args, cwd: this.#projectRoot, env: providerEnvironment(descriptor.id), label: descriptor.label });
    this.#rpc = new AcpRpcChannel({ processHandle: this.#process, label: descriptor.label });
    this.#hostBridge = new AcpHostBridge({ providerId: descriptor.id, projectRoot: this.#projectRoot, executeTool, requestAgentPermission });
    this.#rpc.setRequestHandler((message) => {
      this.#touchActiveTurn();
      return this.#hostBridge.handle(message);
    });
  }

  async start({ mcpServers = [] } = {}) {
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
      await authenticateIfNeeded(this.#rpc, this.#descriptor, this.#initialized);
      await this.#openSession(mcpServers);
      this.#state = 'ready';
      return this.snapshot();
    } catch (error) {
      this.#state = 'error';
      throw enrichProviderError(this.#descriptor, error, this.#rpc.stderr());
    }
  }

  async newSession({ mcpServers = [] } = {}) {
    if (this.#state === 'idle') return this.start({ mcpServers });
    if (this.#state !== 'ready') throw new Error(`${this.#descriptor.label} runtime must be ready before opening another ACP session.`);
    await this.#openSession(mcpServers);
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
        await hooks.onText?.(activity.text);
      }
      await hooks.onActivity?.(activity);
    };
    this.#rpc.setNotificationHandler(async (message) => {
      if (message.method !== 'session/update' && message.method !== 'session/notification') return;
      const params = record(message.params);
      if (params.sessionId && String(params.sessionId) !== sessionId) return;
      this.#touchActiveTurn();
      await emit(this.#normalizer.normalize(params.update ?? params));
    });
    const onAbort = () => {
      turn.cancelled = true;
      this.#rpc.notify('session/cancel', { sessionId });
      this.#armTermination(turn);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    this.#armActivityWatchdog(turn);
    try {
      const prompt = await this.#rpc.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: serializeConversation(input.messages ?? []) }],
      }, PROMPT_TIMEOUT_MS);
      if (turn.stalled) throw stalledError(this.#descriptor);
      if (signal?.aborted || turn.cancelled) throw abortError();
      return { text: output, toolCalls: [], usage: normalizeUsage(prompt?.usage ?? prompt?._meta?.usage), stopReason: text(prompt?.stopReason) || null };
    } catch (error) {
      if (turn.stalled) throw stalledError(this.#descriptor);
      if (signal?.aborted || turn.cancelled || error?.name === 'AbortError') throw abortError();
      throw enrichProviderError(this.#descriptor, error, this.#rpc.stderr());
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      clearTimeout(turn.activityTimer);
      clearTimeout(turn.terminateTimer);
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
      void Promise.resolve(turn.hooks.onActivity?.(providerActivity('activity.warning', {
        code: 'provider_stalled',
        message: `${this.#descriptor.label} stopped producing ACP activity.`,
      }))).catch(() => undefined);
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

  async #openSession(mcpServers = []) {
    this.#session = await this.#rpc.request('session/new', { cwd: this.#projectRoot, mcpServers: normalizeMcpServers(mcpServers) }, REQUEST_TIMEOUT_MS);
    if (!text(this.#session?.sessionId)) throw new Error(`${this.#descriptor.label} ACP did not return a session id.`);
    this.#refreshCapabilities();
    await this.#applyConfiguredSettings();
  }

  async #applyConfiguredSettings() {
    const configuredModel = text(this.#configuration?.primary?.modelID || this.#configuration?.model);
    if (configuredModel && configuredModel !== 'cli-default') {
      const modelSetting = modelRuntimeSetting(this.#capabilities);
      await this.#applySelectSetting(modelSetting, configuredModel, 'model');
    }
    const configuredEffort = text(this.#configuration?.primaryEffort || this.#configuration?.primary?.variant);
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

async function authenticateIfNeeded(rpc, descriptor, initialized) {
  if (descriptor.id !== 'grok-build') return;
  const methods = new Set((Array.isArray(initialized?.authMethods) ? initialized.authMethods : []).map((item) => String(item?.id ?? '')));
  if (!methods.size) return;
  const methodId = process.env.XAI_API_KEY && methods.has('xai.api_key') ? 'xai.api_key' : methods.has('cached_token') ? 'cached_token' : null;
  if (!methodId) throw new Error(descriptor.loginHint);
  await rpc.request('authenticate', { methodId, _meta: { headless: true } }, REQUEST_TIMEOUT_MS);
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
function providerEnvironment(providerId) {
  if (providerId !== 'opencode') return { ...process.env };
  let inherited = {};
  try { const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inherited = parsed; } catch {}
  return { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inherited, permission: { '*': 'ask' } }) };
}
function serializeConversation(messages) { const value=(Array.isArray(messages)?messages:[]).map((m)=>`[${String(m?.role??'user').toUpperCase()}]\n${typeof m?.content==='string'?m.content:JSON.stringify(m?.content??'')}`).join('\n\n'); const bytes=Buffer.from(value,'utf8'); return bytes.length<=MAX_PROMPT_BYTES?value:`${bytes.subarray(bytes.length-MAX_PROMPT_BYTES).toString('utf8')}\n\n[Earlier compiled context truncated by Cuppet before ACP transport.]`; }
function normalizeUsage(value){const s=record(value); if(!Object.keys(s).length)return null; const n=(v)=>Number.isFinite(Number(v))?Number(v):0; return {inputTokens:n(s.inputTokens??s.input_tokens),outputTokens:n(s.outputTokens??s.output_tokens),totalTokens:n(s.totalTokens??s.total_tokens),cachedInputTokens:n(s.cachedInputTokens??s.cached_input_tokens??s.cachedReadTokens),reasoningTokens:n(s.reasoningTokens??s.reasoning_tokens)};}
function enrichProviderError(descriptor,error,stderr){const message=cleanError(error); const detail=cleanError(stderr).trim(); if(/not found|ENOENT/i.test(message)) return new Error(`${descriptor.label} CLI was not found. ${descriptor.loginHint}`); return new Error(detail && !message.includes(detail) ? `${descriptor.label}: ${message}\n${detail}` : `${descriptor.label}: ${message}`);}
function cleanError(error){return error instanceof Error?error.message:String(error??'');}
function stalledError(descriptor){const error=new Error(`${descriptor.label} stopped responding via ACP. The provider/model may be unavailable, rate-limited, out of quota, or the agent process may have stalled.`); error.code='ACP_STALLED'; return error;}
function abortError(){const error=new Error('Provider request aborted.'); error.name='AbortError'; return error;}
function positiveMs(value,fallback){const number=Number(value); return Number.isFinite(number)&&number>0?number:fallback;}
function text(value){return typeof value==='string'?value.trim():'';}
function record(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
