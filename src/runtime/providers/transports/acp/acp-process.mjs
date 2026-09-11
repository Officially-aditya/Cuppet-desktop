import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AcpProcess {
  #child;
  #closed = false;
  #stderr = '';
  #lineHandlers = new Set();
  #exitHandlers = new Set();
  #readyPromise;

  constructor({ command, args = [], cwd, env = process.env, label = 'ACP provider' }) {
    this.label = label;
    try {
      this.#child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      throw launchError(label, command, error);
    }

    this.#readyPromise = new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const resolveOnce = () => { if (!settled) { settled = true; resolveReady(); } };
      const rejectOnce = (error) => { if (!settled) { settled = true; rejectReady(launchError(label, command, error)); } };
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
      for (const handler of this.#exitHandlers) {
        try { handler({ code, signal, expected: this.#closed }); } catch {}
      }
    });
  }

  ready() { return this.#readyPromise; }
  stderr() { return this.#stderr; }
  onLine(handler) { this.#lineHandlers.add(handler); return () => this.#lineHandlers.delete(handler); }
  onExit(handler) { this.#exitHandlers.add(handler); return () => this.#exitHandlers.delete(handler); }

  write(value) {
    if (this.#closed) throw new Error(`${this.label} process is closed.`);
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  terminate() {
    if (this.#closed) return;
    try { this.#child.kill(); } catch {}
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#child.stdin.end(); } catch {}
    try { this.#child.kill(); } catch {}
  }
}

function launchError(label, command, error) {
  if (error?.code === 'ENOENT') return new Error(`${label} CLI was not found (${command}).`);
  return error instanceof Error ? error : new Error(String(error));
}
