import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';
import { TstBatchEditManager, renderBatchDiff } from '../src/runtime/tst-edit-batches.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';
import { TstBridge } from '../src/runtime/tst-client.mjs';
import { WorkspaceTstHandle } from '../src/runtime/workspace-tst-handle.mjs';
import { PermissionBroker } from '../src/runtime/permissions.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-tst-regression-')); const root = join(dir, 'project'); await mkdir(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  const journal = new MutationJournal(join(dir, 'journal')); await journal.ready();
  const writer = new ProjectWriter();
  const tst = new WorkspaceTstHandle({ projectRoot: root, projectStore: join(dir, 'ps'), globalStore: join(dir, 'gs') });
  const batches = new TstBatchEditManager({ tst, journal, writer });
  t.after(async () => { await tst.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, root, journal, writer, tst, batches };
}
const replace = (path, old_text = 'old', new_text = 'new') => ({ op: 'replace_text', path, old_text, new_text });
const prepare = (env, operations) => env.batches.prepare({ sessionId: 's', projectRoot: env.root, operations });
const apply = (env, batch, options = {}) => env.batches.apply({ batchId: batch.id, sessionId: 's', projectRoot: env.root, executionId: 'e', authorize: async () => {}, ...options });
async function runtimeFixture(t, files, { backend = null, permissions = null } = {}) {
  const env = await fixture(t, files); const db = new ConversationDatabase(join(env.dir, 'db.sqlite3'));
  db.createProject({ id: 'p', name: 'P', canonicalPath: env.root }); db.createSession({ id: 's', projectId: 'p' });
  if (backend) {
    env.tst = backend;
    env.batches = new TstBatchEditManager({ tst: backend, journal: env.journal, writer: env.writer });
  }
  const tools = new ToolRuntime({ tst: env.tst, batchEdits: env.batches, writer: env.writer, db, dataDir: join(env.dir, 'data'), planStore: {},
    permissions: permissions ?? { authorize: async () => ({ allowed: true }), autoStatus: () => ({}) } });
  t.after(() => db.close());
  const call = async (name, args) => { let result;
    await tools.run({ sessionId: 's', projectRoot: env.root, messages: [{ role: 'user', content: 'test' }],
      adapter: { async stream(_messages, options) { result = await options.executeTool({ id: 'call', name, arguments: JSON.stringify(args) }); return { text: '', toolCalls: [] }; } } });
    return result;
  };
  return { ...env, tools, call };
}
const deadline = (promise) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation did not settle promptly')), 500); })]).finally(() => clearTimeout(timer)); };

test('approval binds the canonical target before and during approval, even with identical bytes', async (t) => {
  for (const timing of ['before', 'during']) await t.test(timing, async (t) => {
    const env = await fixture(t, { 'safe.txt': 'old\n', '.env': 'old\n' });
    await symlink('safe.txt', join(env.root, 'alias.txt')); const batch = await prepare(env, [replace('alias.txt')]);
    const swap = async () => { await rm(join(env.root, 'alias.txt')); await symlink('.env', join(env.root, 'alias.txt')); };
    if (timing === 'before') await swap();
    await assert.rejects(apply(env, batch, { authorize: async () => { if (timing === 'during') await swap(); } }), /canonical|target changed|stale/i);
    for (const path of ['safe.txt', '.env']) assert.equal(await readFile(join(env.root, path), 'utf8'), 'old\n');
    assert.equal((await env.journal.status('s')).available, false);
  });
});
test('new files and secondary aliases cannot change their destination during approval', async (t) => {
  for (const creating of [true, false]) await t.test(String(creating), async (t) => {
    const env = await fixture(t, { 'safe/a.txt': 'old\n', 'other/a.txt': 'old\n' }); await symlink('safe', join(env.root, 'alias'));
    const batch = await prepare(env, creating ? [{ op: 'create_file', path: 'alias/new.txt', content: 'new' }]
      : [replace('safe/a.txt', 'old', 'NEW'), replace('alias/a.txt', '\n', '!\n')]);
    await assert.rejects(apply(env, batch, { authorize: async () => { await rm(join(env.root, 'alias')); await symlink('other', join(env.root, 'alias')); } }), /canonical|target changed|stale/i);
    if (creating) for (const dir of ['safe', 'other']) await assert.rejects(stat(join(env.root, dir, 'new.txt')), { code: 'ENOENT' });
    else assert.equal(await readFile(join(env.root, 'safe/a.txt'), 'utf8'), 'old\n');
  });
});
test('undo uses the original canonical file after an alias is retargeted', async (t) => {
  const env = await fixture(t, { 'safe.txt': 'old\n', 'other.txt': 'new\n' }); await symlink('safe.txt', join(env.root, 'alias.txt'));
  await apply(env, await prepare(env, [replace('alias.txt')]));
  await rm(join(env.root, 'alias.txt')); await symlink('other.txt', join(env.root, 'alias.txt'));
  await env.journal.undoLatest({ sessionId: 's', projectRoot: env.root });
  assert.equal(await readFile(join(env.root, 'safe.txt'), 'utf8'), 'old\n'); assert.equal(await readFile(join(env.root, 'other.txt'), 'utf8'), 'new\n');
});
test('Stop cancels a queued batch promptly and leaves the writer usable', { timeout: 5000 }, async (t) => {
  const env = await fixture(t, { 'a.txt': 'old\n' }); const batch = await prepare(env, [replace('a.txt')]);
  const entered = gate(); const release = gate(); const holder = env.writer.withProject(env.root, () => { entered.resolve(); return release.promise; }); await entered.promise;
  const controller = new AbortController(); let asked = false;
  const pending = apply(env, batch, { signal: controller.signal, authorize: async () => { asked = true; } });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort();
  try { await deadline(rejected); } finally { release.resolve(); await holder; await pending.catch(() => {}); }
  assert.equal(asked, false); assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
  await apply(env, batch); assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'new\n');
});
test('Stop works without a writer and during an uncooperative approval', { timeout: 5000 }, async (t) => {
  const env = await fixture(t, { 'a.txt': 'old\n' }); env.batches = new TstBatchEditManager({ tst: env.tst, journal: env.journal });
  const batch = await prepare(env, [replace('a.txt')]); const stopped = new AbortController(); stopped.abort();
  await assert.rejects(apply(env, batch, { signal: stopped.signal }), { name: 'AbortError' });
  const entered = gate(); const release = gate(); const controller = new AbortController();
  const pending = apply(env, batch, { signal: controller.signal, authorize: () => { entered.resolve(); return release.promise; } });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort();
  try { await deadline(rejected); } finally { release.resolve(); await pending.catch(() => {}); }
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
});
test('cancellation and retargeting during journal preparation cannot publish', async (t) => {
  for (const cancel of [true, false]) await t.test(String(cancel), async (t) => {
    const env = await fixture(t, { 'safe.txt': 'old\n', 'other.txt': 'old\n' }); await symlink('safe.txt', join(env.root, 'alias.txt'));
    const controller = new AbortController(); const begin = env.journal.beginBatch.bind(env.journal);
    env.journal.beginBatch = async (input) => { const token = await begin(input); if (cancel) controller.abort();
      else { await rm(join(env.root, 'alias.txt')); await symlink('other.txt', join(env.root, 'alias.txt')); } return token; };
    await assert.rejects(apply(env, await prepare(env, [replace('alias.txt')]), { signal: controller.signal }), /stopped|abort|canonical|target changed|stale/i);
    for (const path of ['safe.txt', 'other.txt']) assert.equal(await readFile(join(env.root, path), 'utf8'), 'old\n');
    assert.equal((await env.journal.status('s')).available, false);
  });
});
test('text/create operations ignore unrelated graph failures; structural operations retain the barrier', async (t) => {
  const env = await fixture(t, { 'a.txt': 'old\n' }); await env.journal.recordBarrier({ sessionId: 's', projectRoot: env.root, paths: ['a.txt'] });
  env.tst.refreshGraphPaths = async () => { throw new Error('graph offline'); };
  await apply(env, await prepare(env, [replace('a.txt'), { op: 'create_file', path: 'new.txt', content: 'ok' }]));
  const target = { target_id: 'tst:test', path: 'a.txt', symbol: 'new', kind: 'text', base_hash: hash('new\n'), start_byte: 0, end_byte: 3, expected_source: 'new' };
  await assert.rejects(prepare(env, [{ op: 'replace_node', target, content: 'next' }]), /graph offline/);
});
test('directory invalidations refresh current and deleted indexed children in bounded requests', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`src/f${i}.txt`, 'old\n'])); const env = await fixture(t, files);
  await env.journal.recordBarrier({ sessionId: 's', projectRoot: env.root, paths: ['src'] });
  const refreshed = []; const refresh = env.tst.refreshGraphPaths.bind(env.tst);
  env.tst.graphList = async () => ({ paths: [...Object.keys(files), 'src/deleted.txt'], total: 71 });
  env.tst.refreshGraphPaths = async (paths) => { assert.ok(paths.length <= 64); refreshed.push(...paths); return refresh(paths); };
  const result = await env.batches.ensureGraphFresh(env.root); assert.equal(result.ready, true, result.reason);
  for (const path of [...Object.keys(files), 'src/deleted.txt']) assert.ok(refreshed.includes(path), path);
  assert.deepEqual(await env.journal.graphInvalidations(env.root), []);
});
test('global memory mutations serialize across project handles and aliases of a new store', async (t) => {
  const env = await fixture(t); await symlink(env.dir, join(env.dir, 'alias'));
  const a = new WorkspaceTstHandle({ projectRoot: env.root, globalStore: join(env.dir, 'shared') });
  const b = new WorkspaceTstHandle({ projectRoot: env.dir, globalStore: join(env.dir, 'alias/shared') });
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).rememberMemory('s', { key: `k${i}`, value: `v${i}`, scope: 'global' })));
  assert.equal(new Set(JSON.parse(await readFile(join(env.dir, 'shared/memory.json'), 'utf8')).map((r) => r.key)).size, 24);
  await Promise.all([a.forgetMemory('s', 'k0'), b.rememberMemory('s', { key: 'last', value: 'last', scope: 'global' })]);
  const after = await b.queryMemory('s', '', 40); assert.equal(after.length, 24); assert.ok(after.some((r) => r.key === 'last')); assert.ok(!after.some((r) => r.key === 'k0'));
  await a.clearMemory('s', 'global'); await b.rememberMemory('s', { key: 'after-clear', value: 'kept', scope: 'global' });
  assert.deepEqual((await a.queryMemory('s', '')).map((r) => r.key), ['after-clear']);
});
test('memory storage errors propagate and corrupt data is preserved', async (t) => {
  const env = await fixture(t); const store = join(env.dir, 'store'); await writeFile(store, 'not a directory');
  const broken = new WorkspaceTstHandle({ projectRoot: env.root, projectStore: store });
  await assert.rejects(broken.rememberMemory('s', { key: 'k', value: 'v' }), /ENOTDIR|EEXIST/); await assert.rejects(broken.clearMemory('s', 'project'), /ENOTDIR|EEXIST/);
  await assert.rejects(new WorkspaceTstHandle({ projectRoot: env.root }).rememberMemory('s', { key: 'k', value: 'v', scope: 'global' }), /store|configured/i);
  await rm(store); await mkdir(store); await writeFile(join(store, 'memory.json'), '{"wrong":"shape"}');
  await broken.rememberMemory('s', { key: 'recovered', value: 'yes' });
  const backup = (await readdir(store)).find((p) => p.startsWith('memory.json.corrupt-')); assert.ok(backup);
  assert.equal(await readFile(join(store, backup), 'utf8'), '{"wrong":"shape"}');
  await rm(join(store, 'memory.json')); await mkdir(join(store, 'memory.json'));
  await assert.rejects(broken.rememberMemory('s', { key: 'fail', value: 'no' }), /EISDIR/);
});
test('large previews preserve all 32 headers and respect the UTF-8 byte budget', () => {
  const files = Array.from({ length: 32 }, (_, i) => ({ path: `f${i}.txt`, exists: true, before: Buffer.from('old\n'), after: Buffer.from('🙂'.repeat(30000) + '\n') }));
  const diff = renderBatchDiff(files); assert.ok(Buffer.byteLength(diff) <= 96 * 1024);
  for (const file of files) assert.ok(diff.includes(`+++ b/${file.path}\n`), file.path); assert.ok(!diff.includes('\ufffd'));
});
test('full staged diffs are readable across pages and apply with git, including long lines and hunks past line 400', async (t) => {
  const before = Array.from({ length: 600 }, (_, i) => `old ${i}\n`).join('');
  const after = '🙂'.repeat(30000) + '\n' + Array.from({ length: 600 }, (_, i) => `new ${i}\n`).join('');
  const env = await runtimeFixture(t, { 'large.txt': before });
  const prepared = await env.call('tst_edit_batch', { action: 'prepare', operations: [replace('large.txt', before, after)] });
  assert.equal(prepared.success, true, prepared.output); const batch_id = prepared.output.match(/batch_id: (\S+)/)[1];
  let offset = 0; const chunks = [];
  for (;;) {
    const page = await env.call('tst_edit_batch', { action: 'diff', batch_id, path: 'large.txt', offset, max_bytes: 4096 });
    assert.equal(page.success, true, page.output); chunks.push(page.output.match(/\n\n([\s\S]*)$/)?.[1] ?? '');
    const next = page.output.match(/next_offset: (\d+|null)/)?.[1]; assert.ok(next !== undefined, page.output);
    if (next === 'null') break; assert.ok(Number(next) > offset); offset = Number(next);
  }
  const diff = chunks.join(''); assert.ok(!diff.includes('\ufffd')); assert.ok(diff.includes('+new 599\n'));
  execFileSync('git', ['init', '-q'], { cwd: env.root }); await writeFile(join(env.root, 'review.diff'), diff);
  execFileSync('git', ['apply', '--check', 'review.diff'], { cwd: env.root });
  assert.equal(await readFile(join(env.root, 'large.txt'), 'utf8'), before);
  assert.equal((await env.call('tst_edit_batch', { action: 'diff', batch_id, path: 'other.txt' })).success, false);
});
test('literal search, listing pagination, and optional targets are advertised and usable', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`src/${String(i).padStart(3, '0')}-${'long'.repeat(10)}.txt`, 'needle.*\nNEEDLE.*\n']));
  const env = await runtimeFixture(t, files);
  const schema = env.tools.definitions({ projectRoot: env.root }).find((d) => d.function.name === 'tst_explore').function.parameters.properties;
  for (const key of ['search_mode', 'offset', 'include_targets']) assert.ok(schema[key], key);
  let offset = 0; const seen = [];
  for (;;) {
    const result = await env.call('tst_explore', { mode: 'tree', prefix: 'src', limit: 80, offset }); assert.equal(result.success, true, result.output);
    seen.push(...[...result.output.matchAll(/^- (src\/[^\n]+)$/gm)].map((m) => m[1]));
    const next = result.output.match(/next_offset: (\d+|null)/)?.[1]; assert.ok(next !== undefined);
    if (next === 'null') break; assert.ok(Number(next) > offset); offset = Number(next);
  }
  assert.deepEqual(seen, Object.keys(files).sort());
  const matches = await env.call('tst_explore', { mode: 'search', search_mode: 'text', query: 'needle.*', prefix: 'src', limit: 2, include_targets: false });
  assert.equal(matches.success, true, matches.output); assert.match(matches.output, /:1:1/); assert.doesNotMatch(matches.output, /:2:1|REVISION-BOUND/);
  const second = await env.call('tst_explore', { mode: 'search', search_mode: 'text', query: 'needle.*', prefix: 'src', limit: 2, offset: 2 });
  assert.equal(second.success, true); assert.doesNotMatch(second.output, /already returned/);
  assert.match((await env.call('tst_explore', { mode: 'search', search_mode: 'text', query: 'needle.+', prefix: 'src' })).output, /0 matches/);
  assert.doesNotMatch((await env.call('tst_explore', { mode: 'search', search_mode: 'text', query: 'needle', prefix: '..' })).output, /src\//);
});
test('exact symbol search filters fuzzy matches and targets are optional', async (t) => {
  const env = await runtimeFixture(t, { 'src/a.js': 'function work() {}\nfunction workMore() {}\n' }); let resolved = 0;
  env.tst.resolveEditTargets = async () => { resolved++; return { matches: [
    { target_id: 'tst:work', path: 'src/a.js', symbol: 'work', kind: 'function_declaration', base_hash: hash(await readFile(join(env.root, 'src/a.js'))),
      start_byte: 0, end_byte: 18, start_row: 0, start_column: 0, end_row: 0, end_column: 18, expected_source: 'function work() {}' }, { symbol: 'workMore', kind: 'function_declaration' },
  ] }; };
  const plain = await env.call('tst_explore', { mode: 'search', search_mode: 'exact_symbol', query: 'work', prefix: 'src', include_targets: false });
  assert.equal(plain.success, true, plain.output); assert.match(plain.output, /function_declaration work/); assert.doesNotMatch(plain.output, /workMore|REVISION-BOUND/); assert.ok(resolved > 0);
  const targets = await env.call('tst_explore', { mode: 'search', search_mode: 'exact_symbol', query: 'work', prefix: 'src', include_targets: true });
  assert.equal(targets.success, true); assert.match(targets.output, /REVISION-BOUND EDIT TARGETS/);
});
test('close during initialization cannot install a late client or clobber a new connection', { timeout: 5000 }, async (t) => {
  const env = await fixture(t); const socketPath = join(env.dir, 's.sock'); const sockets = new Set(); const initializations = []; const first = gate();
  const reply = (socket, id, result) => { if (socket.destroyed) return; const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header, body])); };
  const server = createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(); if (buffer.length < size + 4) return; const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
      if (request.method === 'initialize') { initializations.push({ socket, request }); if (initializations.length === 1) first.resolve(); else reply(socket, request.id, { protocol: 'cuppet.tst.v3', capabilities: ['graph.list'] }); }
      else reply(socket, request.id, { ok: true });
    } });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve)); const bridge = new TstBridge({ socketPath, token: 'token', connectTimeoutMs: 1000 });
  t.after(async () => { bridge.close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const old = bridge.call('graph.list'); const oldFailure = assert.rejects(old, /closed|abort|cancel/i); await first.promise; bridge.close();
  const fresh = bridge.call('graph.list'); const pending = initializations[0]; reply(pending.socket, pending.request.id, { protocol: 'cuppet.tst.v3', capabilities: [] });
  await oldFailure; assert.deepEqual(await fresh, { ok: true }); assert.equal(bridge.status.connected, true);
  assert.deepEqual(await bridge.call('graph.list'), { ok: true }); assert.equal(initializations.length, 2); bridge.close(); assert.equal(bridge.status.connected, false);
});

