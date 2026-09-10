import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const DEFAULT_STARTUP_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_PROBE_AFTER_MS = 5 * 60_000;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_RESTART_DELAYS_MS = [0, 250, 1_000];
const GRACEFUL_SHUTDOWN_MS = 3_000;
const TERMINATE_SHUTDOWN_MS = 1_000;
const SAFE_RETRY_METHODS = new Set([
  'health',
  'status',
  'doctor',
  'usage.summary',
  'cognitive.status',
  'session.mode.get',
  'session.auto.get',
  'permission.list',
  'question.list',
  'background.status',
  'plan.get',
  'memory.query',
  'pe3.status',
  'remote.status',
  'remote.devices',
  'session.list',
  'session.get',
  'session.search',
  'session.undo.status',
  'project.list',
  'project.get',
  'project.open',
  'project.github-list',
  'tst.status',
  'tst.graph.locate',
  'tst.graph.refresh',
  'remote.provider-config',
]);

export class RuntimeClient extends EventEmitter {
  #entry;
  #dataDir;
  #execPath;
  #environment;
  #startupTimeoutMs;
  #idleProbeAfterMs;
  #healthProbeTimeoutMs;
  #restartDelaysMs;
  #child;
  #pending = new Map();
  #stderr = '';
  #readyEvent;
  #startPromise;
  #recoveryPromise;
  #shouldRun = false;
  #hasStarted = false;
  #lastActivityAt = 0;
  #expectedExits = new WeakSet();

