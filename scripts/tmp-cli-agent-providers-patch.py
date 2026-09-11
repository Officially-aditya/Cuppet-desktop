from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor missing in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, count))


Path('src/runtime/acp-cli-provider.mjs').write_text(r'''import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;
const TAIL_SETTLE_MS = 220;
const TAIL_SETTLE_MAX_MS = 1_200;

const DESCRIPTORS = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use.',
  }),
  'grok-build': Object.freeze({
    id: 'grok-build',
    label: 'Grok Build',
    command: 'grok',
    args: ['--no-auto-update', 'agent', 'stdio'],
    envOverride: 'CUPPET_GROK_BIN',
    loginHint: 'Run `grok login` in Terminal once, then retry.',
  }),
});

export function isAcpCliProvider(value) {
  return Boolean(DESCRIPTORS[String(value ?? '').trim().toLowerCase()]);
}

export function acpCliDescriptor(value) {
  const descriptor = DESCRIPTORS[String(value ?? '').trim().toLowerCase()];
  return descriptor ? { ...descriptor, args: [...descriptor.args] } : null;
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

      abortListener = () => {
        rpc.notify('session/cancel', { sessionId });
        rpc.terminate();
      };
      signal?.addEventListener('abort', abortListener, { once: true });

      const promptStarted = Date.now();
      const prompt = await rpc.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: serializeConversation(messages) }],
      }, PROMPT_TIMEOUT_MS);
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
    if (message?.method === 'session/update') {
      void this.#handleUpdate(message.params?.update);
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
    if (source.sessionUpdate === 'agent_message_chunk') {
      const delta = text(source.content?.text);
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
''')

Path('src/main/cli-agent-status.mjs').write_text(r'''import { spawn } from 'node:child_process';
import { acpCliDescriptor } from '../runtime/acp-cli-provider.mjs';

export async function cliAgentStatus(providerID) {
  const descriptor = acpCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');
  const command = String(process.env[descriptor.envOverride] || descriptor.command);
  const versionArgs = descriptor.id === 'grok-build' ? ['version'] : ['--version'];
  try {
    const result = await run(command, versionArgs, 4_000);
    const version = firstLine(result.stdout || result.stderr);
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      available: true,
      installed: true,
      version: version || null,
      loginHint: descriptor.loginHint,
      message: `${descriptor.label} CLI detected${version ? ` · ${version}` : ''}. Authentication stays inside the CLI.`,
    };
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /not found|ENOENT/i.test(String(error?.message ?? error));
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      available: false,
      installed: false,
      version: null,
      loginHint: descriptor.loginHint,
      message: missing ? `${descriptor.label} CLI is not installed or is not on PATH.` : `${descriptor.label} CLI could not be started: ${String(error?.message ?? error).slice(0, 300)}`,
    };
  }
}

function run(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    } catch (error) { rejectRun(error); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {}; rejectRun(new Error('Version check timed out.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}
function firstLine(value) { return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''; }
''')

replace(
    'src/runtime/provider-factory.mjs',
    "import { CodexSubscriptionProvider } from './codex-provider.mjs';\n",
    "import { CodexSubscriptionProvider } from './codex-provider.mjs';\nimport { AcpCliAgentProvider, isAcpCliProvider } from './acp-cli-provider.mjs';\n",
)
replace(
    'src/runtime/provider-factory.mjs',
    "  if (String(configuration?.providerID ?? '').toLowerCase() === 'codex') return new CodexSubscriptionProvider(configuration);\n",
    "  const providerID = String(configuration?.providerID ?? '').toLowerCase();\n  if (providerID === 'codex') return new CodexSubscriptionProvider(configuration);\n  if (isAcpCliProvider(providerID)) return new AcpCliAgentProvider(configuration);\n",
)