test('diff review validates ownership, UTF-8 boundaries, EOF, and expiration without changing the workspace', async (t) => {
  const env = await fixture(t, { 'a.txt': 'old\n' }); const batch = await prepare(env, [replace('a.txt', 'old', '🙂'.repeat(1000))]);
  const review = (args = {}) => env.batches.review({ batchId: batch.id, sessionId: 's', projectRoot: env.root, ...args });
  const first = await review({ maxBytes: 1024 }); assert.ok(Buffer.byteLength(first.diff) <= 1024); assert.ok(first.nextOffset > 0);
  const whole = await review({ maxBytes: 65536 }); const bytes = Buffer.from(whole.diff); const emoji = bytes.indexOf(Buffer.from('🙂'));
  await assert.rejects(review({ offset: emoji + 1 }), /UTF-8/);
  for (const offset of [-1, 0.5, bytes.length + 1]) await assert.rejects(review({ offset }), /offset/);
  const eof = await review({ offset: bytes.length }); assert.equal(eof.diff, ''); assert.equal(eof.nextOffset, null);
  await assert.rejects(review({ sessionId: 'other' }), /different session/);
  await assert.rejects(review({ projectRoot: env.dir }), /different project/);
  const now = Date.now; const future = now() + 31 * 60 * 1000;
  try { Date.now = () => future; await assert.rejects(review(), /expired/); assert.equal(env.batches.get(batch.id), null); }
  finally { Date.now = now; }
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
});

