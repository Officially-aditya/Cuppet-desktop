import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';

const hash = (content) => createHash('sha256').update(content).digest('hex');
async function fixture(t, files = { 'a.txt': 'old\n' }) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-edit-failures-'));
  const project = join(dir, 'project'); await mkdir(project); const root = await realpath(project);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const journal = new MutationJournal(join(dir, 'journal')); await journal.ready();
  const writer = new ProjectWriter();
  const tst = {
    configured: true,
    async parseStaged() { return { supported: false }; },
    async refreshGraphPaths(paths) {
      return { paths: await Promise.all(paths.map(async (path) => ({ path, content_hash: hash(await readFile(join(root, path))) }))) };
    },
  };
  const batches = new TstBatchEditManager({ tst, journal, writer });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, journal, writer, tst, batches };
}
const replace = (extra = {}) => ({ op: 'replace_text', path: 'a.txt', old_text: 'old', new_text: 'new', ...extra });
const prepare = (env, operations = [replace()]) => env.batches.prepare({ sessionId: 's', projectRoot: env.root, operations });
const apply = (env, batch, extra = {}) => env.batches.apply({ batchId: batch.id, sessionId: 's', projectRoot: env.root,
  executionId: 'e', authorize: async () => ({ allowed: true }), ...extra });

test('missing or non-string replacement content fails before any file is written', async (t) => {
  const target = { target_id: 'tst:content', path: 'a.txt', symbol: 'old', kind: 'text',
    base_hash: hash('old\n'), start_byte: 0, end_byte: 3, expected_source: 'old' };
  const cases = [
    { op: 'replace_text', path: 'a.txt', old_text: 'old' },
    ...[null, 0, false, {}].map((new_text) => replace({ new_text })),
    replace({ old_text: 0 }),
    { op: 'create_file', path: 'new.txt' },
    { op: 'create_file', path: 'new.txt', content: 42 },
    ...['replace_node', 'insert_before_node', 'insert_after_node'].map((op) => ({ op, target })),
  ];
  for (const [index, operation] of cases.entries()) await t.test(String(index), async (t) => {
    const env = await fixture(t);
    await assert.rejects(prepare(env, [operation]), /required|explicit|string/i);
    assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
    await assert.rejects(stat(join(env.root, 'new.txt')), { code: 'ENOENT' });
    assert.equal((await env.journal.status('s')).available, false);
  });
});

test('explicit empty strings and supported aliases remain valid', async (t) => {
  const env = await fixture(t);
  await apply(env, await prepare(env, [
    { op: 'replace_text', file: 'a.txt', oldText: 'old', newText: '' },
    { op: 'create_file', filePath: 'empty.txt', text: '' },
  ]));
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), '\n');
  assert.equal(await readFile(join(env.root, 'empty.txt'), 'utf8'), '');
  const target = { target_id: 'tst:empty', path: 'a.txt', symbol: 'newline', kind: 'text',
    base_hash: hash('\n'), start_byte: 0, end_byte: 1, expected_source: '\n' };
  await apply(env, await prepare(env, [{ op: 'delete_node', target }]));
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), '');
});

test('overlapping literal matches are ambiguous, including multibyte text', async (t) => {
  for (const [source, needle, count] of [['aaa', 'aa', 2], ['aaaa', 'aa', 3], ['🙂🙂🙂', '🙂🙂', 2]]) {
    await t.test(source, async (t) => {
      const env = await fixture(t, { 'a.txt': source });
      await assert.rejects(prepare(env, [replace({ old_text: needle })]), new RegExp('matched ' + count + ' times'));
      assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), source);
    });
  }
});

test('a unique literal may contain repeated bytes and replacement metacharacters', async (t) => {
  const env = await fixture(t, { 'a.txt': 'prefix aaaa suffix' });
  await apply(env, await prepare(env, [replace({ old_text: 'aaaa', new_text: '$& $1 ` \\' })]));
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'prefix $& $1 ` \\ suffix');
});