replace(
    'src/main/provider-presets.mjs',
    "  openai: Object.freeze({",
    "  opencode: Object.freeze({\n    id: 'opencode',\n    label: 'OpenCode',\n    baseUrl: 'cli://opencode',\n    model: 'cli-default',\n    models: Object.freeze([\n      Object.freeze({ id: 'cli-default', label: 'OpenCode default', description: 'Use the model/provider selected in your local OpenCode configuration.' }),\n    ]),\n    authType: 'local-cli',\n    authLabel: 'Local OpenCode CLI',\n    note: 'Uses your locally installed OpenCode CLI through ACP. Cuppet never reads or stores OpenCode provider credentials.',\n  }),\n  'grok-build': Object.freeze({\n    id: 'grok-build',\n    label: 'Grok Build',\n    baseUrl: 'cli://grok-build',\n    model: 'cli-default',\n    models: Object.freeze([\n      Object.freeze({ id: 'cli-default', label: 'Grok Build default', description: 'Use the default model selected by your local Grok Build account/configuration.' }),\n    ]),\n    authType: 'local-cli',\n    authLabel: 'Local Grok Build CLI',\n    note: 'Uses your locally installed and authenticated Grok Build CLI through ACP. Cuppet never reads or stores Grok credentials.',\n  }),\n  openai: Object.freeze({",
)

replace(
    'src/main/provider-settings.mjs',
    "    const chatGPTProvider = selectedPreset?.authType === 'chatgpt';\n    const encryptedApiKeyConfigured = Boolean(this.#encryptedApiKey);\n    const credentialConfigured = chatGPTProvider || (storage.available && encryptedApiKeyConfigured);",
    "    const chatGPTProvider = selectedPreset?.authType === 'chatgpt';\n    const localCliProvider = selectedPreset?.authType === 'local-cli';\n    const externalCredentialProvider = chatGPTProvider || localCliProvider;\n    const encryptedApiKeyConfigured = Boolean(this.#encryptedApiKey);\n    const credentialConfigured = externalCredentialProvider || (storage.available && encryptedApiKeyConfigured);",
)
replace(
    'src/main/provider-settings.mjs',
    "      apiKeyConfigured: chatGPTProvider ? true : encryptedApiKeyConfigured,\n      credentialConfigured,\n      credentialMode: chatGPTProvider ? 'chatgpt' : 'api-key',\n      authType: selectedPreset?.authType ?? 'api-key',\n      requiresChatGPTAuth: chatGPTProvider,",
    "      apiKeyConfigured: externalCredentialProvider ? true : encryptedApiKeyConfigured,\n      credentialConfigured,\n      credentialMode: selectedPreset?.authType ?? 'api-key',\n      authType: selectedPreset?.authType ?? 'api-key',\n      requiresChatGPTAuth: chatGPTProvider,\n      requiresLocalCli: localCliProvider,",
)
replace(
    'src/main/provider-settings.mjs',
    "      apiKey: selectedPreset?.authType === 'chatgpt' ? '' : this.#decryptApiKey(),",
    "      apiKey: ['chatgpt', 'local-cli'].includes(selectedPreset?.authType) ? '' : this.#decryptApiKey(),",
)
replace(
    'src/main/provider-settings.mjs',
    "    const chatGPTProvider = preset?.authType === 'chatgpt';",
    "    const chatGPTProvider = preset?.authType === 'chatgpt';\n    const localCliProvider = preset?.authType === 'local-cli';\n    const externalCredentialProvider = chatGPTProvider || localCliProvider;",
)
replace(
    'src/main/provider-settings.mjs',
    "    if (!chatGPTProvider) {\n      let parsed; try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }",
    "    if (!externalCredentialProvider) {\n      let parsed; try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }",
)
replace(
    'src/main/provider-settings.mjs',
    "      baseUrl: chatGPTProvider ? baseUrl : baseUrl.replace(/\\/+$/, ''),",
    "      baseUrl: externalCredentialProvider ? baseUrl : baseUrl.replace(/\\/+$/, ''),",
)
replace(
    'src/main/provider-settings.mjs',
    "    if (chatGPTProvider || source.clearApiKey === true || (providerChanged && !(typeof source.apiKey === 'string' && source.apiKey.trim()))) {",
    "    if (externalCredentialProvider || source.clearApiKey === true || (providerChanged && !(typeof source.apiKey === 'string' && source.apiKey.trim()))) {",
)
replace(
    'src/main/provider-settings.mjs',
    "    if (providerID !== activeProviderID) throw new Error('Save this provider first, then add its custom model.');\n\n    const customModel",
    "    if (providerID !== activeProviderID) throw new Error('Save this provider first, then add its custom model.');\n    if (preset?.authType === 'local-cli') throw new Error('Local CLI providers manage their model catalog inside the CLI.');\n\n    const customModel",
)