test('one batch cannot publish twice while its first approval has released the writer lock', async (t) => {
  const env = await fixture(t, { 'a.txt': 'old\n' }); const events = [];
  env.batches = new TstBatchEditManager({ tst: env.tst, journal: env.journal, writer: env.writer, emit: (event) => events.push(event) });
  const batch = await prepare(env, [replace('a.txt')]); const entered = gate(); const release = gate();
  const first = apply(env, batch, { authorize: () => { entered.resolve(); return release.promise; } });
  const rejected = assert.rejects(first, /not prepared/); await entered.promise;
  try { await apply(env, batch); } finally { release.resolve(); }
  await rejected; assert.equal(events.filter((e) => e.type === 'edit.batch.applied').length, 1);
});

test('publish failures roll back safely and preserve external edits for durable recovery', async (t) => {
  for (const external of [false, true]) await t.test(String(external), async (t) => {
    const env = await fixture(t, { 'a.txt': 'old\n', 'b.txt': 'old\n' });
    env.journal.commitBatch = async () => {
      if (external) await writeFile(join(env.root, 'a.txt'), 'external\n');
      throw new Error('disk failure');
    };
    await assert.rejects(apply(env, await prepare(env, [replace('a.txt'), replace('b.txt')])), /disk failure/);
    assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), external ? 'external\n' : 'old\n');
    assert.equal(await readFile(join(env.root, 'b.txt'), 'utf8'), 'old\n');
    const recovered = await new MutationJournal(join(env.dir, 'journal')).ready();
    assert.equal(recovered.conflicts.length > 0, external, 'unsafe rollback keeps a recoverable intent');
  });
});