test('same bytes in a different inode invalidate a prepared batch', async (t) => {
  const env = await fixture(t); const batch = await prepare(env);
  await writeFile(join(env.root, 'replacement.txt'), 'old\n');
  await rename(join(env.root, 'replacement.txt'), join(env.root, 'a.txt'));
  let asked = false;
  await assert.rejects(apply(env, batch, { authorize: async () => { asked = true; } }), /stale|identity|metadata/i);
  assert.equal(asked, false);
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
  assert.equal((await env.journal.status('s')).available, false);
});

test('permission changes invalidate the whole batch at every pre-publication checkpoint', { skip: process.platform === 'win32' }, async (t) => {
  for (const timing of ['before apply', 'during approval', 'during journal']) await t.test(timing, async (t) => {
    const env = await fixture(t, { 'a.txt': 'old\n', 'b.txt': 'old\n' });
    await chmod(join(env.root, 'b.txt'), 0o644);
    const batch = await prepare(env, [replace(), replace({ path: 'b.txt' })]);
    const change = () => chmod(join(env.root, 'b.txt'), 0o755);
    if (timing === 'before apply') await change();
    if (timing === 'during journal') {
      const begin = env.journal.beginBatch.bind(env.journal);
      env.journal.beginBatch = async (input) => { const token = await begin(input); await change(); return token; };
    }
    await assert.rejects(apply(env, batch, { authorize: async () => { if (timing === 'during approval') await change(); } }), /stale|metadata|mode/i);
    for (const path of ['a.txt', 'b.txt']) assert.equal(await readFile(join(env.root, path), 'utf8'), 'old\n');
    assert.equal((await stat(join(env.root, 'b.txt'))).mode & 0o777, 0o755);
    assert.equal((await env.journal.status('s')).available, false);
  });
});

test('publication and rollback preserve existing permissions under a restrictive umask', { skip: process.platform === 'win32' }, async (t) => {
  for (const fail of [false, true]) await t.test(String(fail), async (t) => {
    const env = await fixture(t); await chmod(join(env.root, 'a.txt'), 0o754);
    const batch = await prepare(env);
    if (fail) env.journal.commitBatch = async () => { throw new Error('injected disk failure'); };
    const previous = process.umask(0o077);
    try {
      if (fail) await assert.rejects(apply(env, batch), /injected disk failure/);
      else await apply(env, batch);
    } finally { process.umask(previous); }
    assert.equal((await stat(join(env.root, 'a.txt'))).mode & 0o777, 0o754);
    assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), fail ? 'old\n' : 'new\n');
    assert.equal((await new MutationJournal(join(env.dir, 'journal')).ready()).conflicts.length, 0);
  });
});

test('a completed apply can be retried without writing or authorizing again', async (t) => {
  const env = await fixture(t); const batch = await prepare(env);
  const first = await apply(env, batch);
  const mutation = (await env.journal.status('s')).latest.id;
  await writeFile(join(env.root, 'a.txt'), 'external after commit\n');
  const retried = await apply(env, batch, { executionId: 'retry', authorize: async () => assert.fail('retry requested authorization') });
  assert.deepEqual(retried, first);
  assert.equal((await env.journal.status('s')).latest.id, mutation);
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'external after commit\n');
  await assert.rejects(apply(env, batch, { sessionId: 'other' }), /different session/);
  await assert.rejects(apply(env, batch, { projectRoot: env.dir }), /different project/);
});

test('Stop after commit still returns the successful tool result and records changed paths', async (t) => {
  const env = await fixture(t); const batch = await prepare(env); const controller = new AbortController();
  const commit = env.journal.commitBatch.bind(env.journal);
  env.journal.commitBatch = async (token) => { const result = await commit(token); controller.abort(); return result; };
  const statuses = []; const paths = [];
  const tools = new ToolRuntime({ tst: env.tst, batchEdits: env.batches, writer: env.writer, dataDir: join(env.dir, 'data'), planStore: {},
    permissions: { authorize: async () => ({ allowed: true }) },
    db: { createToolExecution() {}, finishToolExecution(_id, result) { statuses.push(result); } } });
  let result;
  await tools.run({ sessionId: 's', projectRoot: env.root, signal: controller.signal, messages: [{ role: 'user', content: 'apply' }],
    onPaths: async (...args) => paths.push(args),
    adapter: { async stream(_messages, options) {
      result = await options.executeTool({ id: 'apply', name: 'tst_edit_batch', arguments: JSON.stringify({ action: 'apply', batch_id: batch.id }) });
      return { text: '', toolCalls: [] };
    } },
  });
  assert.equal(result.success, true);
  assert.equal(result.mutation, true);
  assert.match(result.output, /TST EDIT BATCH APPLIED/);
  assert.equal(statuses.at(-1).status, 'complete');
  assert.deepEqual(paths[0].slice(0, 2), [['a.txt'], true]);
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'new\n');
  assert.equal((await env.journal.status('s')).latest.kind, 'batch');
});

