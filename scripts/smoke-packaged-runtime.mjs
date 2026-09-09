import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = resolve(new URL('..', import.meta.url).pathname);
const executable = resolve(process.argv[2] || defaultExecutable(root));
const resources = resourcesDirectory(executable);
const runtimeEntry = join(resources, 'app.asar', 'src', 'runtime', 'main.mjs');
const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-e1-packaged-'));

try {
  await access(executable);
  await access(join(resources, 'app.asar'));

  const first = await startRuntime(executable, runtimeEntry, dataDir);
  assert.equal(first.ready.type, 'runtime.ready');
  const health = await first.request('health');
  assert.equal(health.ok, true);
  assert.equal(health.runtime, 'independent');
  const created = await first.request('session.create', { projectId: null });
  assert.match(created.id, /^session_/);
  await first.stop();

  const second = await startRuntime(executable, runtimeEntry, dataDir);
  const sessions = await second.request('session.list');
  assert.ok(sessions.some((session) => session.id === created.id), 'packaged runtime must restore durable conversations from the same data directory');
  await second.stop();

  console.log(`E1 packaged runtime smoke passed: ${executable}`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function defaultExecutable(projectRoot) {
  if (process.platform === 'win32') return join(projectRoot, 'dist', 'win-unpacked', 'cuppet.exe');
  if (process.platform === 'darwin') return join(projectRoot, 'dist', 'mac', 'Cuppet.app', 'Contents', 'MacOS', 'cuppet');
  return join(projectRoot, 'dist', 'linux-unpacked', 'cuppet');
}

function resourcesDirectory(executablePath) {
  if (process.platform === 'darwin') return resolve(dirname(executablePath), '..', 'Resources');
  return join(dirname(executablePath), 'resources');
}

async function startRuntime(execPath, entry, persistentDir) {
  const child = spawn(execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUPPET_DATA_DIR: persistentDir, CUPPET_NONINTERACTIVE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });

  const pending = new Map();
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.kind === 'event' && message.event?.type === 'runtime.ready') readyResolve(message.event);
    if (message.kind === 'response' && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      message.ok ? item.resolve(message.result) : item.reject(new Error(message.error || 'runtime request failed'));
    }
  });
  child.once('error', readyReject);
  child.once('exit', (code, signal) => {
    const error = new Error(`packaged runtime exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})${stderr ? `: ${stderr}` : ''}`);
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  });

  const ready = await withTimeout(readyPromise, 15_000, () => new Error(`packaged runtime did not become ready${stderr ? `: ${stderr}` : ''}`));
  return {
    ready,
    request(method, params = {}) {
      const id = randomUUID();
      return withTimeout(new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }), 15_000, () => new Error(`packaged runtime request timed out: ${method}`));
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.stdin.end();
      await withTimeout(exited, 8_000, () => new Error(`packaged runtime did not shut down cleanly${stderr ? `: ${stderr}` : ''}`));
    },
  };
}

function withTimeout(promise, timeoutMs, errorFactory) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(errorFactory()), timeoutMs); }),
  ]);
}
