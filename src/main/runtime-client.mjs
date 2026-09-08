import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export class RuntimeClient extends EventEmitter {
  #entry;
  #dataDir;
  #child;
  #pending = new Map();
  #stderr = '';

  constructor({ entry, dataDir }) {
    super();
    this.#entry = entry;
    this.#dataDir = dataDir;
  }

  async start() {
    if (this.#child) return;
    const child = spawn(process.execPath, [this.#entry], {
      env: {
        ...process.env,
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
      this.#child = undefined;
      this.emit('exit', { code, signal, stderr: this.#stderr });
    });
    child.once('error', (error) => this.emit('error', error));

    await this.waitForReady();
  }

  waitForReady(timeoutMs = 8_000) {
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
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', ready);
        this.off('exit', exit);
      };
      this.on('event', ready);
      this.on('exit', exit);
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
    if (child.stdin.writable) child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
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