test('Stop before commit rolls back the batch and allows a later retry', async (t) => {
  const env = await fixture(t); const batch = await prepare(env); const controller = new AbortController();
  const begin = env.journal.beginBatch.bind(env.journal);
  env.journal.beginBatch = async (input) => { const token = await begin(input); controller.abort(); return token; };
  await assert.rejects(apply(env, batch, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
  assert.equal((await env.journal.status('s')).available, false);
  env.journal.beginBatch = begin;
  await apply(env, batch);
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'new\n');
  assert.deepEqual((await readdir(env.root)).filter((path) => path.endsWith('.cuppet-tmp')), []);
});

function mockFs(t, name, handler) {
  const original = fs[name].bind(fs);
  t.mock.method(fs, name, (...args) => handler(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('a racing create at the publication syscall preserves the external file and rolls back earlier files', async (t) => {
  const env = await fixture(t); const target = join(env.root, 'new.txt'); let raced = false;
  const race = async (original, from, to) => {
    if (to === target && !raced) { raced = true; await writeFile(target, 'external save\n'); }
    return original(from, to);
  };
  mockFs(t, 'rename', race); mockFs(t, 'link', race);
  const batch = await prepare(env, [replace(), { op: 'create_file', path: 'new.txt', content: 'cuppet\n' }]);
  await assert.rejects(apply(env, batch), /EEXIST/);
  assert.equal(raced, true);
  assert.equal(await readFile(target, 'utf8'), 'external save\n');
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'old\n');
  assert.equal((await env.journal.status('s')).available, false);
  assert.deepEqual((await readdir(env.root)).filter((path) => path.endsWith('.cuppet-tmp')), []);
  assert.deepEqual((await new MutationJournal(join(env.dir, 'journal')).ready()).conflicts, []);
});

test('a failed second publication restores the exact bytes and permissions of earlier files', async (t) => {
  for (const failure of ['rename', 'write', 'sync']) await t.test(failure, async (t) => {
    const env = await fixture(t, { 'a.txt': 'old\n', 'b.txt': 'old\n' });
    if (process.platform !== 'win32') await chmod(join(env.root, 'a.txt'), 0o754);
    const batch = await prepare(env, [replace(), replace({ path: 'b.txt' })]);
    const error = Object.assign(new Error('injected ' + failure + ' failure'), { code: failure === 'rename' ? 'EACCES' : 'ENOSPC' });
    let injected = false; let temps = 0;
    if (failure === 'rename') {
      mockFs(t, 'rename', async (original, from, to) => {
        if (to === join(env.root, 'b.txt') && !injected) { injected = true; throw error; }
        return original(from, to);
      });
    } else {
      mockFs(t, 'open', async (original, path, ...args) => {
        const handle = await original(path, ...args);
        if (String(path).endsWith('.cuppet-tmp') && ++temps === 2) {
          t.mock.method(handle, failure === 'write' ? 'writeFile' : 'sync', async () => { injected = true; throw error; });
        }
        return handle;
      });
    }
    await assert.rejects(apply(env, batch), /injected .* failure/);
    assert.equal(injected, true);
    for (const path of ['a.txt', 'b.txt']) assert.equal(await readFile(join(env.root, path), 'utf8'), 'old\n');
    if (process.platform !== 'win32') assert.equal((await stat(join(env.root, 'a.txt'))).mode & 0o777, 0o754);
    assert.equal((await env.journal.status('s')).available, false);
    assert.deepEqual((await readdir(env.root)).filter((path) => path.endsWith('.cuppet-tmp')), []);
    assert.deepEqual((await new MutationJournal(join(env.dir, 'journal')).ready()).conflicts, []);
  });
});

test('new file permissions respect the caller umask', { skip: process.platform === 'win32' }, async (t) => {
  const env = await fixture(t);
  const batch = await prepare(env, [{ op: 'create_file', path: 'private.txt', content: 'new\n' }]);
  const previous = process.umask(0o077);
  try { await apply(env, batch); } finally { process.umask(previous); }
  assert.equal((await stat(join(env.root, 'private.txt'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(env.root, 'private.txt'), 'utf8'), 'new\n');
});

test('all structural operations preserve their byte offsets around multibyte text', async (t) => {
  const source = '🙂 OLD tail\n'; const start = Buffer.byteLength('🙂 ');
  for (const [op, content, expected] of [
    ['replace_node', '', '🙂  tail\n'],
    ['insert_before_node', 'π', '🙂 πOLD tail\n'],
    ['insert_after_node', 'π', '🙂 OLDπ tail\n'],
    ['insert_before_node', '', source],
    ['insert_after_node', '', source],
  ]) await t.test(op + ':' + content, async (t) => {
    const env = await fixture(t, { 'a.txt': source });
    const target = { target_id: 'tst:offset', path: 'a.txt', symbol: 'OLD', kind: 'text',
      base_hash: hash(source), start_byte: start, end_byte: start + 3, expected_source: 'OLD' };
    await apply(env, await prepare(env, [{ op, target, content }]));
    assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), expected);
  });
});

test('file size limits accept the exact boundary and reject oversized output without writes', async (t) => {
  const source = 'x' + ' '.repeat(1024 * 1024 - 1);
  const env = await fixture(t, { 'a.txt': source });
  await assert.rejects(prepare(env, [replace({ old_text: 'x', new_text: 'yy' })]), /staged file exceeds/);
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), source);
  await apply(env, await prepare(env, [replace({ old_text: 'x', new_text: 'y' })]));
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'y' + source.slice(1));
  await writeFile(join(env.root, 'a.txt'), source + ' ');
  await assert.rejects(prepare(env, [replace({ old_text: 'x' })]), /file exceeds/);
});

