import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimeKey } from '../src/runtime/tst-supervisor.mjs';
import { MANAGED_TST_SOURCE_REVISION } from '../src/runtime/tst-release.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] || defaultExecutable(root));
const resources = resourcesDirectory(executable);
const runtimeEntry = join(resources, 'app.asar', 'src', 'runtime', 'main.mjs');
const workspace = await mkdtemp(join(tmpdir(), 'cuppet-f1-packaged-'));
const dataDir = join(workspace, 'state');
const projectAPath = join(workspace, 'project-a');
const projectBPath = join(workspace, 'project-b');
const managedRuntime = runtimeKey();

try {
  assert.ok(managedRuntime, `managed TST is unsupported on ${process.platform}-${process.arch}`);
  await access(executable);
  await access(join(resources, 'app.asar'));
  const packagedTstDir = join(resources, 'tst', managedRuntime);
  await access(join(packagedTstDir, 'tst-daemon'));
  const packagedMetadata = JSON.parse(await readFile(join(packagedTstDir, 'tst-runtime.json'), 'utf8'));
  assert.equal(packagedMetadata.protocol, 'cuppet.tst.v3');
  assert.equal(packagedMetadata.sourceRevision, MANAGED_TST_SOURCE_REVISION);
  await mkdir(projectAPath, { recursive: true });
  await mkdir(projectBPath, { recursive: true });
  await writeFile(join(projectAPath, 'alpha.js'), 'export function alphaOne() { return 1; }\n');
  await writeFile(join(projectBPath, 'beta.js'), 'export function betaOne() { return 2; }\n');

  const first = await startRuntime(executable, runtimeEntry, dataDir, resources);
  const projectA = await first.request('project.add-local', { path: projectAPath, name: 'F1 project A' });
  const projectB = await first.request('project.add-local', { path: projectBPath, name: 'F1 project B' });
  const sessionA = await first.request('session.create', { projectId: projectA.id });
  const sessionB = await first.request('session.create', { projectId: projectB.id });

  await first.request('memory.remember', { sessionId: sessionA.id, key: 'workspace marker', value: 'alpha-memory', scope: 'project', pinned: true });
  await first.request('memory.remember', { sessionId: sessionB.id, key: 'workspace marker', value: 'beta-memory', scope: 'project', pinned: true });
  await waitForGraph(first, projectA.id, 'alphaOne');
  await waitForGraph(first, projectB.id, 'betaOne');
  assert.equal(hasGraphMatch(await first.request('tst.graph.locate', { projectId: projectA.id, pattern: 'betaOne' }), 'betaOne'), false, 'project A graph must not contain project B symbols');
  assert.equal(hasGraphMatch(await first.request('tst.graph.locate', { projectId: projectB.id, pattern: 'alphaOne' }), 'alphaOne'), false, 'project B graph must not contain project A symbols');

  const status = await first.request('tst.status');
  assert.equal(status.mode, 'managed-native');
  assert.equal(status.protocol, 'cuppet.tst.v3');
  assert.ok(status.runningProjects >= 2, 'two project-bound native daemons should be running');
  assert.equal(new Set(status.projects.map((project) => project.projectKey)).size, status.projects.length, 'project daemons must use distinct project identities');
  assert.equal(JSON.stringify(status).includes('token'), false, 'TST status must not expose daemon auth tokens');
  assert.equal(JSON.stringify(status).includes('.sock'), false, 'TST status must not expose private socket paths');

  await writeFile(join(projectAPath, 'alpha.js'), 'export function alphaTwo() { return 3; }\n');
  const refreshed = await first.request('tst.graph.refresh', { projectId: projectA.id, paths: ['alpha.js'] });
  assert.ok(Array.isArray(refreshed.paths) && refreshed.paths.some((item) => item.path === 'alpha.js'));
  await waitForGraph(first, projectA.id, 'alphaTwo');
  assert.equal(hasGraphMatch(await first.request('tst.graph.locate', { projectId: projectB.id, pattern: 'betaOne' }), 'betaOne'), true, 'refreshing project A must not disturb project B graph');

  await first.stop();

  const second = await startRuntime(executable, runtimeEntry, dataDir, resources);
  const aMemory = memoryRecords(await second.request('memory.query', { sessionId: sessionA.id, query: 'workspace marker', limit: 10 }));
  const bMemory = memoryRecords(await second.request('memory.query', { sessionId: sessionB.id, query: 'workspace marker', limit: 10 }));
  assert.ok(aMemory.some((record) => record.value === 'alpha-memory'), 'project A memory must persist across runtime restart');
  assert.ok(bMemory.some((record) => record.value === 'beta-memory'), 'project B memory must persist across runtime restart');
  assert.equal(aMemory.some((record) => record.value === 'beta-memory'), false, 'project-scoped memory must remain isolated');
  assert.equal(bMemory.some((record) => record.value === 'alpha-memory'), false, 'project-scoped memory must remain isolated');
  await waitForGraph(second, projectA.id, 'alphaTwo');
  await second.stop();

  console.log(`F1 packaged managed TST smoke passed: ${executable}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function memoryRecords(result) {
  const payload = result?.records;
  if (Array.isArray(payload)) return payload;
  return [...(Array.isArray(payload?.stm) ? payload.stm : []), ...(Array.isArray(payload?.ltm) ? payload.ltm : [])];
}
function hasGraphMatch(result, symbol) {
  return (result?.matches ?? []).some((match) => match?.symbol === symbol || match?.name === symbol || match?.node?.name === symbol);
}

async function waitForGraph(runtime, projectId, symbol) {
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    last = await runtime.request('tst.graph.locate', { projectId, pattern: symbol, limit: 12 }).catch(() => null);
    if (hasGraphMatch(last, symbol)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for managed TST graph symbol ${symbol}: ${JSON.stringify(last)}`);
}

