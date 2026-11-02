import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManagedTstBinary } from '../src/runtime/tst-supervisor.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';
import { WorkspaceTstHandle } from '../src/runtime/workspace-tst-handle.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';
import { ContextCompiler } from '../src/runtime/context-compiler.mjs';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';

const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, native = false) {
  const dir = await mkdtemp(join(tmpdir(), 'tst-navigation-')); const root = join(dir, 'p'); await mkdir(root);
  const manager = native ? new RuntimeTstManager({ dataDir: join(dir, 'managed'), binaryPath: resolveManagedTstBinary(), externalSocket: null, externalToken: null }) : null;
  const tst = manager ? await manager.forProject('p', root) : new WorkspaceTstHandle({ projectRoot: root });
  const tools = new ToolRuntime({ tst, planStore: {}, dataDir: join(dir, 'data'),
    db: { createToolExecution() {}, finishToolExecution() {} }, permissions: { authorize: async () => ({ allowed: true }), autoStatus: () => ({}) } });
  t.after(async () => { await tools.close(); await (manager ?? tst).close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (args, signal) => { let result;
    await tools.run({ projectId: 'p', projectRoot: root, sessionId: 's', messages: [], signal,
      adapter: { async stream(_messages, { executeTool }) { result = await executeTool({ id: 'call', name: 'tst_explore', arguments: JSON.stringify(args) }); return { toolCalls: [] }; } } });
    return result;
  };
  return { dir, root, tst, tools, call };
}
test('external edits, additions, deletions, and Git switches invalidate navigation deduplication immediately', async (t) => {
  const { root, call } = await fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'TST test'); git('config', 'user.email', 'test@example.invalid');
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.txt'), 'needle original');
  git('add', '.'); git('commit', '-qm', 'initial'); git('branch', 'before');
  const args = { mode: 'search', search_mode: 'text', prefix: 'src', query: 'needle' };
  assert.match((await call(args)).output, /needle original/);
  assert.match((await call(args)).output, /already returned/);
  await writeFile(join(root, 'src/a.txt'), 'needle changed');
  assert.match((await call(args)).output, /needle changed/);
  await writeFile(join(root, 'src/b.txt'), 'needle added');
  assert.match((await call(args)).output, /b.txt/);
  await rm(join(root, 'src/a.txt'));
  assert.doesNotMatch((await call(args)).output, /a.txt|already returned/);
  git('add', '.'); git('commit', '-qm', 'changed'); git('checkout', '-q', 'before');
  const switched = await call(args); assert.match(switched.output, /needle original/); assert.doesNotMatch(switched.output, /b.txt|already returned/);
});
test('Stop cancels context preparation and staged parsing without caching or preparing a batch', { timeout: 3000 }, async (t) => {
  const { dir, root } = await fixture(t); const entered = gate(); let observedSignal;
  const compiler = new ContextCompiler({ tst: { configured: true, prepareContext: async (...args) => { observedSignal = args.at(-1).signal; entered.resolve(); return new Promise(() => {}); } }, cognitiveState: { mode: () => 'build', snapshot: () => ({}) } });
  const controller = new AbortController();
  const pending = compiler.compile({ sessionId: 's', userMessageId: 'u', messages: [{ role: 'user', content: 'parser' }], signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await entered.promise; controller.abort(); await rejected;
  assert.equal(observedSignal, controller.signal);
  await writeFile(join(root, 'a.js'), 'const a = 1;'); const parsing = gate(); const controller2 = new AbortController();
  const journal = new MutationJournal(join(dir, 'journal')); await journal.ready();
  const batches = new TstBatchEditManager({ journal, tst: { configured: true, parseStaged: async (_path, _hash, _text, options) => { assert.equal(options.signal, controller2.signal); parsing.resolve(); return new Promise(() => {}); } } });
  const prepare = batches.prepare({ sessionId: 's', projectRoot: root, signal: controller2.signal, operations: [{ op: 'replace_text', path: 'a.js', old_text: '1', new_text: '2' }] });
  const noBatch = assert.rejects(prepare, { name: 'AbortError' }); await parsing.promise; controller2.abort(); await noBatch;
  assert.equal(await readFile(join(root, 'a.js'), 'utf8'), 'const a = 1;');
});
test('native search resumes after the last visible match when tool output is shorter than an RPC page', { timeout: 20000 }, async (t) => {
  if (!resolveManagedTstBinary()) return t.skip('Native TST is not bundled on this platform');
  const { root, tst, call } = await fixture(t, true);
  assert.equal(await tst.supports('graph.search_page'), true, 'bundled native TST must implement indexed pagination');
  for (let i = 0; i < 40; i++) await writeFile(join(root, 'f' + String(i).padStart(2, '0') + '.txt'), 'needle ' + 'x'.repeat(480));
  let cursor; const paths = [];
  do {
    const result = await call({ mode: 'search', search_mode: 'text', query: 'needle', limit: 40, ...(cursor ? { cursor } : {}) });
    assert.equal(result.success, true, result.output); assert.ok(Buffer.byteLength(result.output) < 5000);
    paths.push(...[...result.output.matchAll(/^- (f\d+\.txt):/gm)].map((match) => match[1]));
    cursor = result.output.match(/^next_cursor: (\S+)$/m)?.[1];
  } while (cursor);
  assert.equal(paths.length, 40); assert.equal(new Set(paths).size, 40);
  assert.deepEqual(paths, Array.from({ length: 40 }, (_, i) => 'f' + String(i).padStart(2, '0') + '.txt'));
});
test('native search cursors reject changed workspaces, changed queries, and malformed inputs through the bridge', { timeout: 20000 }, async (t) => {
  if (!resolveManagedTstBinary()) return t.skip('Native TST is not bundled on this platform');
  const { root, tst } = await fixture(t, true);
  await writeFile(join(root, 'a.js'), 'function work() {}\nfunction work() {}\nfunction workMore() {}\n');
  const input = { query: 'work', search_mode: 'exact_symbol', limit: 1 };
  const first = await tst.call('graph.search_page', input); assert.equal(first.total, 2);
  await assert.rejects(tst.call('graph.search_page', { ...input, query: 'other', cursor: first.next_cursor }), /different query/);
  await assert.rejects(tst.call('graph.search_page', { ...input, cursor: 'broken' }), /invalid search cursor/);
  await writeFile(join(root, 'a.js'), 'function changed() {}\n');
  await assert.rejects(tst.call('graph.search_page', { ...input, cursor: first.next_cursor }), /stale search cursor/);
  assert.equal((await tst.call('graph.search_page', input)).total, 0);
});
