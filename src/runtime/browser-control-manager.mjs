import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const LOCAL_PORT = 8765;
const HEALTH_URL = `http://127.0.0.1:${LOCAL_PORT}/health`;
const REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 12_000;
const MAX_STDERR = 16 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class BrowserControlManager {
  #emit;
  #entry;
  #child;
  #pending = new Map();
  #nextId = 1;
  #stderr = '';
  #tools = new Map();
  #extensionConnected = false;
  #healthTimer;
  #starting;

  constructor({ emit = () => {}, entry = null } = {}) {
    this.#emit = emit;
    this.#entry = entry;
  }

  definitions() {
    if (!this.#extensionConnected || !this.#child || this.#child.exitCode !== null) return [];
    return [...this.#tools.values()].map((tool) => structuredClone(tool.definition));
  }

  has(name) {
    return this.#extensionConnected && this.#tools.has(String(name ?? ''));
  }

  async call(name, args = {}, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    const tool = this.#tools.get(String(name ?? ''));
    if (!tool) throw new Error(`BrowserControl tool is unavailable: ${name}`);
    if (!this.#extensionConnected) throw new Error('Chrome is not connected through browserControl. Open Settings > General > Integrations and connect Chrome.');
    const result = await this.#request('tools/call', { name: tool.mcpName, arguments: record(args) });
    if (signal?.aborted) throw abortError();
    if (result?.isError === true) throw new Error(renderMcpText(result) || `browserControl tool failed: ${tool.mcpName}`);
    const contentItems = mcpContentItems(result);
    const output = renderMcpText(result) || (contentItems.some((item) => item.type === 'inputImage') ? 'browserControl returned a visual browser observation.' : JSON.stringify(result?.structuredContent ?? result ?? null));
    return { output, contentItems };
  }

  async status() {
    const entry = await this.#resolveEntry();
    if (this.#child && this.#child.exitCode === null) await this.#refreshHealth();
    return this.#status(entry);
  }

  async connect() {
    if (this.#child && this.#child.exitCode === null) return this.status();
    if (this.#starting) return this.#starting;
    const starting = this.#start();
    this.#starting = starting;
    try { return await starting; }
    finally { if (this.#starting === starting) this.#starting = undefined; }
  }

  async disconnect() {
    await this.close();
    return this.status();
  }

  async close() {
    clearInterval(this.#healthTimer);
    this.#healthTimer = undefined;
    this.#setExtensionConnected(false);
    this.#tools.clear();
    const child = this.#child;
    this.#child = undefined;
    const error = new Error('browserControl MCP runtime stopped');
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!child || child.exitCode !== null) return;
    try { child.stdin?.end(); } catch {}
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500)),
    ]).catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async #start() {
    const entry = await this.#resolveEntry();
    if (!entry) return this.#status(null, 'browserControl runtime is not bundled in this build.');
    const occupied = await probeHealth();
    if (occupied?.ok) {
      return this.#status(entry, 'Another browserControl local runtime is already using Chrome. Stop it, then try Connect Chrome again.');
    }

    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BROWSERCONTROL_LOCAL_PORT: String(LOCAL_PORT),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#stderr = '';
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR); });
    child.once('error', (error) => this.#failAll(error));
    child.once('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      clearInterval(this.#healthTimer);
      this.#healthTimer = undefined;
      this.#setExtensionConnected(false);
      const detail = this.#stderr.trim();
      this.#failAll(new Error(`browserControl MCP runtime exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})${detail ? `: ${detail.slice(-1200)}` : ''}`));
      this.#emit({ type: 'integration.browser-control.updated', status: this.#statusSync(null, detail || 'browserControl runtime stopped.') });
    });

    try {
      await this.#initialize();
      await this.#loadTools();
      await this.#refreshHealth();
      this.#healthTimer = setInterval(() => void this.#refreshHealth().catch(() => undefined), 1_000);
      this.#healthTimer.unref?.();
      const status = this.#statusSync(entry);
      this.#emit({ type: 'integration.browser-control.updated', status });
      return status;
    } catch (error) {
      const message = cleanError(error, this.#stderr);
      await this.close().catch(() => undefined);
      return this.#status(entry, message);
    }
  }

  async #initialize() {
    let lastError;
    for (const protocolVersion of PROTOCOL_VERSIONS) {
      try {
        await this.#request('initialize', {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'cuppet-desktop', title: 'Cuppet', version: '0.9.0-alpha.1' },
        }, STARTUP_TIMEOUT_MS);
        this.#notify('notifications/initialized', {});
        return;
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('browserControl MCP initialization failed');
  }

  async #loadTools() {
    const collected = [];
    let cursor;
    for (let page = 0; page < 8; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {});
      collected.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    this.#tools.clear();
    const names = new Set();
    for (const source of collected.slice(0, 128)) {
      const mcpName = String(source?.name ?? '').trim();
      if (!mcpName) continue;
      let hostName = browserToolName(mcpName);
      let suffix = 2;
      while (names.has(hostName)) hostName = `${browserToolName(mcpName).slice(0, 60)}_${suffix++}`.slice(0, 64);
      names.add(hostName);
      this.#tools.set(hostName, {
        mcpName,
        definition: {
          type: 'function',
          function: {
            name: hostName,
            description: `browserControl Chrome integration: ${String(source?.description ?? mcpName).slice(0, 3500)}`,
            parameters: schema(source?.inputSchema),
          },
        },
      });
    }
  }

  async #refreshHealth() {
    if (!this.#child || this.#child.exitCode !== null) {
      this.#setExtensionConnected(false);
      return null;
    }
    const health = await probeHealth();
    this.#setExtensionConnected(Boolean(health?.ok && health?.service === 'browsercontrol-local' && health?.extensionConnected));
    return health;
  }

  #setExtensionConnected(value) {
    const next = Boolean(value);
    if (next === this.#extensionConnected) return;
    this.#extensionConnected = next;
    this.#emit({ type: 'integration.browser-control.updated', status: this.#statusSync(this.#entry || null) });
  }

  #request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const child = this.#child;
    if (!child?.stdin?.writable) return Promise.reject(new Error('browserControl MCP runtime is unavailable'));
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`browserControl MCP request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  #notify(method, params = {}) {
    if (!this.#child?.stdin?.writable) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error?.message || 'browserControl MCP request failed')));
    else pending.resolve(message.result);
  }

  #failAll(error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) pending.reject(wrapped);
    this.#pending.clear();
  }

  async #resolveEntry() {
    if (this.#entry && await readable(this.#entry)) return this.#entry;
    const override = String(process.env.CUPPET_BROWSERCONTROL_ENTRY || '').trim();
    const resourcesPath = String(process.env.CUPPET_RESOURCES_PATH || '').trim();
    const candidates = [
      override,
      resourcesPath ? join(resourcesPath, 'browsercontrol', 'dist', 'local', 'runtime.js') : '',
      join(process.cwd(), 'vendor', 'browsercontrol', 'dist', 'local', 'runtime.js'),
      resolve(process.cwd(), '..', 'browserControl', 'dist', 'local', 'runtime.js'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (await readable(candidate)) { this.#entry = candidate; return candidate; }
    }
    return null;
  }

  #status(entry, message = '') { return this.#statusSync(entry, message); }

  #statusSync(entry, message = '') {
    const running = Boolean(this.#child && this.#child.exitCode === null);
    return {
      id: 'browserControl',
      available: Boolean(entry || this.#entry),
      running,
      connected: running && this.#extensionConnected,
      extensionConnected: running && this.#extensionConnected,
      toolCount: running ? this.#tools.size : 0,
      port: LOCAL_PORT,
      message: message || (running
        ? this.#extensionConnected
          ? `Chrome connected through browserControl (${this.#tools.size} MCP tools).`
          : 'browserControl is ready. Waiting for the Chrome extension to connect.'
        : entry || this.#entry
          ? 'Ready to connect Chrome.'
          : 'browserControl runtime is not bundled in this build.'),
    };
  }
}