replace(
    'src/runtime/tool-runtime.mjs',
    "      const response = await adapter.stream(conversation, { signal, onDelta, tools: definitions, projectRoot, executeTool });",
    "      const response = await adapter.stream(conversation, {\n        signal,\n        onDelta,\n        tools: definitions,\n        projectRoot,\n        executeTool,\n        requestAgentPermission: async (request) => {\n          const resources = agentPermissionResources(request);\n          const permission = await this.#permissions.authorize({\n            sessionId,\n            projectRoot,\n            planMode: mode === 'plan',\n            signal,\n            action: agentPermissionAction(request?.kind),\n            resources,\n            description: String(request?.title || 'Allow local coding agent action').slice(0, 500),\n            fingerprintKey: stableJson(request?.rawInput ?? {}),\n          });\n          return permission.source === 'session-exact' ? 'always' : 'once';\n        },\n      });",
)
replace(
    'src/runtime/tool-runtime.mjs',
    "      case 'tst_read': return this.#read(projectRoot, args, authorize);",
    "      case 'tst_read': return this.#read(projectRoot, args, authorize);\n      case 'workspace_read': return this.#rawRead(projectRoot, args, authorize);",
)
# Insert raw read immediately before write helper.
replace(
    'src/runtime/tool-runtime.mjs',
    "  async #write(projectRoot, args, authorize) {",
    "  async #rawRead(projectRoot, args, authorize) {\n    const resolved = await resolveWorkspacePath(projectRoot, args.path, { mustExist: true });\n    await authorize({ action: 'read', resources: [resolved.relative], description: `Read ${resolved.relative}` });\n    const content = await readFile(resolved.absolute, 'utf8');\n    const start = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1);\n    const lines = content.split(/\\r?\\n/);\n    const limit = Number.isInteger(args.line_limit) ? Math.max(1, Math.min(args.line_limit, 20_000)) : null;\n    const output = limit ? lines.slice(start - 1, start - 1 + limit).join('\\n') : start > 1 ? lines.slice(start - 1).join('\\n') : content;\n    if (Buffer.byteLength(output) > MAX_FILE_BYTES) throw new Error(`Read exceeds ${MAX_FILE_BYTES} byte limit`);\n    return { output, paths: [resolved.relative], mutation: false };\n  }\n\n  async #write(projectRoot, args, authorize) {",
)
replace(
    'src/runtime/tool-runtime.mjs',
    "function cleanPrefix(value)",
    "function agentPermissionAction(kind) {\n  const value = String(kind ?? '').toLowerCase();\n  if (['read', 'search'].includes(value)) return 'read';\n  if (['edit', 'delete', 'move', 'write'].includes(value)) return 'edit';\n  if (['execute', 'terminal'].includes(value)) return 'bash';\n  return 'agent-tool';\n}\nfunction agentPermissionResources(request) {\n  const locations = Array.isArray(request?.locations) ? request.locations : [];\n  const paths = locations.flatMap((item) => typeof item?.path === 'string' && item.path.trim() ? [item.path.trim().slice(0, 1024)] : []);\n  return paths.length ? paths.slice(0, 16) : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];\n}\nfunction cleanPrefix(value)",
)

replace(
    'src/main/main.mjs',
    "import { ProviderSettingsStore } from './provider-settings.mjs';\n",
    "import { ProviderSettingsStore } from './provider-settings.mjs';\nimport { cliAgentStatus } from './cli-agent-status.mjs';\n",
)
replace(
    'src/main/main.mjs',
    "  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());",
    "  ipcMain.handle('cuppet:cli-agent:status', (_event, providerID) => cliAgentStatus(validateCliProviderID(providerID)));\n  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());",
)
# Put validator before validateCommandInput.
replace(
    'src/main/main.mjs',
    "function validateCommandInput(value) {",
    "function validateCliProviderID(value) {\n  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';\n  if (!['opencode', 'grok-build'].includes(id)) throw new Error('Unsupported local CLI provider.');\n  return id;\n}\n\nfunction validateCommandInput(value) {",
)