test('post-apply graph refresh covers canonical files and every alias across the 64-path RPC limit', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`real/f${i}.txt`, 'old\n']));
  const env = await fixture(t, files); const operations = [];
  for (let i = 0; i < 22; i++) {
    await symlink(`real/f${i}.txt`, join(env.root, `a${i}.txt`));
    await symlink(`real/f${i}.txt`, join(env.root, `b${i}.txt`));
    operations.push(replace(`a${i}.txt`, 'old', 'new'), replace(`b${i}.txt`, '\n', '!\n'));
  }
  const refresh = env.tst.refreshGraphPaths.bind(env.tst); const paths = [];
  env.tst.refreshGraphPaths = async (requested) => { assert.ok(requested.length <= 64); paths.push(...requested); return refresh(requested); };
  const applied = await apply(env, await prepare(env, operations)); assert.equal(applied.graphReady, true, applied.graphError);
  assert.equal(new Set(paths).size, 66); assert.deepEqual(await env.journal.graphInvalidations(env.root), []);
});

test('an incomplete directory refresh never clears the structural barrier', async (t) => {
  const env = await fixture(t, { 'src/a.txt': 'old\n' }); await env.journal.recordBarrier({ sessionId: 's', projectRoot: env.root, paths: ['src'] });
  env.tst.graphList = async () => ({ paths: ['src/a.txt'], total: 1000 });
  const result = await env.batches.ensureGraphFresh(env.root);
  assert.equal(result.ready, false); assert.match(result.reason, /Incomplete/);
  assert.deepEqual(await env.journal.graphInvalidations(env.root), ['src']);
  assert.equal((await prepare(env, [replace('src/a.txt')])).state, 'prepared');
});

