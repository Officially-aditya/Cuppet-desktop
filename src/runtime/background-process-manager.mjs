import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_ACTIVE_PER_PROJECT = 16;
const MAX_RETAINED_PROCESSES = 64;
const MAX_LOG_BYTES = 128 * 1024;
const STOP_GRACE_MS = 2_000;

export class BackgroundProcessManager {
  #processes = new Map();
  #closed = false;

  async start({ command, args = [], shell = false, cwd, env, projectRoot, sessionId = null, label = '' }) {
    if (this.#closed) throw new Error('Background process manager is closed.');
    const root = await canonicalRoot(projectRoot ?? cwd);
    const active = [...this.#processes.values()].filter((entry) => entry.projectRoot === root && entry.status === 'running').length;
    if (active >= MAX_ACTIVE_PER_PROJECT) throw new Error(`Background process limit reached (${MAX_ACTIVE_PER_PROJECT} active processes per project).`);

    const id = `process_${randomUUID()}`;
    const child = spawn(command, args, {
      cwd,
      shell,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForSpawn(child);
    const entry = {
      id,
      pid: child.pid,
      child,
      command: String(command),
      commandArgs: args.map(String),
      projectRoot: root,
      sessionId,
      label: String(label || '').slice(0, 120),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };

    child.stdout?.on('data', (chunk) => { entry.stdout = appendLog(entry.stdout, chunk); });
    child.stderr?.on('data', (chunk) => { entry.stderr = appendLog(entry.stderr, chunk); });
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    child.unref();
    child.once('exit', (code, signal) => {
      entry.status = 'exited';
      entry.exitCode = code;
      entry.signal = signal;
      entry.endedAt = Date.now();
      this.#trimRetained();
    });
    child.once('error', (error) => {
      entry.status = 'error';
      entry.stderr = appendLog(entry.stderr, Buffer.from(`${error.message}\n`, 'utf8'));
      entry.endedAt = Date.now();
      this.#trimRetained();
    });

    this.#processes.set(id, entry);
    return snapshot(entry);
  }

  async list(projectRoot) {
    const root = await canonicalRoot(projectRoot);
    return [...this.#processes.values()]
      .filter((entry) => entry.projectRoot === root)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(snapshot);
  }

  async status(processId, projectRoot) {
    return snapshot(await this.#owned(processId, projectRoot));
  }

  async logs(processId, projectRoot, maxBytes = 32 * 1024) {
    const entry = await this.#owned(processId, projectRoot);
    const limit = Math.max(1024, Math.min(Number(maxBytes) || 32 * 1024, MAX_LOG_BYTES));
    return {
      ...snapshot(entry),
      stdout: tailUtf8(entry.stdout, limit),
      stderr: tailUtf8(entry.stderr, limit),
    };
  }

  async stop(processId, projectRoot) {
    const entry = await this.#owned(processId, projectRoot);
    if (entry.status !== 'running') return snapshot(entry);
    await terminate(entry);
    return snapshot(entry);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#processes.values()].filter((entry) => entry.status === 'running').map((entry) => terminate(entry).catch(() => undefined)));
  }

  async #owned(processId, projectRoot) {
    const id = String(processId ?? '').trim();
    if (!id) throw new Error('process_id is required');
    const entry = this.#processes.get(id);
    if (!entry) throw new Error(`Unknown background process: ${id}`);
    const root = await canonicalRoot(projectRoot);
    if (entry.projectRoot !== root) throw new Error('Background process belongs to a different project.');
    return entry;
  }

  #trimRetained() {
    if (this.#processes.size <= MAX_RETAINED_PROCESSES) return;
    const finished = [...this.#processes.values()]
      .filter((entry) => entry.status !== 'running')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.#processes.size > MAX_RETAINED_PROCESSES && finished.length) this.#processes.delete(finished.shift().id);
  }
}

async function canonicalRoot(value) {
  const root = resolve(String(value ?? ''));
  return realpath(root).catch(() => root);
}

function waitForSpawn(child) {
  return new Promise((resolvePromise, reject) => {
    const onSpawn = () => { child.off('error', onError); resolvePromise(); };
    const onError = (error) => { child.off('spawn', onSpawn); reject(error); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function appendLog(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= MAX_LOG_BYTES ? next : next.subarray(next.length - MAX_LOG_BYTES);
}

function tailUtf8(buffer, maxBytes) {
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
}

function snapshot(entry) {
  return {
    processId: entry.id,
    pid: entry.pid,
    status: entry.status,
    label: entry.label || null,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    exitCode: entry.exitCode,
    signal: entry.signal,
  };
}

async function terminate(entry) {
  if (entry.status !== 'running') return;
  if (process.platform === 'win32') {
    await taskkill(entry.pid).catch(() => entry.child.kill('SIGTERM'));
  } else {
    try { process.kill(-entry.pid, 'SIGTERM'); }
    catch { try { entry.child.kill('SIGTERM'); } catch {} }
  }

  if (await waitForExit(entry, STOP_GRACE_MS)) return;
  if (process.platform === 'win32') {
    await taskkill(entry.pid, true).catch(() => entry.child.kill('SIGKILL'));
  } else {
    try { process.kill(-entry.pid, 'SIGKILL'); }
    catch { try { entry.child.kill('SIGKILL'); } catch {} }
  }
  await waitForExit(entry, 500);
}

function waitForExit(entry, timeoutMs) {
  if (entry.status !== 'running') return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => { cleanup(); resolvePromise(entry.status !== 'running'); }, timeoutMs);
    const done = () => { cleanup(); resolvePromise(true); };
    const cleanup = () => { clearTimeout(timer); entry.child.off('exit', done); };
    entry.child.once('exit', done);
  });
}

function taskkill(pid, force = false) {
  return new Promise((resolvePromise, reject) => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`taskkill exited with code ${code}`)));
  });
}