  constructor({
    entry,
    dataDir,
    execPath = process.execPath,
    environment = {},
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    idleProbeAfterMs = DEFAULT_IDLE_PROBE_AFTER_MS,
    healthProbeTimeoutMs = DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
    restartDelaysMs = DEFAULT_RESTART_DELAYS_MS,
  }) {
    super();
    this.#entry = entry;
    this.#dataDir = dataDir;
    this.#execPath = execPath;
    this.#environment = environment && typeof environment === 'object' ? { ...environment } : {};
    this.#startupTimeoutMs = Number.isFinite(startupTimeoutMs) ? Math.max(1_000, Math.trunc(startupTimeoutMs)) : DEFAULT_STARTUP_TIMEOUT_MS;
    this.#idleProbeAfterMs = Number.isFinite(idleProbeAfterMs) ? Math.max(0, Math.trunc(idleProbeAfterMs)) : DEFAULT_IDLE_PROBE_AFTER_MS;
    this.#healthProbeTimeoutMs = Number.isFinite(healthProbeTimeoutMs) ? Math.max(25, Math.trunc(healthProbeTimeoutMs)) : DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    this.#restartDelaysMs = Array.isArray(restartDelaysMs) && restartDelaysMs.length
      ? restartDelaysMs.slice(0, 8).map((value) => Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
      : [...DEFAULT_RESTART_DELAYS_MS];
    // EventEmitter treats an unhandled "error" event as fatal. Keep runtime/pipe failures observable
    // without allowing a child-process error to crash Electron's main process.
    this.on('error', () => undefined);
  }

  async start() {
    this.#shouldRun = true;
    return this.#ensureStarted();
  }

  async #ensureStarted() {
    if (this.#child?.stdin.writable && this.#readyEvent) return this.#readyEvent;
    if (this.#startPromise) return this.#startPromise;
    if (this.#child) await this.#retireChild(this.#child);

    const startPromise = this.#spawnAndWait();
    this.#startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
    }
  }

  async #spawnAndWait() {
    await mkdir(this.#dataDir, { recursive: true });
    this.#readyEvent = undefined;
    this.#stderr = '';
    const resourceEnvironment = typeof process.resourcesPath === 'string' && process.resourcesPath
      ? { CUPPET_RESOURCES_PATH: process.resourcesPath }
      : {};
    const child = spawn(this.#execPath, [this.#entry], {
      env: {
        ...process.env,
        ...resourceEnvironment,
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
    child.stdin.on('error', (error) => {
      this.emit('error', error);
      if (this.#child === child && this.#shouldRun && this.#hasStarted) {
        void this.#beginRecovery('runtime pipe became unavailable', { replaceCurrent: true }).catch(() => undefined);
      }
    });
    child.once('exit', (code, signal) => {
      const expected = this.#expectedExits.delete(child) || !this.#shouldRun;
      const reason = `Cuppet runtime exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`;
      for (const pending of this.#pending.values()) pending.reject(runtimeError(reason, 'CUPPET_RUNTIME_EXITED'));
      this.#pending.clear();
      if (this.#child === child) this.#child = undefined;
      this.#readyEvent = undefined;
      this.emit('exit', { code, signal, stderr: this.#stderr, expected });
      if (!expected && this.#hasStarted) {
        void this.#beginRecovery(reason).catch(() => undefined);
      }
    });
    child.once('error', (error) => this.emit('error', error));

    try {
      const ready = await this.waitForReady(this.#startupTimeoutMs);
      this.#hasStarted = true;
      this.#lastActivityAt = Date.now();
      return ready;
    } catch (error) {
      await this.#retireChild(child).catch(() => undefined);
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

  async request(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.#recoveryPromise) await this.#recoveryPromise;
    if (!this.#child?.stdin.writable || !this.#readyEvent) {
      if (!this.#shouldRun) throw runtimeUnavailableError();
      if (this.#hasStarted) await this.#beginRecovery('runtime was unavailable before request', { replaceCurrent: true });
      else await this.#ensureStarted();
    }

    await this.#probeAfterIdle(method);

    try {
      return await this.#rawRequest(method, params, timeoutMs);
    } catch (error) {
      if (!this.#shouldRun || !isRuntimeInterruption(error)) throw error;
      const unavailableBeforeWrite = error?.code === 'CUPPET_RUNTIME_UNAVAILABLE';
      await (this.#recoveryPromise ?? this.#beginRecovery(
        unavailableBeforeWrite ? 'runtime pipe was unavailable before request' : `runtime interrupted ${method}`,
        { replaceCurrent: unavailableBeforeWrite },
      ));
      if (unavailableBeforeWrite || SAFE_RETRY_METHODS.has(method)) {
        return this.#rawRequest(method, params, timeoutMs);
      }
      throw runtimeError(
        `Cuppet runtime recovered after ${method} was interrupted. The action was not retried to avoid duplicating work; check the chat state before retrying.`,
        'CUPPET_RUNTIME_ACTION_INTERRUPTED',
      );
    }
  }

  async #probeAfterIdle(method) {
    if (method === 'health' || this.#idleProbeAfterMs <= 0 || !this.#lastActivityAt) return;
    if (Date.now() - this.#lastActivityAt < this.#idleProbeAfterMs) return;
    try {
      await this.#rawRequest('health', {}, this.#healthProbeTimeoutMs);
    } catch (error) {
      if (!this.#shouldRun) throw error;
      await this.#beginRecovery('runtime health check failed after idle', { replaceCurrent: true });
    }
  }

  #rawRequest(method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const child = this.#child;
    if (!child?.stdin.writable) return Promise.reject(runtimeUnavailableError());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(runtimeError(`runtime request timed out: ${method}`, 'CUPPET_RUNTIME_TIMEOUT'));
      }, timeoutMs);
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        callback(value);
      };
      this.#pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        const unavailable = runtimeUnavailableError();
        unavailable.cause = error;
        finish(reject, unavailable);
      }
    });
  }

  async #beginRecovery(reason, { replaceCurrent = false } = {}) {
    if (!this.#shouldRun) throw runtimeUnavailableError();
    if (this.#recoveryPromise) return this.#recoveryPromise;

    const recovery = this.#recover(reason, replaceCurrent);
    this.#recoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.#recoveryPromise === recovery) this.#recoveryPromise = undefined;
    }).catch(() => undefined);
    return recovery;
  }

  async #recover(reason, replaceCurrent) {
    this.emit('event', { type: 'runtime.recovering', reason });
    this.emit('recovering', { reason });
    if (replaceCurrent && this.#child) await this.#retireChild(this.#child).catch(() => undefined);

    let lastError;
    for (let index = 0; index < this.#restartDelaysMs.length; index += 1) {
      if (!this.#shouldRun) throw runtimeUnavailableError();
      const delayMs = this.#restartDelaysMs[index];
      if (delayMs > 0) await delay(delayMs);
      if (!this.#shouldRun) throw runtimeUnavailableError();
      try {
        await this.#ensureStarted();
        const event = { type: 'runtime.recovered', reason, attempt: index + 1 };
        this.emit('event', event);
        this.emit('recovered', event);
        return event;
      } catch (error) {
        lastError = error;
      }
    }

    const message = `Cuppet runtime could not recover: ${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')}`;
    const failure = runtimeError(message, 'CUPPET_RUNTIME_RECOVERY_FAILED');
    this.emit('event', { type: 'runtime.error', message });
    this.emit('recovery-failed', failure);
    throw failure;
  }

  async stop() {
    this.#shouldRun = false;
    if (this.#recoveryPromise) await this.#recoveryPromise.catch(() => undefined);
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    const child = this.#child;
    if (!child) return;
    await this.#retireChild(child);
  }

  async #retireChild(child) {
    if (!child) return;
    this.#expectedExits.add(child);
    if (this.#child === child) {
      this.#child = undefined;
      this.#readyEvent = undefined;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;

    const gracefulExit = once(child, 'exit').then(() => true).catch(() => true);
    if (child.stdin.writable) child.stdin.end();
    if (await settleBefore(gracefulExit, GRACEFUL_SHUTDOWN_MS)) return;

    if (child.exitCode === null) child.kill('SIGTERM');
    if (await settleBefore(gracefulExit, TERMINATE_SHUTDOWN_MS)) return;
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  #handleLine(line) {
    this.#lastActivityAt = Date.now();
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
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'runtime request failed'));
      return;
    }
    if (message.kind === 'protocol-error') this.emit('protocol-error', new Error(message.error || 'runtime protocol error'));
  }
}

function runtimeUnavailableError() {
  return runtimeError('Cuppet runtime is unavailable', 'CUPPET_RUNTIME_UNAVAILABLE');
}

function runtimeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRuntimeInterruption(error) {
  return error?.code === 'CUPPET_RUNTIME_UNAVAILABLE' || error?.code === 'CUPPET_RUNTIME_EXITED';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleBefore(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
