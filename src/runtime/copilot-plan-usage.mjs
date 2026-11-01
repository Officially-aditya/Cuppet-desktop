import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { localCliLaunch } from './local-cli-launch.mjs';
import { providerProcessEnvironment } from './providers/cli-command.mjs';

// The SDK server uses Content-Length framing, unlike Copilot's ACP transport.
// Only connection, authentication status and account quota are queried; no sessions.
export class CopilotPlanUsageClient {
  #launch;
  #child;
  #connection;
  #failure;
  #rejectFailure;
  #closed = false;

  constructor(launch) { this.#launch = launch; }

  async start() {
    const launch = localCliLaunch(this.#launch.command, this.#launch.args);
    this.#failure = new Promise((_, reject) => { this.#rejectFailure = reject; });
    this.#failure.catch(() => undefined);
    this.#child = spawn(launch.command, launch.args, {
      cwd: tmpdir(), env: providerProcessEnvironment(this.#launch.env),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: launch.shell,
    });
    // Drain diagnostics, but never retain auth or provider response text.
    this.#child.stderr.resume();
    this.#child.once('error', () => this.#rejectFailure(new Error('GitHub Copilot could not start. Reconnect it in Settings.')));
    this.#child.once('exit', () => this.#rejectFailure(new Error('GitHub Copilot usage connection closed. Try refreshing.')));
    // Do not queue protocol writes until spawn succeeds. A failed spawn can close
    // stdin before vscode-jsonrpc's asynchronous writer gets to its first frame.
    await new Promise((resolve, reject) => {
      this.#child.once('spawn', resolve);
      this.#child.once('error', () => reject(new Error('GitHub Copilot could not start. Reconnect it in Settings.')));
    });
    this.#connection = createMessageConnection(new StreamMessageReader(this.#child.stdout), new StreamMessageWriter(this.#child.stdin));
    this.#connection.onClose(() => this.#rejectFailure(new Error('GitHub Copilot usage connection closed. Try refreshing.')));
    this.#connection.onError(() => this.#rejectFailure(new Error('GitHub Copilot could not read plan usage. Try refreshing.')));
    this.#connection.listen();
    let hello;
    try { hello = await this.request('connect', {}); }
    catch (error) {
      if (error?.code !== -32601 && !/Unhandled method connect/.test(error?.message ?? '')) throw error;
      hello = await this.request('ping', {});
    }
    if (!Number.isInteger(hello?.protocolVersion) || hello.protocolVersion < 2 || hello.protocolVersion > 3) {
      throw new Error('Update GitHub Copilot to read account usage, then reconnect it in Settings.');
    }
  }

  async request(method, params = {}, timeoutMs = 10_000) {
    if (!this.#connection || this.#closed) throw new Error('GitHub Copilot usage connection is unavailable.');
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('GitHub Copilot usage request timed out. Try refreshing.')), timeoutMs);
    });
    try { return await Promise.race([this.#connection.sendRequest(method, params), this.#failure, timeout]); }
    catch (error) {
      if (Number.isInteger(error?.code)) throw Object.assign(new Error('GitHub Copilot could not read plan usage. Try refreshing.'), { code: error.code });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection?.dispose();
    const child = this.#child;
    if (!child) return;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const wait = async () => {
      if (exited()) return;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
        const timer = setTimeout(done, 500);
        child.once('exit', done);
      });
    };
    child.stdin.on('error', () => {});
    child.stdin.end();
    if (!exited()) child.kill('SIGTERM');
    await wait();
    if (!exited()) { child.kill('SIGKILL'); await wait(); }
  }
}
