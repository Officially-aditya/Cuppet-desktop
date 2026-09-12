import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { CuppetMcpToolSession } from '../transports/acp/cuppet-mcp-tool-session.mjs';

const STARTUP_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8_000;

const DISABLED_NATIVE_TOOLS = Object.freeze({
  bash: false,
  edit: false,
  write: false,
  patch: false,
  read: false,
  glob: false,
  grep: false,
  webfetch: false,
  websearch: false,
  task: false,
  todowrite: false,
  lsp: false,
  skill: false,
  question: false,
});

export function opencodeBackendDefinition() {
  const descriptor = localCliDescriptor('opencode');
  return {
    id: descriptor.id,
    label: descriptor.label,
    transport: descriptor.transport,
    operations: {
      discoverCapabilities: async ({ configuration = {}, options = {} } = {}) => {
        const discover = typeof options.cliDiscover === 'function' ? options.cliDiscover : discoverOpenCodeModels;
        const catalog = await discover(descriptor, {
          configuration,
          runImpl: typeof options.runImpl === 'function' ? options.runImpl : undefined,
        });
        const configuredModel = text(configuration?.primary?.modelID || configuration?.model || configuration?.modelID);
        const configuredVariant = text(configuration?.primary?.variant || configuration?.primaryEffort || configuration?.effort);
        const active = catalog.models.find((model) => model.id === configuredModel) ?? null;
        const variants = Array.isArray(active?.variants) ? active.variants : [];
        return {
          providerID: descriptor.id,
          source: 'opencode-http',
          available: catalog.available !== false && Array.isArray(catalog.models) && catalog.models.length > 0,
          models: Array.isArray(catalog.models) ? catalog.models : [],
          settings: [],
          defaultModel: text(catalog.defaultModel) || null,
          currentModel: active?.id ?? null,
          modelDependentSettings: true,
          ...(variants.length ? {
            reasoning: {
              configId: 'variant',
              currentValue: configuredVariant && variants.includes(configuredVariant) ? configuredVariant : null,
              options: variants.map((id) => ({ id, label: formatVariant(id) })),
            },
          } : {}),
        };
      },
    },
    createRuntime: ({ configuration = {} } = {}) => new OpenCodeServerProvider(configuration),
  };
}

