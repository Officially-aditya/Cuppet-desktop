import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { localCliDescriptor } from './local-cli-descriptors.mjs';

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const TAIL_SETTLE_MS = 220;
const TAIL_SETTLE_MAX_MS = 1_200;

export function isAcpCliProvider(value) {
  return localCliDescriptor(value)?.transport === 'acp';
}

export function acpCliDescriptor(value) {
  const descriptor = localCliDescriptor(value);
  return descriptor?.transport === 'acp' ? descriptor : null;
}

export function acpModelCatalogFromSession(session = {}) {
  const source = record(session);
  const configOptions = Array.isArray(source.configOptions) ? source.configOptions : [];
  const selector = configOptions.find((item) => String(item?.category ?? '').toLowerCase() === 'model')
    ?? configOptions.find((item) => item?.type === 'select' && /model/i.test(String(item?.id ?? item?.name ?? '')));
  const rawOptions = Array.isArray(selector?.options) ? selector.options : [];
  const models = [];
  const seen = new Set();
  for (const raw of rawOptions) {
    const option = record(raw);
    const id = text(option.value || option.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: text(option.name || option.label) || id, ...(text(option.description) ? { description: text(option.description) } : {}) });
  }

  // A few ACP agents shipped the older models object before configOptions stabilized.
  const legacy = record(source.models);
  if (!models.length) {
    const legacyModels = Array.isArray(legacy.availableModels) ? legacy.availableModels : Array.isArray(legacy.models) ? legacy.models : [];
    for (const raw of legacyModels) {
      const option = record(raw);
      const id = text(option.modelId || option.id || option.value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: text(option.name || option.label) || id, ...(text(option.description) ? { description: text(option.description) } : {}) });
    }
  }
  const currentModel = text(selector?.currentValue || legacy.currentModelId || legacy.currentModel);
  if (currentModel && !seen.has(currentModel)) models.unshift({ id: currentModel, label: currentModel });
  return {
    available: models.length > 0,
    source: 'acp',
    configId: text(selector?.id) || null,
    defaultModel: currentModel || null,
    currentModel: currentModel || null,
    models,
  };
}

export async function discoverAcpModelCatalog(providerID, options = {}) {
  const descriptor = acpCliDescriptor(providerID);
  if (!descriptor) throw new Error(`Unsupported ACP provider: ${providerID ?? 'unknown'}`);
  const configuration = record(options.configuration);
  const command = text(configuration.cliCommand) || text(process.env[descriptor.envOverride]) || descriptor.command;
  const args = Array.isArray(configuration.cliArgs) && configuration.cliArgs.length ? configuration.cliArgs.map((value) => String(value)) : [...descriptor.args];
  const cwd = text(options.cwd) || tmpdir();
  const child = spawn(command, args, { cwd, env: providerEnvironment(descriptor.id), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
  const rpc = new AcpRpcClient({ child, descriptor, projectRoot: null, executeTool: undefined, requestAgentPermission: undefined, onDelta: async () => {} });
  try {
    await rpc.ready();
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'Cuppet Desktop', version: '0.9.0-alpha.1' },
    }, REQUEST_TIMEOUT_MS);
    await authenticateIfNeeded(rpc, descriptor, initialized);
    const session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);
    return { providerID: descriptor.id, ...acpModelCatalogFromSession(session) };
  } catch (error) {
    throw enrichProviderError(descriptor, error, rpc.stderr());
  } finally {
    rpc.close();
  }
}

