import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { providerFailureError } from '../../provider-failure.mjs';

export class AcpProcess {
  #child;
  #closed = false;
  #stderr = '';
  #lineHandlers = new Set();
  #exitHandlers = new Set();
  #readyPromise;
  #state = 'starting';
  #startedAt = null;
  #exitedAt = null;
  #exit = null;

  constructor({ command, args = [], cwd, env = process.env, label = 'ACP provider' }) {
    this.label = label;
    this.command = command;
    try {
      this.#child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      this.#state = 'crashed';
      throw launchError(label, command, error);
    }

    this.#readyPromise = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        this.#state = 'running';
        this.#startedAt = Date.now();
        resolveReady();
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        this.#state = 'crashed';
        rejectReady(launchError(label, command, error));
      };
      this.#child.once('spawn', resolveOnce);
      this.#child.once('error', rejectOnce);
    });

    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => {
      for (const handler of this.#lineHandlers) {
        try { handler(line); } catch {}
      }
    });
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-16_000);
    });
    this.#child.on('exit', (code, signal) => {
      this.#exitedAt = Date.now();
      this.#exit = { code, signal, expected: this.#closed };
      this.#state = this.#closed ? 'stopped' : 'crashed';
      for (const handler of this.#exitHandlers) {
        try { handler(this.#exit); } catch {}
      }
    });
  }

  ready() { return this.#readyPromise; }
  stderr() { return this.#stderr; }
  onLine(handler) { this.#lineHandlers.add(handler); return () => this.#lineHandlers.delete(handler); }
  onExit(handler) { this.#exitHandlers.add(handler); return () => this.#exitHandlers.delete(handler); }
  isRunning() { return this.#state === 'running'; }
  snapshot() {
    return Object.freeze({
      state: this.#state,
      command: this.command,
      startedAt: this.#startedAt,
      exitedAt: this.#exitedAt,
      exit: this.#exit ? { ...this.#exit } : null,
    });
  }

  write(value) {
    if (this.#closed || this.#state === 'stopped') throw transportClosedError(this.label, this.command, 'closed');
    if (this.#state === 'crashed') throw transportClosedError(this.label, this.command, 'exited');
    if (!this.#child.stdin?.writable) throw transportClosedError(this.label, this.command, 'stdin is not writable');
    try {
      this.#child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      throw providerFailureError(`${this.label} ACP transport could not write to the provider process.`, {
        code: 'PROVIDER_TRANSPORT_WRITE',
        category: 'transport_write',
        retryable: true,
        action: 'retry',
        cause: error,
        diagnostic: String(error?.message ?? error ?? ''),
      });
    }
  }

  terminate() {
    if (this.#closed || ['stopped', 'crashed'].includes(this.#state)) return;
    this.#state = 'stopping';
    try { this.#child.kill(); } catch {}
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (!['stopped', 'crashed'].includes(this.#state)) this.#state = 'stopping';
    try { this.#child.stdin.end(); } catch {}
    try { this.#child.kill(); } catch {}
    if (this.#state === 'crashed') this.#state = 'stopped';
  }
}

function launchError(label, command, error) {
  if (error?.code === 'ENOENT') {
    return providerFailureError(`${label} CLI was not found (${command}).`, {
      code: 'PROVIDER_EXECUTABLE_MISSING',
      category: 'executable_missing',
      retryable: false,
      action: 'reconnect_provider',
      cause: error,
      diagnostic: `ENOENT: ${command}`,
    });
  }
  return providerFailureError(`${label} ACP process failed to launch: ${String(error?.message ?? error ?? 'unknown error')}`, {
    code: 'PROVIDER_PROCESS_LAUNCH_FAILED',
    category: 'process_exited',
    retryable: true,
    action: 'retry',
    cause: error,
    diagnostic: String(error?.message ?? error ?? ''),
  });
}

function transportClosedError(label, command, detail) {
  return providerFailureError(`${label} ACP transport is unavailable because the provider process ${detail}.`, {
    code: 'PROVIDER_TRANSPORT_CLOSED',
    category: 'transport_closed',
    retryable: true,
    action: 'retry',
    diagnostic: `${command}: ${detail}`,
  });
}