function defaultExecutable(projectRoot) {
  if (process.platform === 'win32') return join(projectRoot, 'dist', 'win-unpacked', 'cuppet.exe');
  if (process.platform === 'darwin') return join(projectRoot, 'dist', 'mac', 'Cuppet.app', 'Contents', 'MacOS', 'cuppet');
  return join(projectRoot, 'dist', 'linux-unpacked', 'cuppet');
}
function resourcesDirectory(executablePath) { return process.platform === 'darwin' ? resolve(dirname(executablePath), '..', 'Resources') : join(dirname(executablePath), 'resources'); }

async function startRuntime(execPath, entry, persistentDir, resourcesPath) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUPPET_DATA_DIR: persistentDir, CUPPET_RESOURCES_PATH: resourcesPath, CUPPET_NONINTERACTIVE: '1' };
  delete env.CUPPET_TST_BIN;
  delete env.CUPPET_TST_SOCKET;
  delete env.CUPPET_TST_TOKEN;
  const child = spawn(execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
      const item = pending.get(message.id); pending.delete(message.id);
      message.ok ? item.resolve(message.result) : item.reject(new Error(message.error || 'runtime request failed'));
    }
  });
  child.once('error', readyReject);
  child.once('exit', (code, signal) => {
    const error = new Error(`packaged runtime exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})${stderr ? `: ${stderr}` : ''}`);
    readyReject(error); for (const item of pending.values()) item.reject(error); pending.clear();
  });
  await withTimeout(readyPromise, 15_000, () => new Error(`packaged runtime did not become ready${stderr ? `: ${stderr}` : ''}`));
  return {
    request(method, params = {}, timeoutMs = 30_000) { const id = randomUUID(); return withTimeout(new Promise((resolveRequest, rejectRequest) => { pending.set(id, { resolve: resolveRequest, reject: rejectRequest }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }), timeoutMs, () => new Error(`packaged runtime request timed out: ${method}${stderr ? `: ${stderr}` : ''}`)); },
    async stop() { if (child.exitCode !== null) return; const exited = new Promise((resolveExit) => child.once('exit', resolveExit)); child.stdin.end(); await withTimeout(exited, 10_000, () => new Error(`packaged runtime did not shut down cleanly${stderr ? `: ${stderr}` : ''}`)); },
  };
}

function withTimeout(promise, timeoutMs, errorFactory) { let timer; return Promise.race([promise.finally(() => clearTimeout(timer)), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(errorFactory()), timeoutMs); })]); }