export class AcpCliAgentProvider {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = configuration;
    const descriptor = acpCliDescriptor(configuration.providerID);
    if (!descriptor) throw new Error(`Unsupported local CLI provider: ${configuration.providerID ?? 'unknown'}`);
    this.#descriptor = descriptor;
  }

  async stream(messages, { signal, onDelta = async () => {}, projectRoot = null, executeTool, requestAgentPermission } = {}) {
    if (signal?.aborted) throw abortError();
    const command = text(this.#configuration.cliCommand) || text(process.env[this.#descriptor.envOverride]) || this.#descriptor.command;
    const args = Array.isArray(this.#configuration.cliArgs) && this.#configuration.cliArgs.length
      ? this.#configuration.cliArgs.map((value) => String(value))
      : [...this.#descriptor.args];
    const cwd = projectRoot ? resolve(projectRoot) : tmpdir();
    const env = providerEnvironment(this.#descriptor.id);
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      throw launchError(this.#descriptor, error);
    }

    const rpc = new AcpRpcClient({
      child,
      descriptor: this.#descriptor,
      projectRoot,
      executeTool,
      requestAgentPermission,
      onDelta,
    });
    let sessionId = '';
    let abortListener;
    try {
      await rpc.ready();
      const initialized = await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'Cuppet Desktop', version: '0.9.0-alpha.1' },
      }, REQUEST_TIMEOUT_MS);
      await authenticateIfNeeded(rpc, this.#descriptor, initialized);
      const session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);
      sessionId = text(session?.sessionId);
      if (!sessionId) throw new Error(`${this.#descriptor.label} ACP did not return a session id.`);
      await applyAdvertisedAcpModel(rpc, this.#descriptor, sessionId, session, configuredAcpModel(this.#configuration));

      abortListener = () => {
        rpc.notify('session/cancel', { sessionId });
        rpc.terminate();
      };
      signal?.addEventListener('abort', abortListener, { once: true });

      const promptStarted = Date.now();
      const prompt = await rpc.request('session/prompt', sessionPromptParams(this.#descriptor, sessionId, serializeConversation(messages)), PROMPT_TIMEOUT_MS);
      await rpc.settleTail(promptStarted);
      if (signal?.aborted) throw abortError();
      const output = rpc.text();
      if (!output.trim() && String(prompt?.stopReason ?? '').toLowerCase().includes('cancel')) throw abortError();
      return { text: output, toolCalls: [], usage: normalizeUsage(prompt?.usage ?? prompt?._meta?.usage) };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError();
      throw enrichProviderError(this.#descriptor, error, rpc.stderr());
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      rpc.close();
    }
  }
}

class AcpRpcClient {
  #child; #descriptor; #projectRoot; #executeTool; #requestAgentPermission; #onDelta;
  #pending = new Map(); #nextID = 1; #stderr = ''; #text = ''; #lastUpdateAt = 0; #closed = false;
  #terminals = new Map(); #nextTerminal = 1; #readyPromise;

  constructor({ child, descriptor, projectRoot, executeTool, requestAgentPermission, onDelta }) {
    this.#child = child;
    this.#descriptor = descriptor;
    this.#projectRoot = projectRoot ? resolve(projectRoot) : null;
    this.#executeTool = executeTool;
    this.#requestAgentPermission = requestAgentPermission;
    this.#onDelta = typeof onDelta === 'function' ? onDelta : async () => {};
    this.#readyPromise = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const ready = () => { if (settled) return; settled = true; resolveReady(); };
      const fail = (error) => { if (settled) return; settled = true; rejectReady(launchError(this.#descriptor, error)); };
      child.once('spawn', ready);
      child.once('error', fail);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.#onLine(line));
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-16_000);
    });
    child.on('error', (error) => this.#failAll(launchError(this.#descriptor, error)));
    child.on('exit', (code, signal) => {
      if (this.#closed) return;
      this.#failAll(new Error(`${this.#descriptor.label} ACP exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`));
    });
  }

  ready() { return this.#readyPromise; }
  text() { return this.#text; }
  stderr() { return this.#stderr; }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new Error(`${this.#descriptor.label} ACP is closed.`));
    const id = this.#nextID++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve(value) { clearTimeout(timer); resolveRequest(value); },
        reject(error) { clearTimeout(timer); rejectRequest(error); },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (!this.#closed) this.#write({ jsonrpc: '2.0', method, params });
  }

  async settleTail(startedAt) {
    const stopAt = Date.now() + TAIL_SETTLE_MAX_MS;
    while (Date.now() < stopAt) {
      const anchor = Math.max(startedAt, this.#lastUpdateAt);
      if (Date.now() - anchor >= TAIL_SETTLE_MS) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    }
  }

  terminate() {
    if (this.#closed) return;
    try { this.#child.kill(); } catch {}
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error(`${this.#descriptor.label} ACP closed.`));
    try { this.#child.stdin.end(); } catch {}
    try { this.#child.kill(); } catch {}
  }

  #write(message) {
    try { this.#child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.#failAll(error); }
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message?.method === 'session/update' || message?.method === 'session/notification') {
      void this.#handleUpdate(message.params?.update ?? message.params);
      return;
    }
    if (message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      void this.#handleServerRequest(message).then(
        (result) => this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} }),
        (error) => this.#write({ jsonrpc: '2.0', id: message.id, error: { code: error?.rpcCode ?? -32000, message: cleanError(error) } }),
      );
    }
  }

  async #handleUpdate(update) {
    const source = record(update);
    this.#lastUpdateAt = Date.now();
    if (normalizeUpdateKind(source.sessionUpdate ?? source.type ?? source.kind) === 'agent_message_chunk') {
      const delta = contentText(source.content);
      if (!delta) return;
      this.#text += delta;
      await this.#onDelta(delta);
    }
  }

  async #handleServerRequest(message) {
    const method = String(message.method);
    const params = record(message.params);
    if (method === 'fs/read_text_file') {
      const result = await this.#runCuppetTool(message.id, 'workspace_read', {
        path: params.path,
        ...(Number.isInteger(params.line) ? { start_line: Math.max(1, params.line) } : {}),
        ...(Number.isInteger(params.limit) ? { line_limit: Math.max(1, params.limit) } : {}),
      });
      return { content: result.output };
    }
    if (method === 'fs/write_text_file') {
      await this.#runCuppetTool(message.id, 'workspace_write', { path: params.path, content: params.content });
      return {};
    }
    if (method === 'terminal/create') {
      const command = terminalCommand(params, this.#projectRoot);
      const result = await this.#runCuppetTool(message.id, 'bash', { command, timeout_ms: 120_000 });
      const terminalId = `cuppet-acp-${this.#nextTerminal++}`;
      const exitCode = result.success === true ? 0 : extractExitCode(result.output, 1);
      this.#terminals.set(terminalId, { output: String(result.output ?? ''), exitCode });
      return { terminalId };
    }
    if (method === 'terminal/output') {
      const terminal = this.#terminal(params.terminalId);
      return { output: terminal.output, truncated: false, exitStatus: { exitCode: terminal.exitCode, signal: null } };
    }
    if (method === 'terminal/wait_for_exit') {
      const terminal = this.#terminal(params.terminalId);
      return { exitCode: terminal.exitCode, signal: null };
    }
    if (method === 'terminal/release') {
      this.#terminals.delete(String(params.terminalId ?? ''));
      return {};
    }
    if (method === 'terminal/kill') return {};
    if (method === 'session/request_permission') return this.#permission(params);
    const error = new Error(`Unsupported ACP client request: ${method}`);
    error.rpcCode = -32601;
    throw error;
  }

  async #runCuppetTool(requestId, name, args) {
    if (typeof this.#executeTool !== 'function') throw new Error('Cuppet tool bridge is unavailable for this ACP request.');
    const result = await this.#executeTool({
      id: `acp_${this.#descriptor.id}_${String(requestId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)}`,
      name,
      arguments: JSON.stringify(args),
    });
    if (result?.success !== true) throw new Error(String(result?.output || `${name} failed.`));
    return result;
  }

  async #permission(params) {
    const options = Array.isArray(params.options) ? params.options : [];
    let decision = 'reject';
    try {
      if (typeof this.#requestAgentPermission === 'function') decision = await this.#requestAgentPermission({
        kind: String(params.toolCall?.kind ?? 'other'),
        title: String(params.toolCall?.title ?? 'Agent tool'),
        locations: Array.isArray(params.toolCall?.locations) ? params.toolCall.locations : [],
        rawInput: params.toolCall?.rawInput,
      });
    } catch (error) {
      if (error?.name === 'AbortError') return { outcome: { outcome: 'cancelled' } };
      decision = 'reject';
    }
    const desired = decision === 'always' ? 'allow_always' : decision === 'once' ? 'allow_once' : 'reject_once';
    const option = options.find((item) => item?.kind === desired)
      ?? (decision === 'reject' ? options.find((item) => String(item?.kind ?? '').startsWith('reject')) : options.find((item) => String(item?.kind ?? '').startsWith('allow')));
    if (!option?.optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  #terminal(id) {
    const terminal = this.#terminals.get(String(id ?? ''));
    if (!terminal) throw new Error('Unknown ACP terminal id.');
    return terminal;
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.#pending.clear();
  }
}

async function applyAdvertisedAcpModel(rpc, descriptor, sessionId, session, requestedModel) {
  const requested = text(requestedModel);
  if (!requested || requested === 'cli-default') return;
  const catalog = acpModelCatalogFromSession(session);
  if (!catalog.configId) throw new Error(`${descriptor.label} does not advertise a switchable model selector; leaving its provider default unchanged.`);
  if (!catalog.models.some((item) => item.id === requested)) throw new Error(`${descriptor.label} no longer advertises model '${requested}'. Refresh the model picker.`);
  if (catalog.currentModel === requested) return;
  await rpc.request('session/set_config_option', { sessionId, configId: catalog.configId, value: requested }, REQUEST_TIMEOUT_MS);
}
function configuredAcpModel(configuration) {
  return text(configuration?.primary?.modelID || configuration?.model);
}

function sessionPromptParams(descriptor, sessionId, textValue) {
  const content = [{ type: 'text', text: textValue }];
  return descriptor?.id === 'kiro' ? { sessionId, content } : { sessionId, prompt: content };
}
function normalizeUpdateKind(value) {
  return String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ -]+/g, '_').toLowerCase();
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('');
  return typeof value?.text === 'string' ? value.text : '';
}

