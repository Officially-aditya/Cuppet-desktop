import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const GRACEFUL_SHUTDOWN_MS = 3_000;
const TERMINATE_SHUTDOWN_MS = 1_000;

export class RuntimeClient extends EventEmitter {
  #entry;
  #dataDir;
  #execPath;
  #environment;
  #startupTimeoutMs;
  #child;
  #pending = new Map();
  #stderr = '';
  #readyEvent;

  constructor({ entry, dataDir, execPath = process.execPath, environment = {}, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS }) {
    super();
    this.#entry = entry;
    this.#dataDir = dataDir;
    this.#execPath = execPath;
    this.#environment = environment && typeof environment === 'object' ? { ...environment } : {};
    this.#startupTimeoutMs = Number.isFinite(startupTimeoutMs) ? Math.max(1_000, Math.trunc(startupTimeoutMs)) : DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start() {
    if (this.#child) return;
    await mkdir(this.#dataDir, { recursive: true });
    this.#readyEvent = undefined;
    this.#stderr = '';
    const child = spawn(this.#execPath, [this.#entry], {
      env: {
        ...process.env,
        ...this.#environment,
        ELECTRON_RUN_AS_NODE: '1',
        CUPPET_DATA_DIR: this.#dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_000);
      this.emit('stderr', chunk);
    });
    child.once('exit', (code, signal) => {
      const reason = `Cuppet runtime exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
      for (const pending of this.#pending.values()) pending.reject(new Error(reason));
      this.#pending.clear();
      if (this.#child === child) this.#child = undefined;
      this.#readyEvent = undefined;
      this.emit('exit', { code, signal, stderr: this.#stderr });
    });
    child.once('error', (error) => this.emit('error', error));

    try {
      await this.waitForReady(this.#startupTimeoutMs);
    } catch (error) {
      await this.stop().catch(() => undefined);
      const detail = this.#stderr.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail.slice(-1000)}` : ''}`);
    }
  }

  waitForReady(timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS) {
    if (this.#readyEvent) return Promise.resolve(this.#readyEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Cuppet runtime did not become ready'));
      }, timeoutMs);
      const ready = (event) => {
        if (event?.type !== 'runtime.ready') return;
        cleanup();
        resolve(event);
      };
      const exit = ({ code }) => {
        cleanup();
        reject(new Error(`Cuppet runtime exited before ready (${code ?? 'unknown'})`));
      };
      const failed = (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', ready);
        this.off('exit', exit);
        this.off('error', failed);
      };
      this.on('event', ready);
      this.on('exit', exit);
      this.on('error', failed);
      if (this.#readyEvent) {
        cleanup();
        resolve(this.#readyEvent);
      }
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.#child?.stdin.writable) return Promise.reject(new Error('Cuppet runtime is unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`runtime request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async stop() {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    this.#readyEvent = undefined;

    const gracefulExit = once(child, 'exit').then(() => true).catch(() => true);
    if (child.stdin.writable) child.stdin.end();
    if (await settleBefore(gracefulExit, GRACEFUL_SHUTDOWN_MS)) return;

    if (child.exitCode === null) child.kill('SIGTERM');
    if (await settleBefore(gracefulExit, TERMINATE_SHUTDOWN_MS)) return;
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocol-error', new Error('runtime emitted invalid JSON'));
      return;
    }
    if (message.kind === 'event') {
      if (message.event?.type === 'runtime.ready') this.#readyEvent = message.event;
      this.emit('event', message.event);
      return;
    }
    if (message.kind === 'response' && typeof message.id === 'string') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'runtime request failed'));
      return;
    }
    if (message.kind === 'protocol-error') this.emit('protocol-error', new Error(message.error || 'runtime protocol error'));
  }
}

async function settleBefore(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
