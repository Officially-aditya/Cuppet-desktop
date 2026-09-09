import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const STARTUP_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDERR = 16 * 1024;

export class CodexAppServerClient extends EventEmitter {
  #command;
  #args;
  #env;
  #child;
  #pending = new Map();
  #nextId = 1;
  #stderr = '';
  #started = false;

  constructor({ command, args = [], env = process.env } = {}) {
    if (!command) throw new Error('Codex app-server command is required');
    this.#command = command;
    this.#args = Array.isArray(args) ? [...args] : [];
    this.#env = { ...env };
  }

  async start() {
    if (this.#started) return this;
    const child = spawn(this.#command, this.#args, {
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#stderr = '';

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR);
      this.emit('stderr', chunk);
    });
    child.once('error', (error) => this.#failAll(error));
    child.once('exit', (code, signal) => {
      const detail = this.#stderr.trim();
      const error = new Error(`Codex app-server exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})${detail ? `: ${detail.slice(-1200)}` : ''}`);
      this.#started = false;
      if (this.#child === child) this.#child = undefined;
      this.#failAll(error);
      this.emit('exit', { code, signal, stderr: this.#stderr });
    });

    try {
      await this.request('initialize', {
        clientInfo: { name: 'cuppet_desktop', title: 'Cuppet', version: '0.9.0-alpha.1' },
        capabilities: { experimentalApi: true },
      }, STARTUP_TIMEOUT_MS);
      this.notify('initialized', {});
      this.#started = true;
      return this;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.#child?.stdin?.writable) return Promise.reject(new Error('Codex app-server is unavailable'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, message, code = -32000) {
    this.#write({ id, error: { code, message: String(message || 'Cuppet tool failed').slice(0, 2000) } });
  }

  async close() {
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    if (!child) return;
    try { child.stdin?.end(); } catch {}
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  #write(message) {
    if (!this.#child?.stdin?.writable) throw new Error('Codex app-server is unavailable');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit('protocol-error', new Error('Codex app-server emitted invalid JSON')); return; }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message || 'Codex app-server request failed')));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.emit('request', message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  #failAll(error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) pending.reject(wrapped);
    this.#pending.clear();
  }
}

export async function resolveCodexAppServerCommand({ resourcesPath = process.env.CUPPET_RESOURCES_PATH, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const override = String(env.CUPPET_CODEX_APP_SERVER_BIN || '').trim();
  if (override) return executableCommand(override, []);

  const runtimeKey = codexRuntimeKey(platform, arch);
  const packaged = resourcesPath && runtimeKey ? join(resourcesPath, 'codex', runtimeKey, executableName(platform)) : null;
  if (packaged && await executable(packaged)) return { command: packaged, args: [], source: 'packaged' };

  if (await commandWorks('codex-app-server', ['--help'], env)) return { command: 'codex-app-server', args: [], source: 'path' };
  const codexOverride = String(env.CUPPET_CODEX_BIN || '').trim();
  for (const candidate of [codexOverride, 'codex'].filter(Boolean)) {
    if (await commandWorks(candidate, ['--version'], env)) return { command: candidate, args: ['app-server'], source: 'codex-cli' };
  }
  return null;
}

export function codexRuntimeKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'win32' && arch === 'arm64') return 'win32-arm64';
  return null;
}

function executableName(platform) { return platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server'; }
async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function executableCommand(command, args) {
  if ((command.includes('/') || command.includes('\\')) && !await executable(command)) throw new Error(`Codex app-server is not executable: ${command}`);
  return { command, args, source: 'override' };
}
function commandWorks(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(false); }, 3_000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