test('non-regular targets fail promptly instead of blocking on FIFO open', { skip: process.platform === 'win32', timeout: 3000 }, async (t) => {
  const env = await fixture(t);
  execFileSync('mkfifo', [join(env.root, 'pipe')]);
  await assert.rejects(prepare(env, [replace({ path: 'pipe' })]), /regular file/);
});

test('Stop during a stalled post-commit refresh returns applied state with a durable graph barrier', { timeout: 3000 }, async (t) => {
  const env = await fixture(t); const batch = await prepare(env); const controller = new AbortController();
  let releaseRefresh; let pendingRefresh; const blocked = new Promise((resolve) => { releaseRefresh = resolve; });
  const refresh = env.tst.refreshGraphPaths.bind(env.tst);
  env.tst.refreshGraphPaths = (paths, options) => {
    assert.equal(options?.signal, controller.signal);
    controller.abort();
    return pendingRefresh = blocked.then(() => refresh(paths));
  };
  let timer;
  try {
    const result = await Promise.race([apply(env, batch, { signal: controller.signal }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('post-commit Stop did not settle')), 500);
    })]);
    assert.equal(result.applied, true);
    assert.equal(result.graphReady, false);
    assert.match(result.graphError, /stopped/i);
    assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'new\n');
    assert.deepEqual(await env.journal.graphInvalidations(env.root), ['a.txt']);
    env.tst.refreshGraphPaths = refresh;
    assert.equal((await env.batches.ensureGraphFresh(env.root)).ready, true);
    assert.deepEqual(await env.journal.graphInvalidations(env.root), []);
  } finally { clearTimeout(timer); releaseRefresh(); await pendingRefresh; }
});