async function authenticateIfNeeded(rpc, descriptor, initialized) {
  if (descriptor.id !== 'grok-build') return;
  const methods = new Set((Array.isArray(initialized?.authMethods) ? initialized.authMethods : []).map((item) => String(item?.id ?? '')));
  if (!methods.size) return;
  const methodId = process.env.XAI_API_KEY && methods.has('xai.api_key')
    ? 'xai.api_key'
    : methods.has('cached_token') ? 'cached_token' : null;
  if (!methodId) throw new Error(descriptor.loginHint);
  await rpc.request('authenticate', { methodId, _meta: { headless: true } }, REQUEST_TIMEOUT_MS);
}

function providerEnvironment(providerID) {
  if (providerID !== 'opencode') return { ...process.env };
  let inherited = {};
  try {
    const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inherited = parsed;
  } catch {}
  return {
    ...process.env,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inherited, permission: { '*': 'ask' } }),
  };
}

function terminalCommand(params, projectRoot) {
  const command = text(params.command);
  if (!command) throw new Error('ACP terminal command is required.');
  const args = Array.isArray(params.args) ? params.args.map((item) => String(item)) : [];
  const env = (Array.isArray(params.env) ? params.env : []).flatMap((item) => {
    const name = text(item?.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return [];
    return [`${name}=${shellQuote(String(item?.value ?? ''))}`];
  });
  let prefix = '';
  const requestedCwd = text(params.cwd);
  if (requestedCwd && projectRoot) {
    const root = resolve(projectRoot);
    const target = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(root, requestedCwd);
    const within = relative(root, target);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('ACP terminal cwd escapes the project workspace.');
    if (within) prefix = `cd ${shellQuote(target)} && `;
  }
  return `${prefix}${env.length ? `${env.join(' ')} ` : ''}${[command, ...args].map(shellQuote).join(' ')}`;
}

function shellQuote(value) {
  const textValue = String(value);
  if (process.platform === 'win32') return `"${textValue.replaceAll('"', '\\"')}"`;
  return `'${textValue.replaceAll("'", "'\\''")}'`;
}

function serializeConversation(messages) {
  const textValue = (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role ?? 'user').toUpperCase();
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    return `[${role}]\n${content}`;
  }).join('\n\n');
  const bytes = Buffer.from(textValue, 'utf8');
  if (bytes.length <= MAX_PROMPT_BYTES) return textValue;
  return `${bytes.subarray(bytes.length - MAX_PROMPT_BYTES).toString('utf8')}\n\n[Earlier compiled context truncated by Cuppet before ACP transport.]`;
}

