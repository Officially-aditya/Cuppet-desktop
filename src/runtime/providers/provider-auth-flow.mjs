import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { localCliLaunch } from '../local-cli-launch.mjs';
import { redactCredentials } from '../credential-sanitization.mjs';
import { providerProcessEnvironment } from './cli-command.mjs';

const require = createRequire(import.meta.url);

/** Transient, local-only setup UI. Authentication output is never written to chat history. */
export class ProviderAuthFlow {
  #flows = new Map();
  #emit;
  #pty;
  constructor({ emit = () => {}, ptyModule } = {}) { this.#emit = emit; this.#pty = ptyModule; }

  async connect(providerID, operation) {
    if (this.#flows.has(providerID)) throw new Error('Provider setup is already running. Finish or cancel it first.');
    const flow = { id: randomUUID(), providerID, controller: new AbortController(), terminal: null, browser: null, urls: new Set() };
    this.#flows.set(providerID, flow);
    this.#event(flow, { kind: 'started' });
    const timer = setTimeout(() => flow.controller.abort(new Error('Provider setup timed out. Retry sign-in.')), 10 * 60_000);
    try {
      const result = await operation();
      if (flow.controller.signal.aborted) throw new Error('Provider setup was cancelled.');
      this.#event(flow, { kind: 'finished' });
      return result;
    } catch (error) {
      const failure = flow.controller.signal.aborted
        ? flow.controller.signal.reason?.name === 'AbortError' ? new Error('Provider setup was cancelled.') : flow.controller.signal.reason
        : error;
      this.#event(flow, { kind: 'failed', message: redactCredentials(failure).slice(0, 1000) });
      throw failure;
    } finally {
      clearTimeout(timer);
      flow.controller.abort();
      this.#flows.delete(providerID);
    }
  }

  signal(providerID) { return this.#flows.get(providerID)?.controller.signal; }
  terminalAvailable() {
    try { this.#pty ??= require('node-pty'); return typeof this.#pty.spawn === 'function'; }
    catch { return false; }
  }

  output(providerID, data) {
    const flow = this.#flows.get(providerID);
    if (!flow || flow.controller.signal.aborted) return;
    this.#event(flow, { kind: 'output', data: String(data).slice(-16_384) });
    const plain = String(data).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    if (/auth|sign.?in|log.?in|browser|code|visit|open/i.test(plain)) {
      for (const match of plain.matchAll(/https?:\/\/[^\s<>"'\x1b]+/g)) this.url(providerID, match[0]);
    }
  }

  url(providerID, value) {
    const flow = this.#flows.get(providerID);
    const url = authenticationUrl(value);
    if (!flow || !url || flow.urls.has(url) || flow.controller.signal.aborted) return;
    flow.urls.add(url);
    this.#event(flow, { kind: 'url', url });
  }

  async requestBrowser(providerID, request) {
    const flow = this.#flows.get(providerID);
    const url = authenticationUrl(request?.url);
    if (!flow || !url || request?.mode !== 'url' || flow.browser || flow.controller.signal.aborted) return { action: 'decline' };
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (action) => {
        flow.controller.signal.removeEventListener('abort', cancel);
        flow.browser = null;
        resolve({ action });
      };
      const cancel = () => finish('cancel');
      flow.browser = { requestId, finish };
      flow.controller.signal.addEventListener('abort', cancel, { once: true });
      this.#event(flow, { kind: 'url', url, requestId });
    });
  }

  async runTerminal(providerID, command, args, { env, cwd = tmpdir() } = {}) {
    const flow = this.#flows.get(providerID);
    if (!flow || flow.controller.signal.aborted) throw new Error('Start provider sign-in from Settings.');
    if (flow.terminal) throw new Error('Provider sign-in terminal is already running.');
    const pty = this.#pty ?? require('node-pty');
    const launch = localCliLaunch(command, args);
    const terminal = pty.spawn(launch.shell ? (process.env.ComSpec || 'cmd.exe') : launch.command,
      launch.shell ? ['/d', '/s', '/c', `${launch.command} ${launch.args.join(' ')}`] : launch.args, {
        name: 'xterm-256color', cols: 100, rows: 18, cwd,
        env: providerProcessEnvironment({ ...(env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
      });
    flow.terminal = terminal;
    this.#event(flow, { kind: 'terminal' });
    await new Promise((resolve, reject) => {
      let settled = false;
      let dataSubscription;
      let exitSubscription;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        flow.controller.signal.removeEventListener('abort', cancel);
        dataSubscription?.dispose();
        exitSubscription?.dispose();
        flow.terminal = null;
        try { terminal.kill(); } catch {}
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error('Provider sign-in was cancelled.'));
      dataSubscription = terminal.onData((data) => this.output(providerID, data));
      exitSubscription = terminal.onExit(({ exitCode }) => finish(exitCode === 0 ? null : new Error(`Provider sign-in exited with code ${exitCode}.`)));
      flow.controller.signal.addEventListener('abort', cancel, { once: true });
      if (flow.controller.signal.aborted) cancel();
    });
  }

  respond(authId, response = {}) {
    const flow = [...this.#flows.values()].find((item) => item.id === authId);
    if (!flow || flow.controller.signal.aborted) throw new Error('Provider sign-in is no longer active.');
    if (response.requestId && flow.browser?.requestId === response.requestId) {
      flow.browser.finish(response.action === 'accept' ? 'accept' : 'decline');
    } else if (flow.terminal) {
      if (Number.isInteger(response.cols) && Number.isInteger(response.rows)) {
        flow.terminal.resize(Math.max(20, Math.min(300, response.cols)), Math.max(5, Math.min(100, response.rows)));
      }
      if (typeof response.data === 'string') {
        if (Buffer.byteLength(response.data) > 16_384) throw new Error('Provider sign-in input is too large.');
        flow.terminal.write(response.data);
      }
    } else throw new Error('Provider sign-in is not accepting input.');
    return { accepted: true };
  }

  cancel(authId) {
    const flow = [...this.#flows.values()].find((item) => item.id === authId);
    flow?.controller.abort();
    return { cancelled: Boolean(flow) };
  }
  close() { for (const flow of this.#flows.values()) flow.controller.abort(); }
  #event(flow, event) { this.#emit({ type: 'provider.authentication', providerID: flow.providerID, authId: flow.id, ...event }); }
}

function authenticationUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