export class OpenCodeServerProvider {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = { ...configuration };
    this.#descriptor = localCliDescriptor('opencode');
  }

  async stream(messages, options = {}) {
    if (options.signal?.aborted) throw abortError();
    const projectRoot = resolve(options.projectRoot || tmpdir());
    const command = text(this.#configuration.cliCommand) || text(process.env[this.#descriptor.envOverride]) || this.#descriptor.command;
    const prefixArgs = Array.isArray(this.#configuration.cliArgs) ? this.#configuration.cliArgs.map(String) : [];
    const toolSession = await maybeToolSession({ options });
    let server;
    try {
      const environment = openCodeEnvironment(process.env, toolSession?.descriptor());
      server = await startOpenCodeServer({
        command,
        prefixArgs,
        cwd: projectRoot,
        environment,
        signal: options.signal,
        spawnImpl: typeof this.#configuration.spawnImpl === 'function' ? this.#configuration.spawnImpl : spawn,
        fetchImpl: typeof this.#configuration.fetchImpl === 'function' ? this.#configuration.fetchImpl : globalThis.fetch,
      });

      const query = `?directory=${encodeURIComponent(projectRoot)}`;
      const session = await requestJson(`${server.baseUrl}/session${query}`, {
        method: 'POST',
        body: {},
        signal: options.signal,
        fetchImpl: server.fetchImpl,
      });
      const sessionId = text(session?.id || session?.data?.id);
      if (!sessionId) throw new Error('OpenCode server did not return a session id.');

      const selectedModel = text(this.#configuration?.primary?.modelID || this.#configuration?.model || this.#configuration?.modelID);
      const parsedModel = parseOpenCodeModel(selectedModel);
      const selectedVariant = text(this.#configuration?.primary?.variant || this.#configuration?.primaryEffort || this.#configuration?.effort);
      const response = await requestJson(`${server.baseUrl}/session/${encodeURIComponent(sessionId)}/message${query}`, {
        method: 'POST',
        body: {
          ...(parsedModel ? { model: parsedModel } : {}),
          ...(selectedVariant ? { variant: selectedVariant } : {}),
          agent: 'build',
          system: cuppetRuntimeInstructions(),
          tools: DISABLED_NATIVE_TOOLS,
          parts: [{ type: 'text', text: serializeConversation(messages) }],
        },
        signal: options.signal,
        fetchImpl: server.fetchImpl,
      });

      const payload = record(response?.data ?? response);
      const providerError = openCodeResponseError(payload);
      if (providerError) throw providerError;

      const output = extractText(payload.parts);
      if (!output) throw new Error('OpenCode completed without a user-visible response or structured provider error.');
      await options.onDelta?.(output);
      return { text: output, toolCalls: [], usage: normalizeUsage(payload.info) };
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw abortError();
      const detail = server?.stderr?.().trim();
      const message = detail && !cleanError(error).includes(detail)
        ? `OpenCode: ${cleanError(error)}\n${detail.slice(-MAX_ERROR_BYTES)}`
        : `OpenCode: ${cleanError(error)}`;
      throw wrapOpenCodeError(error, message);
    } finally {
      await Promise.allSettled([
        Promise.resolve(server?.close?.()),
        Promise.resolve(toolSession?.close?.()),
      ]);
    }
  }
}

// Kept as a compatibility export for older imports. It no longer uses ACP.
export class OpenCodeAcpProviderV2 extends OpenCodeServerProvider {}

export async function discoverOpenCodeModels(descriptor = localCliDescriptor('opencode'), { configuration = {}, runImpl = runCommand } = {}) {
  const command = text(configuration.cliCommand) || text(process.env[descriptor.envOverride]) || descriptor.command;
  const prefixArgs = Array.isArray(configuration.cliArgs) ? configuration.cliArgs.map(String) : [];
  const { stdout } = await runImpl(command, [...prefixArgs, 'models', '--verbose'], DISCOVERY_TIMEOUT_MS, {
    cwd: text(configuration.projectRoot) || tmpdir(),
    env: openCodeEnvironment(process.env, null),
  });
  const models = parseOpenCodeVerboseModelOutput(stdout);
  return { available: models.length > 0, models, defaultModel: null };
}

export function parseOpenCodeVerboseModelOutput(output = '') {
  const models = [];
  const seen = new Set();
  let currentId = '';
  let metadataLines = [];

  const flush = () => {
    if (!currentId || seen.has(currentId)) {
      currentId = '';
      metadataLines = [];
      return;
    }
    let metadata = {};
    const source = metadataLines.join('\n').trim();
    if (source) {
      try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      } catch {}
    }
    const variants = Object.keys(record(metadata.variants)).filter((id) => text(id)).slice(0, 64);
    const context = positiveInt(record(metadata.limit).context);
    const outputLimit = positiveInt(record(metadata.limit).output);
    models.push({
      id: currentId,
      label: text(metadata.name) || currentId,
      ...(text(metadata.family) ? { description: text(metadata.family) } : {}),
      ...(context ? { context } : {}),
      ...(outputLimit ? { outputLimit } : {}),
      ...(variants.length ? { variants } : {}),
    });
    seen.add(currentId);
    currentId = '';
    metadataLines = [];
  };

  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const plain = stripAnsi(rawLine);
    const line = plain.trim();
    if (isOpenCodeModelId(line)) {
      flush();
      currentId = line;
      continue;
    }
    if (currentId && (metadataLines.length || line.startsWith('{'))) metadataLines.push(plain);
  }
  flush();
  return models;
}

export function parseOpenCodeModelOutput(output = '') {
  const verbose = parseOpenCodeVerboseModelOutput(output);
  if (verbose.length) return verbose;
  const models = [];
  const seen = new Set();
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!isOpenCodeModelId(line) || seen.has(line)) continue;
    seen.add(line);
    models.push({ id: line, label: line });
    if (models.length >= 1024) break;
  }
  return models;
}

/**
 * OpenCode returns model/provider failures inside a successful HTTP response as
 * `info.error`. Treat that as the authoritative turn failure instead of erasing
 * it behind a generic empty-response error.
 */