test('memory rename failures clean temporary files and never report a successful clear', async (t) => {
  const env = await fixture(t); const store = join(env.dir, 'memory'); await mkdir(join(store, 'memory.json'), { recursive: true });
  const handle = new WorkspaceTstHandle({ projectRoot: env.root, projectStore: store });
  await assert.rejects(handle.clearMemory('s', 'project'), /EISDIR|ENOTEMPTY|EEXIST/);
  assert.deepEqual(await readdir(store), ['memory.json']);
});

test('literal search respects read permissions for sensitive files and symlink targets', async (t) => {
  const env = await runtimeFixture(t, { '.env': 'TOKEN=needle-SECRET\n', 'src/a.js': 'needle\n' }, { permissions: new PermissionBroker({ interactive: false }) });
  await symlink('.env', join(env.root, 'alias.txt'));
  for (const prefix of ['.env', 'alias.txt']) {
    const result = await env.call('tst_explore', { mode: 'search', search_mode: 'text', prefix, query: 'needle' });
    assert.equal(result.success, false); assert.match(result.output, /Permission denied/); assert.doesNotMatch(result.output, /needle-SECRET/);
  }
  const safe = await env.call('tst_explore', { mode: 'search', search_mode: 'text', prefix: 'src', query: 'needle' });
  assert.equal(safe.success, true); assert.match(safe.output, /src\/a.js:1:1/);
});