replace(
    'src/preload/preload.cjs',
    "  codexAuth: {\n",
    "  cliAgents: {\n    status: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:status', providerID),\n  },\n  codexAuth: {\n",
)

replace(
    'src/renderer/types.ts',
    "  authType?: 'api-key' | 'chatgpt' | string;\n};",
    "  authType?: 'api-key' | 'chatgpt' | 'local-cli' | string;\n  authLabel?: string;\n  note?: string;\n};",
)
replace(
    'src/renderer/types.ts',
    "  requiresChatGPTAuth?: boolean;\n",
    "  requiresChatGPTAuth?: boolean;\n  requiresLocalCli?: boolean;\n",
)
replace(
    'src/renderer/types.ts',
    "export type BrowserControlStatus = {",
    "export type CliAgentStatus = {\n  providerID: string;\n  label?: string;\n  available: boolean;\n  installed?: boolean;\n  version?: string | null;\n  loginHint?: string;\n  message?: string;\n};\n\nexport type BrowserControlStatus = {",
)
replace(
    'src/renderer/types.ts',
    "  codexAuth: {\n",
    "  cliAgents: {\n    status: (providerID: string) => Promise<CliAgentStatus>;\n  };\n  codexAuth: {\n",
)

# Settings UI imports and local CLI status state.
replace(
    'src/renderer/react/SettingsModal.tsx',
    "import type { ProviderPreset, ProviderSettings, RemoteDevice, Session, TokenUsageSummary } from '../types';",
    "import type { CliAgentStatus, ProviderPreset, ProviderSettings, RemoteDevice, Session, TokenUsageSummary } from '../types';",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "  const [codex, setCodex] = useState<any>({ available: false, loggedIn: false, loginRunning: false, message: 'Checking…' });",
    "  const [codex, setCodex] = useState<any>({ available: false, loggedIn: false, loginRunning: false, message: 'Checking…' });\n  const [cliStatus, setCliStatus] = useState<CliAgentStatus | null>(null);",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "  const isCodex = selected?.authType === 'chatgpt' || providerID === 'codex';",
    "  const isCodex = selected?.authType === 'chatgpt' || providerID === 'codex';\n  const isLocalCli = selected?.authType === 'local-cli';",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "  const refreshDevices = useCallback(async () => {",
    "  const refreshCliStatus = useCallback(async () => {\n    if (!isLocalCli || !providerID) { setCliStatus(null); return; }\n    setCliStatus((current) => current?.providerID === providerID ? current : { providerID, available: false, message: 'Checking local CLI…' });\n    try { setCliStatus(await window.cuppet.cliAgents.status(providerID)); }\n    catch (error) { setCliStatus({ providerID, available: false, message: error instanceof Error ? error.message : String(error) }); }\n  }, [isLocalCli, providerID]);\n\n  const refreshDevices = useCallback(async () => {",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "  useEffect(() => { void refresh(); void refreshCodex(); void refreshDevices(); }, [refresh, refreshCodex, refreshDevices]);",
    "  useEffect(() => { void refresh(); void refreshCodex(); void refreshDevices(); }, [refresh, refreshCodex, refreshDevices]);\n  useEffect(() => { void refreshCliStatus(); }, [refreshCliStatus]);",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "    if (isCodex && !codex.loggedIn) { setSection('account'); setNote('Connect ChatGPT before selecting Codex as the active provider.'); return; }",
    "    if (isCodex && !codex.loggedIn) { setSection('account'); setNote('Connect ChatGPT before selecting Codex as the active provider.'); return; }\n    if (isLocalCli && !cliStatus?.available) { setNote(`${selected.label || selected.id} CLI is not installed or is not available on PATH.`); return; }",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: isCodex ? '' : apiKey });",
    "      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: (isCodex || isLocalCli) ? '' : apiKey });",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "      onSaved({ ...saved, ...(isCodex ? { credentialConfigured: codex.loggedIn, configured: codex.loggedIn && Boolean(saved.primary?.modelID) } : {}) });\n      setNote(isCodex ? 'Codex subscription provider saved.' : `${selected.label || selected.id} saved.`);",
    "      onSaved({ ...saved, ...(isCodex ? { credentialConfigured: codex.loggedIn, configured: codex.loggedIn && Boolean(saved.primary?.modelID) } : {}), ...(isLocalCli ? { credentialConfigured: true, configured: Boolean(cliStatus?.available && saved.primary?.modelID) } : {}) });\n      setNote(isCodex ? 'Codex subscription provider saved.' : isLocalCli ? `${selected.label || selected.id} local CLI provider saved.` : `${selected.label || selected.id} saved.`);",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "              {section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} />}",
    "              {section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} onRefreshCli={refreshCliStatus} />}",
)
# Replace entire PlatformPanel signature and local computed state anchors.
replace(
    'src/renderer/react/SettingsModal.tsx',
    "function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void> }) {\n  const activeProviderID = current?.providerID || current?.primary?.providerID || '';\n  const credentialReady = isCodex ? Boolean(codex.loggedIn) : Boolean(current?.apiKeyConfigured);",
    "function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect, onRefreshCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onRefreshCli: () => void | Promise<void> }) {\n  const activeProviderID = current?.providerID || current?.primary?.providerID || '';\n  const credentialReady = isCodex ? Boolean(codex.loggedIn) : isLocalCli ? Boolean(cliStatus?.available) : Boolean(current?.apiKeyConfigured);",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "        ? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : 'Save an API key first to choose models.')",
    "        ? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Install ${selected?.label || 'the CLI'} first so Cuppet can use it.` : 'Save an API key first to choose models.')",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "      <div className=\"settings-card-heading\"><div><h3>AI provider</h3><p>Select a provider and add its API key. Cuppet fills the official endpoint and default coding model automatically.</p></div></div>",
    "      <div className=\"settings-card-heading\"><div><h3>AI provider</h3><p>Select the backend Cuppet uses. API providers use local secure keys; agent providers use their own installed CLI authentication.</p></div></div>",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "        {selected && <div className=\"provider-preset-note\"><strong>{selected.label || selected.id}</strong><span>{isCodex ? 'Uses your existing ChatGPT Codex subscription through the official OpenAI Codex app-server. Cuppet never reads or stores Codex OAuth credentials.' : 'Official endpoint and default coding model are configured automatically.'}</span></div>}",
    "        {selected && <div className=\"provider-preset-note\"><strong>{selected.label || selected.id}</strong><span>{selected.note || (isCodex ? 'Uses your existing ChatGPT Codex subscription through the official OpenAI Codex app-server. Cuppet never reads or stores Codex OAuth credentials.' : 'Official endpoint and default coding model are configured automatically.')}</span></div>}",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "        ) : <label>API key<input type=\"password\" autoComplete=\"new-password\" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder={current?.apiKeyConfigured && current?.providerID === providerID ? 'Saved securely · leave blank to keep it' : 'Enter API key'} /></label>}",
    "        ) : isLocalCli ? (\n          <div className=\"provider-auth-card\">\n            <div className=\"provider-auth-copy\">\n              <div className=\"provider-auth-title-row\"><strong>Local CLI</strong><span className={`settings-status-pill compact${cliStatus?.available ? '' : ' muted'}`}>{cliStatus?.available ? 'Detected' : cliStatus ? 'Not detected' : 'Checking…'}</span></div>\n              <span>{cliStatus?.message || `Checking for ${selected?.label || providerID} on this computer…`}</span>\n              {cliStatus?.loginHint && <span>{cliStatus.loginHint}</span>}\n            </div>\n            <div className=\"provider-auth-actions\"><button type=\"button\" className=\"ghost-button settings-action-button\" disabled={busy} onClick={() => void onRefreshCli()}>Refresh</button></div>\n          </div>\n        ) : <label>API key<input type=\"password\" autoComplete=\"new-password\" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder={current?.apiKeyConfigured && current?.providerID === providerID ? 'Saved securely · leave blank to keep it' : 'Enter API key'} /></label>}",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "        {selected && <CustomModelField current={current} providerID={providerID} providerLabel={selected.label || selected.id} apiKey={apiKey} isCodex={isCodex} codex={codex} />}",
    "        {selected && !isLocalCli && <CustomModelField current={current} providerID={providerID} providerLabel={selected.label || selected.id} apiKey={apiKey} isCodex={isCodex} codex={codex} />}",
)