export function openCodeResponseError(value) {
  const payload = record(value);
  const info = record(payload.info);
  const errorValue = record(info.error ?? payload.error);
  if (!Object.keys(errorValue).length) return null;

  const data = record(errorValue.data);
  const name = text(errorValue.name) || 'OpenCodeError';
  const providerID = text(data.providerID || errorValue.providerID);
  const message = text(data.message || errorValue.message) || 'OpenCode reported a provider error.';
  const status = httpStatus(data.statusCode ?? errorValue.statusCode ?? errorValue.status);
  const prefix = providerID ? `${name} (${providerID})` : name;
  const error = new Error(`${prefix}: ${sanitizeErrorText(message)}`);
  error.name = name;
  if (status) error.status = status;
  if (providerID) error.providerID = providerID;
  error.openCodeError = true;
  return error;
}

async function maybeToolSession({ options }) {
  if (!Array.isArray(options?.tools) || !options.tools.length || typeof options?.executeTool !== 'function') return null;
  const session = new CuppetMcpToolSession({ backendId: 'opencode', sessionId: `opencode-${randomUUID()}` });
  await session.start();
  session.setTurn({ tools: options.tools, executeTool: options.executeTool, signal: options.signal });
  return session;
}

function openCodeEnvironment(inherited, toolDescriptor) {
  const environment = { ...inherited, OPENCODE_DISABLE_AUTOUPDATE: '1' };
  delete environment.OPENCODE_SERVER_PASSWORD;
  delete environment.OPENCODE_SERVER_USERNAME;
  let existing = {};
  try {
    const parsed = JSON.parse(environment.OPENCODE_CONFIG_CONTENT || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {}
  const mcp = toolDescriptor ? {
    'cuppet-runtime': {
      type: 'local',
      command: [toolDescriptor.command, ...(Array.isArray(toolDescriptor.args) ? toolDescriptor.args : [])],
      enabled: true,
      environment: Object.fromEntries((Array.isArray(toolDescriptor.env) ? toolDescriptor.env : [])
        .map((entry) => [text(entry?.name), String(entry?.value ?? '')])
        .filter(([name]) => name)),
    },
  } : {};
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    // Provider credentials/settings remain OpenCode-owned, but all executable
    // tool authority is replaced by Cuppet for this managed server process.
    mcp,
    permission: {
      '*': 'deny',
      'cuppet-runtime_*': 'allow',
      'cuppet_runtime_*': 'allow',
    },
  });
  return environment;
}