test('listing pagination reaches files beyond an older daemon limit without skips or duplicates', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 620 }, (_, i) => [`src/f${String(i).padStart(4, '0')}.txt`, 'needle\n']));
  const env = await runtimeFixture(t, files);
  env.tst.graphList = async (prefix) => ({ prefix, paths: Object.keys(files).slice(0, 512), total: 620 });
  const seen = []; let offset = 0;
  for (;;) {
    const result = await env.call('tst_explore', { mode: 'tree', prefix: 'src', limit: 100, offset });
    assert.equal(result.success, true, result.output);
    const paths = [...result.output.matchAll(/^- (src\/[^\n]+)$/gm)].map((m) => m[1]);
    assert.deepEqual(result.paths, paths); seen.push(...paths);
    const next = result.output.match(/next_offset: (\d+|null)/)?.[1]; assert.ok(next !== undefined);
    if (next === 'null') break; assert.ok(Number(next) > offset); offset = Number(next);
  }
  assert.deepEqual(seen, Object.keys(files));
  const empty = await env.call('tst_explore', { mode: 'tree', prefix: 'src', offset: 620 });
  assert.match(empty.output, /next_offset: null/); assert.deepEqual(empty.paths, []);
  const invalid = await env.call('tst_explore', { mode: 'tree', prefix: 'src', offset: -1 }); assert.equal(invalid.success, false);
});

