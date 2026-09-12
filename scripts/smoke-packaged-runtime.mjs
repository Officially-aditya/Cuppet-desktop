import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCuppetMcpBridgeEndpoint } from '../src/runtime/providers/transports/acp/cuppet-mcp-endpoint.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] || defaultExecutable(root));
const resources = resourcesDirectory(executable);
const runtimeEntry = join(resources, 'app.asar', 'src', 'runtime', 'main.mjs');
const unpackedMcpEntry = join(resources, 'app.asar.unpacked', 'src', 'runtime', 'providers', 'transports', 'acp', 'cuppet-mcp-stdio.mjs');
const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-e1-packaged-'));

try {
  await access(executable);
  await access(join(resources, 'app.asar'));
  await access(unpackedMcpEntry);

  await smokePackagedMcpHelper(executable, unpackedMcpEntry);

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

  console.log(`E1 packaged runtime + MCP bridge smoke passed: ${executable}`);
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

async function smokePackagedMcpHelper(execPath, mcpEntry) {
  const endpoint = createCuppetMcpBridgeEndpoint();
  const token = randomUUID().replaceAll('-', '');
  if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);

  const bridgeServer = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let authenticated = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error('invalid bridge JSON')); return; }
        if (!authenticated) {
          assert.equal(message.method, 'hello');
          assert.equal(message.token, token);
          authenticated = true;
          socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
          continue;
        }
        if (message.method === 'tools/list') {
          socket.write(`${JSON.stringify({ id: message.id, result: { tools: [{ name: 'cuppet_packaged_smoke', description: 'Packaged MCP smoke tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } })}\n`);
          continue;
        }
        if (message.method === 'tools/call') {
          assert.equal(message.params?.name, 'cuppet_packaged_smoke');
          assert.equal(message.params?.arguments?.value, 'ping');
          socket.write(`${JSON.stringify({ id: message.id, result: { content: [{ type: 'text', text: 'packaged-bridge-ok' }], isError: false } })}\n`);
          continue;
        }
        socket.write(`${JSON.stringify({ id: message.id, error: { message: `unexpected bridge method ${String(message.method ?? '')}` } })}\n`);
      }
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    bridgeServer.once('error', rejectListen);
    bridgeServer.listen(endpoint, () => {
      bridgeServer.off('error', rejectListen);
      resolveListen();
    });
  });

  const child = spawn(execPath, [mcpEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CUPPET_MCP_BRIDGE_ENDPOINT: endpoint,
      CUPPET_MCP_BRIDGE_TOKEN: token,
      CUPPET_MCP_SESSION_ID: 'packaged-smoke',
      CUPPET_MCP_BACKEND_ID: 'opencode',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });

  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || 'MCP request failed'));
    else request.resolve(message.result);
  });
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`packaged MCP helper exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})${stderr ? `: ${stderr}` : ''}`));
    });
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    return withTimeout(new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }), 10_000, () => new Error(`packaged MCP helper timed out: ${method}${stderr ? `: ${stderr}` : ''}`));
  };

  try {
    const initialized = await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'cuppet-packaged-smoke', version: '1' } });
    assert.equal(initialized?.serverInfo?.name, 'cuppet-runtime');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await request('tools/list');
    assert.equal(listed?.tools?.[0]?.name, 'cuppet_packaged_smoke');
    const called = await request('tools/call', { name: 'cuppet_packaged_smoke', arguments: { value: 'ping' } });
    assert.equal(called?.isError, false);
    assert.equal(called?.content?.[0]?.text, 'packaged-bridge-ok');
    child.stdin.end();
    await withTimeout(exitPromise, 8_000, () => new Error(`packaged MCP helper did not exit cleanly${stderr ? `: ${stderr}` : ''}`));
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolveClose) => bridgeServer.close(() => resolveClose())).catch(() => undefined);
    if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
  }
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