async function startOpenCodeServer({ command, prefixArgs, cwd, environment, signal, spawnImpl, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('OpenCode server transport requires fetch().');
  const port = await reservePort();
  const args = [...prefixArgs, 'serve', '--hostname', '127.0.0.1', '--port', String(port)];
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    throw launchError(command, error);
  }
  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitDescription = '';
  child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-MAX_ERROR_BYTES); });
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-MAX_ERROR_BYTES); });
  child.once('exit', (code, exitSignal) => {
    exited = true;
    exitDescription = `OpenCode server exited${code !== null ? ` with code ${code}` : ''}${exitSignal ? ` (${exitSignal})` : ''}.`;
  });
  const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      if (exited) throw new Error(`${exitDescription}${stderr.trim() || stdout.trim() ? ` ${(stderr || stdout).trim().slice(-2000)}` : ''}`);
      try {
        const response = await fetchImpl(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          return {
            baseUrl,
            fetchImpl,
            stderr: () => stderr,
            close: async () => {
              signal?.removeEventListener?.('abort', onAbort);
              await stopChild(child);
            },
          };
        }
        lastError = new Error(`health returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(`OpenCode server did not become healthy.${lastError ? ` ${cleanError(lastError)}` : ''}${stderr.trim() ? ` ${stderr.trim().slice(-2000)}` : ''}`);
  } catch (error) {
    signal?.removeEventListener?.('abort', onAbort);
    await stopChild(child);
    throw error;
  }
}

async function requestJson(url, { method = 'GET', body, signal, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  let payload = null;
  if (raw.trim()) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw.trim().slice(0, MAX_ERROR_BYTES); }
  }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : safeJson(payload);
    const error = new Error(`HTTP ${response.status}${detail ? `: ${sanitizeErrorText(detail)}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return payload ?? {};
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref?.();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? rejectPort(error) : port ? resolvePort(port) : rejectPort(new Error('Could not reserve an OpenCode server port.')));
    });
  });
}

function runCommand(command, args, timeoutMs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || tmpdir(),
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      rejectRun(launchError(command, error));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(rejectRun, new Error(`${command} timed out.`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-2_000_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-MAX_ERROR_BYTES); });
    child.once('error', (error) => finish(rejectRun, launchError(command, error)));
    child.once('exit', (code) => {
      if (code === 0) finish(resolveRun, { stdout, stderr });
      else finish(rejectRun, new Error((stderr || stdout || `${command} exited with code ${code}`).trim().slice(-MAX_ERROR_BYTES)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolveStop(); } };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); return; }
    const timer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch {}
      finish();
    }, 1_500);
    timer.unref?.();
  });
}

function parseOpenCodeModel(value) {
  const id = text(value);
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1 || id === 'cli-default') return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}
function isOpenCodeModelId(value) {
  const line = text(value);
  if (!line || /\s/u.test(line) || !line.includes('/')) return false;
  const slash = line.indexOf('/');
  return slash > 0 && slash < line.length - 1 && /^[A-Za-z0-9._:@+\/-]+$/u.test(line);
}
function formatVariant(value) {
  return text(value).split(/[-_]/u).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}
function serializeConversation(messages) {
  const value = (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role ?? 'user').toUpperCase();
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    return `[${role}]\n${content}`;
  }).join('\n\n');
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= MAX_PROMPT_BYTES
    ? value
    : `${bytes.subarray(bytes.length - MAX_PROMPT_BYTES).toString('utf8')}\n\n[Earlier compiled context truncated by Cuppet.]`;
}
function cuppetRuntimeInstructions() {
  return [
    'You are running as the reasoning backend inside Cuppet.',
    'Cuppet, not OpenCode, owns filesystem mutation, shell execution, browser actions, permissions, and auditing.',
    'Do not attempt to use OpenCode native tools. Use only tools exposed by the cuppet-runtime MCP server when tools are available.',
    'If a Cuppet tool is unavailable, explain what is needed instead of bypassing Cuppet through another execution path.',
  ].join('\n');
}
function extractText(parts) {
  return (Array.isArray(parts) ? parts : []).filter((part) => part?.type === 'text' && typeof part.text === 'string' && !part.synthetic).map((part) => part.text).join('');
}
function normalizeUsage(info) {
  const tokens = record(record(info).tokens);
  if (!Object.keys(tokens).length) return null;
  const cache = record(tokens.cache);
  const input = nonNegative(tokens.input);
  const output = nonNegative(tokens.output);
  const reasoning = nonNegative(tokens.reasoning);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: nonNegative(tokens.total) || input + output,
    cachedInputTokens: nonNegative(cache.read ?? tokens.cacheRead),
    reasoningTokens: reasoning,
  };
}
function wrapOpenCodeError(error, message) {
  const wrapped = new Error(sanitizeErrorText(message), { cause: error instanceof Error ? error : undefined });
  const name = text(error?.name);
  if (name && name !== 'Error') wrapped.name = name;
  const status = httpStatus(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status) wrapped.status = status;
  const providerID = text(error?.providerID);
  if (providerID) wrapped.providerID = providerID;
  return wrapped;
}
function launchError(command, error) { return error?.code === 'ENOENT' ? new Error(`OpenCode CLI was not found (${command}). Run OpenCode once and complete provider sign-in.`) : error instanceof Error ? error : new Error(String(error)); }
function abortError() { const error = new Error('Provider request aborted.'); error.name = 'AbortError'; return error; }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function positiveInt(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0; }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; }
function httpStatus(value) { const number = Number(value); return Number.isInteger(number) && number >= 100 && number <= 599 ? number : 0; }
function safeJson(value) { try { return JSON.stringify(value).slice(0, MAX_ERROR_BYTES); } catch { return ''; } }
function stripAnsi(value) { return String(value ?? '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, ''); }
function sanitizeErrorText(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|secret)\s*[=:]\s*[A-Za-z0-9._~+/=-]{12,}/gi, '$1=[redacted]')
    .slice(0, MAX_ERROR_BYTES);
}
function cleanError(error) { return sanitizeErrorText(error instanceof Error ? error.message : String(error ?? 'Unknown OpenCode error')); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 4000) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