test('text and exact search handle case, binary files, unsupported parsers, and empty pages honestly', async (t) => {
  const env = await runtimeFixture(t, { 'src/a.js': 'π needle\r\nconst NEEDLE = 1;\r\n', 'src/b.bin': 'needle', 'src/c.txt': 'needle\0binary' });
  const insensitive = await env.call('tst_explore', { mode: 'search', search_mode: 'text', prefix: 'src', query: 'needle', case_sensitive: false, limit: 1, offset: 1 });
  assert.equal(insensitive.success, true); assert.match(insensitive.output, /src\/a.js:2:7/); assert.match(insensitive.output, /next_offset: null/);
  assert.doesNotMatch(insensitive.output, /src\/(b|c)/);
  const unsupported = await env.call('tst_explore', { mode: 'search', search_mode: 'exact_symbol', prefix: 'src', query: 'NEEDLE' });
  assert.equal(unsupported.success, false); assert.match(unsupported.output, /does not support revision-bound/);
  const empty = await env.call('tst_explore', { mode: 'search', search_mode: 'text', prefix: 'src', query: 'needle', offset: 20 });
  assert.match(empty.output, /0 matches/); assert.match(empty.output, /next_offset: null/);
  assert.equal((await env.call('tst_explore', { mode: 'search', search_mode: 'text', query: 'a\nb' })).success, false);
});