async function probeHealth() {
  try {
    const response = await fetch(HEALTH_URL, { cache: 'no-store', signal: AbortSignal.timeout(900) });
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function browserToolName(value) {
  const base = String(value).trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  return `browsercontrol_${base}`.slice(0, 64);
}
function schema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'object', properties: {} };
  return structuredClone(value);
}
function renderMcpText(result) {
  const parts = (Array.isArray(result?.content) ? result.content : []).flatMap((item) => {
    if (item?.type === 'text' && typeof item.text === 'string') return [item.text];
    if (item?.type === 'resource' && item.resource) return [JSON.stringify(item.resource)];
    return [];
  });
  if (parts.length) return parts.join('\n\n').slice(0, 128 * 1024);
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent).slice(0, 128 * 1024);
  return '';
}
function mcpContentItems(result) {
  const output = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      output.push({ type: 'inputText', text: item.text.slice(0, 128 * 1024) });
    } else if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      const mimeType = item.mimeType.toLowerCase();
      if (/^image\/(png|jpeg|webp)$/.test(mimeType) && item.data.length <= 24 * 1024 * 1024) {
        output.push({ type: 'inputImage', imageUrl: `data:${mimeType};base64,${item.data}` });
      }
    }
  }
  if (!output.length) {
    const text = renderMcpText(result);
    if (text) output.push({ type: 'inputText', text });
  }
  return output.slice(0, 8);
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
async function readable(path) { try { await access(path, constants.R_OK); return true; } catch { return false; } }
function cleanError(error, stderr = '') {
  const message = error instanceof Error ? error.message : String(error);
  const detail = String(stderr || '').trim();
  return `${message}${detail && !message.includes(detail) ? `: ${detail.slice(-1000)}` : ''}`.slice(0, 1600);
}
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
