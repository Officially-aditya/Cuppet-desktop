import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { localCliEnvironment, resolveLocalCliExecutable } from './local-cli-environment.mjs';
import { localCliLaunch } from './local-cli-launch.mjs';
import { sanitizeEnvironment } from './sandbox/env-sanitizer.mjs';
import { redactCredentials } from './credential-sanitization.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_STDERR = 8 * 1024;
const MAX_TEXT = 128 * 1024;
const MAX_TOOLS = 64;
const MAX_TOOL_PAGES = 8;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_DEBOUNCE_MS = 200;
const KILL_GRACE_MS = 1_500;
// The sandbox sanitizer's allowlist is POSIX-shaped; Windows programs need these to start at all.
const WINDOWS_ENVIRONMENT = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH'];
// Reachability settings. The sandbox sanitizer strips some of these because its credential pattern matches "CERT", but
// they are file paths and endpoints, not secrets, and launchers such as `npx` and `uvx` cannot download a server
// behind a TLS-inspecting proxy without them (the symptom is a silent hang, not an error).
const CONNECTIVITY_ENVIRONMENT = [
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ...['USERCONFIG', 'GLOBALCONFIG', 'CACHE', 'PREFIX', 'REGISTRY', 'CAFILE', 'STRICT_SSL', 'PROXY', 'HTTPS_PROXY'].flatMap((name) => [`NPM_CONFIG_${name}`, `npm_config_${name.toLowerCase()}`]),
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'UV_CACHE_DIR',
];

/**
 * The environment an MCP server starts with: the recovered login PATH (a Finder-launched app has a bare one, which
 * is why `npx` would otherwise not be found), a small allowlist of non-credential variables, and connectivity
 * settings. Provider API keys and tokens in Cuppet's own environment are never inherited; only what the user
 * configured is added.
 *
 * This is hygiene, not isolation: a server runs unsandboxed as the user and can read `~/.npmrc`, `~/.aws` and so on
 * by itself. What it prevents is Cuppet's own secrets reaching a server by accident. Proxy URLs can carry credentials;
 * they are passed on deliberately, because nothing can be downloaded behind a proxy without them.
 */
export function mcpChildEnvironment(userEnv = {}, inherited = process.env, platform = process.platform, options = {}) {
  const recovered = localCliEnvironment(inherited, { ...options, platform });
  const environment = sanitizeEnvironment(recovered, {});
  copyVariables(environment, recovered, CONNECTIVITY_ENVIRONMENT, false);
  if (platform === 'win32') copyVariables(environment, recovered, WINDOWS_ENVIRONMENT, true);
  return { ...environment, ...userEnv };
}

function copyVariables(target, source, names, caseInsensitive) {
  for (const name of names) {
    const actual = caseInsensitive ? Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase()) : (Object.hasOwn(source, name) ? name : undefined);
    if (actual && typeof source[actual] === 'string' && !Object.hasOwn(target, name)) target[name] = source[actual];
  }
}

export class McpStdioClient {
  #command; #args; #env; #cwd; #spawn; #inherited; #environmentOptions; #requestTimeoutMs; #onToolsChanged; #onExit;
  #child; #pending = new Map(); #nextId = 1; #buffer = ''; #stderr = ''; #tools = []; #closing = false; #refreshTimer = null; #serverInfo = null; #hasTools = true;

  constructor({ command, args = [], env = {}, cwd = homedir(), spawnImpl = spawn, inherited = process.env, environmentOptions = {}, requestTimeoutMs = REQUEST_TIMEOUT_MS, onToolsChanged = () => {}, onExit = () => {} }) {
    this.#command = command;
    this.#args = args;
    this.#env = env;
    this.#cwd = cwd;
    this.#spawn = spawnImpl;
    this.#inherited = inherited;
    this.#environmentOptions = environmentOptions;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#onToolsChanged = onToolsChanged;
    this.#onExit = onExit;
  }