test('native TST exact-symbol search and paginated listings work through the full tool runtime', { timeout: 30000 }, async (t) => {
  const env = await fixture(t, { 'src/a.js': 'export function work() { return 1; }\nexport function workMore() { return 2; }\n', 'src/b.js': 'export const b = 1;\n' });
  const manager = new RuntimeTstManager({ dataDir: join(env.dir, 'native'), externalSocket: null, externalToken: null, idleMs: 0 });
  if (manager.status.mode !== 'managed-native') { await manager.close(); t.skip('native TST binary is not installed'); return; }
  try {
    const native = await manager.forProject('native', env.root);
    // The handle is bound to env.root; the tool runtime uses that same workspace.
    const db = new ConversationDatabase(join(env.dir, 'native-db.sqlite3'));
    db.createProject({ id: 'p', name: 'P', canonicalPath: env.root }); db.createSession({ id: 's', projectId: 'p' });
    try {
      const tools = new ToolRuntime({ tst: native, batchEdits: env.batches, db, planStore: {}, permissions: { authorize: async () => ({ allowed: true }), autoStatus: () => ({}) } });
      let result;
      await tools.run({ sessionId: 's', projectRoot: env.root, messages: [{ role: 'user', content: 'find work' }],
        adapter: { async stream(_messages, options) { result = await options.executeTool({ id: 'native', name: 'tst_explore', arguments: JSON.stringify({ mode: 'search', search_mode: 'exact_symbol', query: 'work', prefix: 'src', include_targets: true }) }); return { text: '', toolCalls: [] }; } } });
      assert.equal(result.success, true, result.output); assert.match(result.output, /function_declaration work/);
      assert.doesNotMatch(result.output.split('REVISION-BOUND')[0], /workMore/); assert.match(result.output, /"symbol": "work"/);
      const pages = [];
      await tools.run({ sessionId: 's', projectRoot: env.root, messages: [{ role: 'user', content: 'list files' }],
        adapter: { async stream(_messages, options) {
          for (const offset of [0, 1]) pages.push(await options.executeTool({ id: `page-${offset}`, name: 'tst_explore', arguments: JSON.stringify({ mode: 'tree', prefix: 'src', limit: 1, offset }) }));
          return { text: '', toolCalls: [] };
        } } });
      assert.equal(pages[0].success, true, pages[0].output); assert.match(pages[0].output, /next_offset: 1/);
      assert.deepEqual(pages.flatMap((page) => page.paths), ['src/a.js', 'src/b.js']);
      assert.match(pages[1].output, /next_offset: null/);
      const nativeBatches = new TstBatchEditManager({ tst: native, journal: env.journal, writer: env.writer });
      await env.journal.recordBarrier({ sessionId: 's', projectRoot: env.root, paths: ['src'] });
      const fresh = await nativeBatches.ensureGraphFresh(env.root);
      assert.equal(fresh.ready, true, fresh.reason);
      assert.deepEqual(await env.journal.graphInvalidations(env.root), []);
    } finally { db.close(); }
  } finally { await manager.close(); }
});