function normalizeUsage(value) {
  const source = record(value);
  if (!Object.keys(source).length) return null;
  return {
    inputTokens: number(source.inputTokens ?? source.input_tokens),
    outputTokens: number(source.outputTokens ?? source.output_tokens),
    totalTokens: number(source.totalTokens ?? source.total_tokens),
    cachedInputTokens: number(source.cachedInputTokens ?? source.cached_input_tokens ?? source.cachedReadTokens),
    reasoningTokens: number(source.reasoningTokens ?? source.reasoning_tokens),
  };
}

function launchError(descriptor, error) {
  const code = error?.code;
  if (code === 'ENOENT') return new Error(`${descriptor.label} CLI was not found. ${descriptor.loginHint}`);
  return error instanceof Error ? error : new Error(String(error));
}
function enrichProviderError(descriptor, error, stderr) {
  const message = cleanError(error);
  const detail = cleanError(stderr).trim();
  if (/not found|ENOENT/i.test(message)) return launchError(descriptor, error);
  return new Error(`${descriptor.label}: ${message}${detail && !message.includes(detail) ? `\n${detail.slice(-1200)}` : ''}`);
}
function extractExitCode(output, fallback) { const match = String(output ?? '').match(/exit code:\s*(-?\d+)/i); return match ? Number(match[1]) : fallback; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 4000); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
