import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';
import { TstBridge, TstClient } from '../src/runtime/tst-client.mjs';
import { WorkspaceTstHandle } from '../src/runtime/workspace-tst-handle.mjs';
import { ContextCompiler } from '../src/runtime/context-compiler.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tst-reliable-')); const root = join(dir, 'project'); await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, handle: new WorkspaceTstHandle({ projectRoot: root, projectStore: join(dir, 'ps'), globalStore: join(dir, 'gs') }) };
}
async function serverFixture(t, onRequest) {
  const { dir } = await fixture(t); const socketPath = join(dir, 's.sock'); const sockets = new Set();
  const reply = (socket, id, result) => { if (socket.destroyed) return; const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header, body])); };
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(); if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
      if (request.method === 'initialize') reply(socket, request.id, { protocol: 'cuppet.tst.v3', capabilities: ['graph.list'] });
      else onRequest(request, (value) => reply(socket, request.id, value));
    } });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return socketPath;
}
test('cancelling the last queued writer preserves its predecessor for later writers', { timeout: 3000 }, async (t) => {
  const { root } = await fixture(t); const writer = new ProjectWriter(); const held = gate(), release = gate();
  const first = writer.withProject(root, async () => { held.resolve(); await release.promise; }); await held.promise;
  const controller = new AbortController(); const cancelled = writer.withProject(root, () => assert.fail('cancelled writer ran'), { signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' }); await tick(); controller.abort(); await rejected;
  let entered = false; const third = writer.withProject(root, () => { entered = true; });
  try { await tick(); await tick(); assert.equal(entered, false, 'third writer entered before the holder released'); assert.equal(writer.activeProjects, 1); }
  finally { release.resolve(); await Promise.all([first, third]); }
  assert.equal(entered, true); await tick(); assert.equal(writer.activeProjects, 0);
});
test('pre-aborted writers and cancelled suspended reacquisitions cannot overlap holders', async (t) => {
  const { root } = await fixture(t); const writer = new ProjectWriter(); const controller = new AbortController();
  const entered = gate(), finish = gate(), suspended = gate(), resume = gate();
  const first = writer.withProject(root, async (lock) => { await lock.suspend(async () => { suspended.resolve(); await resume.promise; }); }, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' }); await suspended.promise;
  const holder = writer.withProject(root, async () => { entered.resolve(); await finish.promise; }); await entered.promise;
  resume.resolve(); await tick(); controller.abort(); await rejected;
  let ran = false; const third = writer.withProject(root, () => { ran = true; });
  try { await tick(); await tick(); assert.equal(ran, false); } finally { finish.resolve(); await Promise.all([holder, third]); }
  await assert.rejects(writer.withProject(root, () => assert.fail('pre-aborted'), { signal: controller.signal }), { name: 'AbortError' });
});
test('RPC cancellation rejects promptly, ignores late replies, and keeps other calls alive', { timeout: 3000 }, async (t) => {
  const received = gate(), late = gate(); let writes = 0;
  const socketPath = await serverFixture(t, (request, reply) => { writes++; if (request.params.slow) { received.resolve(); late.promise.then(() => reply({ late: true })); } else reply({ ok: true }); });
  const client = await TstClient.connect(socketPath, 'token'); t.after(() => client.destroy());
  const controller = new AbortController(); const pending = client.call('graph.list', { slow: true }, { signal: controller.signal, timeoutMs: 1000 });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await received.promise; controller.abort(); await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(client.connected, true); assert.deepEqual(await client.call('graph.list'), { ok: true }); late.resolve(); await tick();
  assert.deepEqual(await client.call('graph.list'), { ok: true });
  await assert.rejects(client.call('memory.remember', {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(writes, 3, 'pre-aborted mutations must never reach the daemon');
});
test('a stalled socket connection has a deadline and destroys its candidate', async () => {
  const candidate = new EventEmitter(); let destroyed = false; candidate.destroy = () => { destroyed = true; };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(TstClient.connect('unused', 'token', { connectImpl: () => candidate, timeoutMs: 20 }), { code: 'TST_TIMEOUT' });
    assert.equal(destroyed, true); assert.equal(candidate.listenerCount('error'), 0); assert.equal(candidate.listenerCount('connect'), 0);
  } finally { clearTimeout(keepAlive); }
});
test('a bridge caller can stop while a shared connection initializes', { timeout: 3000 }, async (t) => {
  const socketPath = await serverFixture(t, (_request, reply) => reply({ ok: true }));
  const bridge = new TstBridge({ socketPath, token: 'token' }); t.after(() => bridge.close());
  const controller = new AbortController(); const pending = bridge.call('graph.list', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.deepEqual(await bridge.call('graph.list'), { ok: true });
});
test('project context forwards Stop to graph, parsing, and session RPCs', async () => {
  const calls = []; const handle = { call: async (_method, _params, options) => { calls.push(options); return {}; }, graphLocate: async (...args) => { calls.push(args.at(-1)); return {}; }, parseStaged: async (...args) => { calls.push(args.at(-1)); return {}; } };
  const manager = { forProject: async () => handle, bindSession: async () => handle, call: (...args) => handle.call(...args) };
  const runtime = new RuntimeTstManager({ manager }); const controller = new AbortController();
  await runtime.runWithProject({ sessionId: 's', projectId: 'p', projectRoot: '/project', signal: controller.signal }, async () => {
    await runtime.graphLocate('Thing'); await runtime.parseStaged('a.js', 'hash', 'source'); await runtime.call('context.prepare', { session_id: 's' });
  });
  assert.equal(calls.length, 3); for (const options of calls) assert.equal(options?.signal, controller.signal);
});
test('a stopped project scope still runs owner cleanup while preventing new RPCs', async () => {
  const controller = new AbortController(); controller.abort(); let resolved = 0; let cleaned = false;
  const runtime = new RuntimeTstManager({ manager: { forProject: async () => { resolved++; throw new Error('must not bind a stopped RPC'); } } });
  await runtime.runWithProject({ projectId: 'p', projectRoot: '/project', signal: controller.signal }, async () => {
    try { await assert.rejects(runtime.call('graph.list'), { name: 'AbortError' }); }
    finally { cleaned = true; }
  });
  assert.equal(cleaned, true); assert.equal(resolved, 0);
});
test('fallback context retrieves relevant bounded memory and never authorizes transcript trimming', async (t) => {
  const { handle } = await fixture(t);
  await handle.rememberMemory('s', { key: 'parser', value: 'The parser uses strict validation', scope: 'project' });
  await handle.rememberMemory('other', { key: 'private', value: 'parser secret', scope: 'session' });
  await handle.rememberMemory('s', { key: 'unrelated', value: 'garden irrigation', scope: 'project' });
  const context = await handle.prepareContext('s', 'fix parser validation');
  assert.ok(context.ltm.some((record) => record.key === 'parser')); assert.ok(!context.memories.some((record) => record.key === 'private' || record.key === 'unrelated'));
  assert.equal(context.observation_complete, false); assert.ok(Buffer.byteLength(JSON.stringify(context)) < 24000);
  const compiler = new ContextCompiler({ tst: handle, cognitiveState: { mode: () => 'build', snapshot: () => ({}) } });
  const messages = Array.from({ length: 5 }, (_, i) => ({ id: String(i), role: 'user', content: 'parser' }));
  const compiled = await compiler.compile({ sessionId: 's', messages, userMessageId: '4', usableTokens: 100 });
  assert.equal(compiled.trimmed, false); assert.ok(compiled.messages.some((message) => message.role === 'system' && message.content.includes('strict validation')));
});
test('fallback memory freshness rejects changed, missing, and escaping evidence paths', async (t) => {
  const { root, dir, handle } = await fixture(t); await writeFile(join(root, 'a.js'), 'first'); await writeFile(join(dir, 'outside'), 'first');
  const record = await handle.rememberMemory('s', { key: 'validation', value: 'parser validation passed', fileHashes: { 'a.js': hash('first') } });
  assert.equal((await handle.recordEvidence('s', record.id, 'command_success', 'npm test', true)).recorded, true);
  assert.equal((await handle.queryMemory('s', 'validation'))[0].verified, true);
  await writeFile(join(root, 'a.js'), 'other');
  let stale = (await handle.queryMemory('s', 'validation'))[0]; assert.equal(stale.stale, true); assert.equal(stale.verified, false);
  assert.equal((await handle.prepareContext('s', 'validation')).ltm.length, 0);
  await rm(join(root, 'a.js')); assert.equal((await handle.queryMemory('s', 'validation'))[0].stale, true);
  await handle.rememberMemory('s', { key: 'outside', value: 'parser', fileHashes: { '../outside': hash('first') } });
  assert.equal((await handle.queryMemory('s', 'outside'))[0].stale, true);
});
test('fallback evidence persists, records failure accurately, and rejects unknown IDs', async (t) => {
  const { root, dir, handle } = await fixture(t);
  const record = await handle.rememberMemory('s', { key: 'remembered', value: 'parser fact' });
  assert.equal((await handle.recordEvidence('s', 'unknown', 'test', 'command', true)).recorded, false);
  await handle.recordEvidence('s', record.id, 'test', 'npm test', true);
  const reloaded = new WorkspaceTstHandle({ projectRoot: root, projectStore: join(dir, 'ps') });
  assert.equal((await reloaded.queryMemory('s', 'remembered'))[0].verified, true);
  await reloaded.recordEvidence('s', record.id, 'test', 'npm test', false);
  const failure = (await handle.queryMemory('s', 'remembered'))[0]; assert.equal(failure.verified, false); assert.equal(failure.evidence.at(-1).success, false);
  assert.equal((await handle.prepareContext('s', 'parser')).ltm.length, 0, 'failed claims must not enter automatic context');
  assert.equal(handle.supports('stm.refresh'), false); assert.equal(handle.supports('graph.trace_summary'), false);
});
test('fallback context budget bounds large retrievals without evicting saved memory', async (t) => {
  const { handle } = await fixture(t);
  await handle.rememberMemory('s', { key: 'keep', value: 'needle keep this preference', scope: 'session', pinned: true });
  for (let i = 0; i < 550; i++) await handle.rememberMemory('s', { key: 'k' + i, value: 'needle ' + '🙂'.repeat(1000), scope: 'session' });
  assert.equal((await handle.queryMemory('s', 'keep'))[0].key, 'keep');
  const context = await handle.prepareContext('s', 'needle');
  assert.ok(context.memories.length <= 24); assert.ok(Buffer.byteLength(JSON.stringify(context)) < 24000);
  assert.equal(context.memories[0].key, 'keep');
});
test('fallback generic RPC hashes use the native field name and pre-aborted calls never mutate memory', async (t) => {
  const { root, handle } = await fixture(t); await writeFile(join(root, 'a.js'), 'first');
  const record = await handle.call('memory.remember', { session_id: 's', key: 'generic', value: 'parser fact', file_hashes: { 'a.js': hash('first') } });
  await handle.recordEvidence('s', record.id, 'test', 'npm test', true);
  await writeFile(join(root, 'a.js'), 'changed');
  assert.equal((await handle.queryMemory('s', 'generic'))[0].stale, true);
  const controller = new AbortController(); controller.abort();
  for (const method of handle.status.capabilities) {
    await assert.rejects(handle.call(method, { session_id: 's', key: 'generic', value: 'overwritten', clear_scope: 'project' }, { signal: controller.signal }), { name: 'AbortError' });
  }
  assert.equal((await handle.queryMemory('s', 'generic'))[0].value, 'parser fact');
});