  get running() { return Boolean(this.#child && this.#child.exitCode === null && !this.#closing); }
  get tools() { return this.#tools; }
  get serverInfo() { return this.#serverInfo; }
  get providesTools() { return this.#hasTools; }
  get diagnostics() { return this.#scrub(this.#stderr).trim(); }

  async start({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (this.#child) throw new Error('MCP server is already started.');
    const environment = mcpChildEnvironment(this.#env, this.#inherited, process.platform, this.#environmentOptions);
    const executable = resolveLocalCliExecutable(this.#command, process.env, { environment });
    const launch = localCliLaunch(executable, this.#args);
    const child = this.#spawn(launch.command, launch.args, {
      cwd: this.#cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: launch.shell,
      // Own process group on POSIX so shutdown reaches what a wrapper such as `npx` launched.
      detached: process.platform !== 'win32',
    });
    this.#child = child;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR); });
    child.once('error', (error) => {
      const missing = error?.code === 'ENOENT';
      this.#failAll(new Error(missing
        ? `Command not found: "${this.#command}". Install it, or use its full path.`
        : `Could not start the server: ${error instanceof Error ? error.message : String(error)}`));
    });
    child.once('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      const stopped = this.#closing;
      this.#failAll(new Error(`The server exited${code === null ? '' : ` (code ${code})`}${signal ? ` on ${signal}` : ''}.`));
      if (!stopped) this.#onExit({ code, signal, diagnostics: this.diagnostics });
    });

    let timer;
    try {
      await Promise.race([
        this.#handshake(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`The server did not finish starting within ${formatSeconds(timeoutMs)}.`)), timeoutMs); }),
      ]);
    } catch (error) {
      const detail = this.diagnostics;
      await this.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail && !message.includes(detail) ? `${message}\n${detail.slice(-800)}` : message);
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(name, args = {}, { signal, timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (signal?.aborted) throw abortError();
    const result = await this.#request('tools/call', { name, arguments: record(args) }, { timeoutMs, signal, cancellable: true });
    return { isError: result?.isError === true, output: renderText(result), contentItems: contentItems(result) };
  }

  async refreshTools() {
    if (!this.#hasTools) { this.#tools = []; return this.#tools; }
    const collected = [];
    let cursor;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {});
      collected.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor || collected.length >= MAX_TOOLS) break;
    }
    const seen = new Set();
    this.#tools = collected.flatMap((tool) => {
      const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
      if (!name || name.length > 128 || seen.has(name)) return [];
      seen.add(name);
      return [{
        name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: record(tool.inputSchema),
        readOnly: tool.annotations?.readOnlyHint === true,
      }];
    }).slice(0, MAX_TOOLS);
    return this.#tools;
  }

  async close() {
    this.#closing = true;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#failAll(new Error('The MCP server was stopped.'));
    const child = this.#child;
    this.#child = undefined;
    // A process that never spawned (command not found) has no pid and nothing to wait for.
    if (!child || child.exitCode !== null || child.pid === undefined) { releaseStreams(child); return; }
    try {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      // Closing stdin is the protocol's shutdown signal; signals follow only if the server ignores it.
      try { child.stdin?.end(); } catch {}
      const gracefully = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS))]);
      if (gracefully) return;
      this.#terminate(child, 'SIGTERM');
      const terminated = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS))]);
      if (!terminated) this.#terminate(child, 'SIGKILL');
    } finally {
      // A descendant that outlives the server would otherwise keep these pipes (and so this process) pinned open.
      releaseStreams(child);
    }
  }

  // --- protocol ---

  // `initialize` is written to the pipe immediately, but a wrapper such as `npx -y` may spend a long time downloading
  // the server before anything reads it. It is therefore bounded only by the startup timeout in start() (a request
  // timer of its own would race it and report a worse message); everything after it, once the server is up, uses
  // the ordinary request timeout. If startup is abandoned, close() rejects the pending request.
  async #handshake() {
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cuppet-desktop', title: 'Cuppet', version: '0.9.0-alpha.1' },
    }, { timeoutMs: null });
    const negotiated = typeof result?.protocolVersion === 'string' ? result.protocolVersion : '';
    if (!SUPPORTED_PROTOCOLS.has(negotiated)) throw new Error(`The server speaks an unsupported MCP version${negotiated ? ` (${negotiated.slice(0, 40)})` : ''}.`);
    this.#serverInfo = result?.serverInfo && typeof result.serverInfo === 'object' ? { name: String(result.serverInfo.name ?? '').slice(0, 80), version: String(result.serverInfo.version ?? '').slice(0, 40) } : null;
    this.#hasTools = Boolean(record(result?.capabilities).tools);
    this.#notify('notifications/initialized', {});
    await this.refreshTools();
  }

  #request(method, params = {}, { timeoutMs = this.#requestTimeoutMs, signal, cancellable = false } = {}) {
    const child = this.#child;
    if (!child?.stdin?.writable || this.#closing) return Promise.reject(new Error('The MCP server is not running.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      let onAbort;
      const settle = (action, value) => {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        action(value);
      };
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          if (cancellable) this.#notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
          settle(reject, new Error(`MCP request timed out after ${formatSeconds(timeoutMs)}: ${method}`));
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal) {
        onAbort = () => {
          if (cancellable) this.#notify('notifications/cancelled', { requestId: id, reason: 'aborted' });
          settle(reject, abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, { resolve: (value) => settle(resolve, value), reject: (error) => settle(reject, error) });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  #notify(method, params = {}) { this.#write({ jsonrpc: '2.0', method, params }); }

  #write(message) {
    const stdin = this.#child?.stdin;
    if (!stdin?.writable) return;
    try { stdin.write(`${JSON.stringify(message)}\n`); } catch {}
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (let newline = this.#buffer.indexOf('\n'); newline >= 0; newline = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
    }
    if (this.#buffer.length > MAX_LINE_CHARS) {
      this.#buffer = '';
      this.#failAll(new Error('The server sent a message that was too large.'));
      void this.close();
    }
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (typeof message.method === 'string') {
      if (hasId) this.#answerServerRequest(message);
      else if (message.method === 'notifications/tools/list_changed') this.#scheduleRefresh();
      return;
    }
    if (!hasId) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(String(message.error?.message || 'MCP request failed').slice(0, 1000)));
    else pending.resolve(message.result);
  }

  // Cuppet declares no client capabilities, so a well-behaved server only ever pings. Anything else gets a proper
  // error instead of silence, so a server never blocks waiting on us.
  #answerServerRequest(message) {
    if (message.method === 'ping') this.#write({ jsonrpc: '2.0', id: message.id, result: {} });
    else this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported by Cuppet: ${String(message.method).slice(0, 80)}` } });
  }

  #scheduleRefresh() {
    if (this.#closing || this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.refreshTools().then(() => this.#onToolsChanged(this.#tools), () => undefined);
    }, REFRESH_DEBOUNCE_MS);
    this.#refreshTimer.unref?.();
  }

  #failAll(error) {
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#pending.clear();
  }

  #terminate(child, signal) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch {}
    }
  }

  // Server output is shown in Settings. Strip anything that looks like a credential, and the configured values themselves.
  #scrub(value) {
    let text = String(value ?? '');
    for (const secret of Object.values(this.#env)) {
      if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
    }
    return redactCredentials(text);
  }
}

function renderText(result) {
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item?.type === 'resource' && item.resource && typeof item.resource === 'object') {
      parts.push(typeof item.resource.text === 'string' ? item.resource.text : `[binary resource omitted${typeof item.resource.mimeType === 'string' ? `: ${item.resource.mimeType.slice(0, 80)}` : ''}]`);
    } else if (item?.type === 'resource_link') parts.push(`[resource: ${String(item.name ?? item.uri ?? '').slice(0, 200)}${item.uri ? ` ${String(item.uri).slice(0, 500)}` : ''}]`);
    else if (item?.type === 'audio') parts.push('[audio content omitted]');
    else if (item?.type === 'image') parts.push('[image]');
  }
  const joined = parts.join('\n\n');
  if (joined.trim()) return joined.slice(0, MAX_TEXT);
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent).slice(0, MAX_TEXT);
  return '';
}

function contentItems(result) {
  const items = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') items.push({ type: 'inputText', text: item.text.slice(0, MAX_TEXT) });
    else if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      const mimeType = item.mimeType.toLowerCase();
      if (/^image\/(png|jpeg|webp)$/.test(mimeType) && item.data.length <= 24 * 1024 * 1024) items.push({ type: 'inputImage', imageUrl: `data:${mimeType};base64,${item.data}` });
    }
  }
  if (!items.length) {
    const text = renderText(result);
    if (text) items.push({ type: 'inputText', text });
  }
  return items.slice(0, 8);
}

function releaseStreams(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) { try { stream?.destroy(); } catch {} }
}
function formatSeconds(ms) { return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