# Friendlier activity label for ACP raw reads.
replace(
    'src/renderer/react/ChatPane.tsx',
    "  if (toolName === 'tst_read') return target",
    "  if (toolName === 'workspace_read') return target\n    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)\n    : phrase('Reading…', 'Read file', 'Couldn’t read file');\n  if (toolName === 'tst_read') return target",
)
replace(
    'src/renderer/react/ChatPane.tsx',
    "  if (toolName === 'tst_read') {\n    add(args.path);",
    "  if (toolName === 'tst_read' || toolName === 'workspace_read') {\n    add(args.path);",
)

# ACP protocol test fixture and targeted test.
Path('test/fixtures').mkdir(parents=True, exist_ok=True)
Path('test/fixtures/fake-acp-agent.mjs').write_text(r'''import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let promptRequest = null;
let cwd = process.cwd();
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    cwd = message.params.cwd;
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptRequest = message.id;
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working. ' } } } });
    write({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'call-1', kind: 'edit', title: 'Edit sample.txt', locations: [{ path: `${cwd}/sample.txt` }] }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] } });
    return;
  }
  if (message.id === 'perm-1' && message.result?.outcome?.optionId === 'yes') {
    write({ jsonrpc: '2.0', id: 'read-1', method: 'fs/read_text_file', params: { sessionId: 'fake-session', path: `${cwd}/sample.txt` } });
    return;
  }
  if (message.id === 'read-1' && message.result?.content === 'hello') {
    write({ jsonrpc: '2.0', id: 'write-1', method: 'fs/write_text_file', params: { sessionId: 'fake-session', path: `${cwd}/sample.txt`, content: 'hello world' } });
    return;
  }
  if (message.id === 'write-1' && message.result) {
    write({ jsonrpc: '2.0', id: 'term-1', method: 'terminal/create', params: { sessionId: 'fake-session', command: 'printf', args: ['ok'] } });
    return;
  }
  if (message.id === 'term-1' && message.result?.terminalId) {
    write({ jsonrpc: '2.0', id: 'wait-1', method: 'terminal/wait_for_exit', params: { sessionId: 'fake-session', terminalId: message.result.terminalId } });
    return;
  }
  if (message.id === 'wait-1') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    write({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
  }
});
''')
Path('test/acp-cli-provider.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpCliAgentProvider } from '../src/runtime/acp-cli-provider.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

test('ACP CLI provider delegates filesystem and terminal operations through Cuppet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-acp-'));
  await writeFile(join(root, 'sample.txt'), 'hello');
  const calls = [];
  const permissions = [];
  let streamed = '';
  const provider = new AcpCliAgentProvider({ providerID: 'opencode', cliCommand: process.execPath, cliArgs: [fixture] });
  try {
    const result = await provider.stream([{ role: 'user', content: 'Update the sample.' }], {
      projectRoot: root,
      onDelta: async (delta) => { streamed += delta; },
      requestAgentPermission: async (request) => { permissions.push(request); return 'once'; },
      executeTool: async (call) => {
        calls.push(call);
        const args = JSON.parse(call.arguments);
        if (call.name === 'workspace_read') return { success: true, output: 'hello', paths: ['sample.txt'], mutation: false };
        if (call.name === 'workspace_write') return { success: true, output: `Wrote ${args.path}`, paths: ['sample.txt'], mutation: true };
        if (call.name === 'bash') return { success: true, output: 'stdout:\nok\nexit code: 0', paths: [], mutation: false };
        return { success: false, output: `unexpected ${call.name}`, paths: [], mutation: false };
      },
    });
    assert.equal(result.text, 'Working. Done.');
    assert.equal(streamed, 'Working. Done.');
    assert.deepEqual(calls.map((call) => call.name), ['workspace_read', 'workspace_write', 'bash']);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].kind, 'edit');
    assert.equal(result.usage.totalTokens, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
''')
