import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationDatabase } from '../src/runtime/database.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';
import { TstBatchEditManager, renderBatchDiff } from '../src/runtime/tst-edit-batches.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { ToolRuntime, agentPermissionAction, parsePorcelainZ } from '../src/runtime/tool-runtime.mjs';
import { PermissionBroker, isAutoProjectBashCommand, isGitExecutionSurface, isProjectScopedResource, isSafeWorkspaceResource, isSensitivePath } from '../src/runtime/permissions.mjs';
import { ExecutionKernel } from '../src/runtime/execution/execution-kernel.mjs';
import { TstClient, TstBridge } from '../src/runtime/tst-client.mjs';
import { TstSupervisor } from '../src/runtime/tst-supervisor.mjs';
import { WorkspaceTstHandle } from '../src/runtime/workspace-tst-handle.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sandboxReady = process.platform !== 'linux' || (() => { try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** Lists the project through the filesystem so staleness we observe belongs to the runtime, not to a fake. */
function fsTst(root) {
  async function walk(dir, out) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out); else if (entry.isFile()) out.push(path.slice(root.length + 1).replaceAll('\\', '/'));
    }
    return out;
  }
  return {
    configured: true,
    async graphWorkspace() { const files = (await walk(root, [])).sort(); return { root, graph: { files: files.length, symbols: 0, edges: 0 }, files }; },
    async graphList(prefix) { const all = (await walk(root, [])).sort(); const paths = prefix ? all.filter((p) => p === prefix || p.startsWith(`${prefix}/`)) : all; return { prefix: prefix ?? '', total: paths.length, paths }; },
    async graphLocate(query) { return { query, matches: [] }; },
    async graphTraceSummary(query) { return { query, direction: 'both', depth: 2, edges: [] }; },
    async resolveEditTargets() { throw new Error('Connected TST daemon does not support revision-bound edit targets.'); },
    async parseStaged() { throw new Error('Connected TST daemon does not support staged parsing.'); },
    async refreshGraphPaths(paths) { return { paths: await Promise.all(paths.map(async (path) => ({ path, content_hash: await readFile(join(root, path)).then((buffer) => import('node:crypto').then(({ createHash }) => createHash('sha256').update(buffer).digest('hex'))).catch(() => null) }))) }; },
    async queryMemory() { return []; },
    async observeMemory() { return { observed: true }; },
    async recordEvidence() { return {}; },
  };
}

class SpyJournal extends MutationJournal {
  log = [];
  async beginFile(input) { this.log.push(['beginFile', input.tool, input.path]); return super.beginFile(input); }
  async recordBarrier(input) { this.log.push(['recordBarrier', input.tool, input.paths]); return super.recordBarrier(input); }
}

async function fixture({ files = {}, git = false, permissions, tst } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-review-'));
  const root = join(dir, 'project');
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  db.createProject({ id: 'p', name: 'P', canonicalPath: root });
  for (const id of ['s', 's2']) db.createSession({ id, projectId: 'p' });
  const journal = new SpyJournal(join(dir, 'journal'));
  const writer = new ProjectWriter();
  const backend = tst ?? fsTst(root);
  const batchEdits = new TstBatchEditManager({ tst: backend, journal, writer });
  const allow = { async authorize() { return { allowed: true, source: 'test' }; }, autoStatus() { return {}; } };
  const common = { tst: backend, planStore: { async toolResult() { return null; } }, permissions: permissions ?? allow, questions: null, db, batchEdits, writer, dataDir: join(dir, 'data') };
  return {
    dir, root, db, journal, writer, batchEdits, tst: backend, common,
    tools: new ToolRuntime(common),
    journaled: new JournaledToolRuntime({ journal, providerRuntimeManager: { adapterFor: ({ adapter }) => adapter, close: async () => {}, forget: async () => false }, ...common }),
    runtimeWith: (overrides) => new ToolRuntime({ ...common, ...overrides }),
  };
}

async function drive(runtime, { sessionId = 's', projectRoot, mode = 'build', signal, calls }) {
  const results = [];
  const adapter = {
    async stream(_messages, options) {
      for (const call of calls) results.push(await options.executeTool({ id: call.id ?? `call_${results.length + 1}`, name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}), ...(call.source ? { source: call.source } : {}) }));
      return { text: '', toolCalls: [] };
    },
  };
  await runtime.run({ adapter, messages: [{ role: 'user', content: 'x' }], sessionId, projectRoot, mode, signal });
  return results;
}
const batchId = (output) => output.match(/batch_id: (\S+)/)[1];

// ─────────────────────────────── workspace_edit / write ───────────────────────────────

test('workspace_edit inserts new_text literally ($$, $&, $` and $\' are not replacement patterns)', async () => {
  const env = await fixture({ files: { Makefile: 'all:\n\told\n', 'f.txt': 'x = OLD;\n' } });
  await drive(env.tools, { projectRoot: env.root, calls: [
    { name: 'workspace_edit', args: { path: 'Makefile', old_text: '\told', new_text: '\t@echo $$HOME' } },
    { name: 'workspace_edit', args: { path: 'f.txt', old_text: 'OLD', new_text: "[$&|$`|$']" } },
  ] });
  assert.equal(await readFile(join(env.root, 'Makefile'), 'utf8'), 'all:\n\t@echo $$HOME\n');
  assert.equal(await readFile(join(env.root, 'f.txt'), 'utf8'), "x = [$&|$`|$'];\n");
});

test('workspace_write refuses to write through a dangling symlink that points outside the project', async () => {
  const env = await fixture({ files: { 'readme.md': 'hi\n' } });
  const outside = join(env.dir, 'outside'); await mkdir(outside);
  await symlink('../outside/new.txt', join(env.root, 'evil.txt'));
  const [result] = await drive(env.tools, { projectRoot: env.root, calls: [{ name: 'workspace_write', args: { path: 'evil.txt', content: 'PWNED' } }] });
  assert.equal(result.success, false);
  assert.match(result.output, /dangling symlink/);
  await assert.rejects(() => stat(join(outside, 'new.txt')), { code: 'ENOENT' });
});

test('a dangling symlink is never "project scoped", so Auto mode cannot auto-approve a write through it', async () => {
  const env = await fixture({ files: { 'a.txt': '1' } });
  await symlink('../elsewhere/new.txt', join(env.root, 'dangling'));
  assert.equal(await isProjectScopedResource('dangling', env.root), false);
  assert.equal(await isProjectScopedResource('brand-new-file.txt', env.root), true);
});

test('permission resources use the symlink TARGET: an alias of .env is not auto-readable in Default mode', async () => {
  const env = await fixture({ files: { '.env': 'API_KEY=sk-live-SECRET\n' } });
  await symlink('.env', join(env.root, 'notes.txt'));
  const rt = env.runtimeWith({ permissions: new PermissionBroker({ interactive: false }) });
  const [direct, alias] = await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_read', args: { path: '.env' } }, { name: 'tst_read', args: { path: 'notes.txt' } }] });
  assert.equal(direct.success, false);
  assert.equal(alias.success, false, 'alias must be classified by what it points at');
  assert.doesNotMatch(alias.output, /sk-live-SECRET/);
});

test('credential-bearing project files are no longer auto-readable, ordinary source still is', async () => {
  const env = await fixture({ files: { 'a.txt': '1' } });
  for (const name of ['.npmrc', '.netrc', '.pypirc', '.git/config', '.docker/config.json', 'id_rsa', 'id_ed25519', 'deploy/kubeconfig', 'terraform.tfstate', 'secrets.yml', 'service-account.json', 'cert.p12', 'keystore.jks', '.htpasswd', '.ssh/config', '.aws/config']) {
    assert.equal(isSensitivePath(name), true, `${name} must be sensitive`);
    assert.equal(await isSafeWorkspaceResource(name, env.root), false, `${name} must not be auto-readable`);
  }
  for (const name of ['src/index.js', 'README.md', 'id_rsa.pub', 'docs/secretary.md', 'package.json', '.github/workflows/ci.yml']) assert.equal(isSensitivePath(name), false, `${name} must stay readable`);
});

// ─────────────────────────────── undo journal ───────────────────────────────

test('workspace_edit with the accepted aliases (file_path/filePath/file) is journaled like path', async () => {
  const env = await fixture({ files: { 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'c.txt': 'gamma\n' } });
  await drive(env.journaled, { projectRoot: env.root, calls: [
    { name: 'workspace_edit', args: { file_path: 'a.txt', old_text: 'alpha', new_text: 'ALPHA' } },
    { name: 'workspace_edit', args: { filePath: 'b.txt', old_text: 'beta', new_text: 'BETA' } },
    { name: 'workspace_write', args: { file: 'c.txt', content: 'GAMMA\n' } },
  ] });
  assert.deepEqual(env.journal.log.filter((entry) => entry[0] === 'beginFile').map((entry) => entry[2]), ['a.txt', 'b.txt', 'c.txt']);
  await env.journal.undoLatest({ sessionId: 's', projectRoot: env.root });
  assert.equal(await readFile(join(env.root, 'c.txt'), 'utf8'), 'gamma\n', 'Undo must revert the LAST edit');
  assert.equal(await readFile(join(env.root, 'b.txt'), 'utf8'), 'BETA\n');
});

test('shell mutations through the provider-facing name cuppet_execute leave an undo barrier', { skip: !sandboxReady && 'bubblewrap unavailable' }, async () => {
  const env = await fixture({ git: true, files: { 'make.sh': 'echo hi > out.txt\n' } });
  const [result] = await drive(env.journaled, { projectRoot: env.root, calls: [{ name: 'cuppet_execute', args: { command: 'sh make.sh' } }] });
  assert.equal(result.success, true);
  assert.equal(result.mutation, true);
  const barriers = env.journal.log.filter((entry) => entry[0] === 'recordBarrier');
  assert.equal(barriers.length, 1);
  assert.equal(barriers[0][1], 'bash', 'the journal keeps recording the canonical tool name');
});

test('git status -z rename records are parsed without mangling the original path', () => {
  assert.deepEqual(parsePorcelainZ('R  new_name.js\0old_name.js\0?? untracked.txt\0 M edited.js\0'), ['new_name.js', 'old_name.js', 'untracked.txt', 'edited.js']);
  assert.deepEqual(parsePorcelainZ('RM renamed and modified.js\0original path.js\0'), ['renamed and modified.js', 'original path.js']);
  assert.deepEqual(parsePorcelainZ(''), []);
});

// ─────────────────────────────── tst_read ───────────────────────────────

test('tst_read rejects more than 12 reads instead of silently dropping the rest', async () => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, `content-${i}\n`]));
  const env = await fixture({ files });
  const [result] = await drive(env.tools, { projectRoot: env.root, calls: [{ name: 'tst_read', args: { reads: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt` })) } }] });
  assert.equal(result.success, false);
  assert.match(result.output, /at most 12/);
});

test('tst_read coverage reflects what survived the output budget and names the omitted files', async () => {
  const big = (tag) => Array.from({ length: 300 }, (_, i) => `${tag} ${String(i).padStart(4, '0')} ${'x'.repeat(60)}`).join('\n');
  const env = await fixture({ files: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`big${i}.txt`, big(`F${i}`)])) });
  const [result] = await drive(env.tools, { projectRoot: env.root, calls: [{ name: 'tst_read', args: { reads: Array.from({ length: 12 }, (_, i) => ({ path: `big${i}.txt` })) } }] });
  const sections = (result.output.match(/^FILE /gm) ?? []).length;
  assert.ok(sections < 12);
  assert.match(result.output.split('\n')[0], new RegExp(`coverage=${sections}/12`));
  assert.match(result.output.split('\n')[0], /omitted for size: .*big11\.txt/);
});

// ─────────────────────────────── tst_explore cache ───────────────────────────────

test('tst_explore results are not replayed as "identical" after the workspace changed', async () => {
  const env = await fixture({ files: { 'src/a.js': '1\n' } });
  const results = await drive(env.tools, { projectRoot: env.root, calls: [
    { name: 'tst_explore', args: { mode: 'tree', prefix: 'src' } },
    { name: 'tst_explore', args: { mode: 'tree', prefix: 'src' } },
    { name: 'workspace_write', args: { path: 'src/new_file.js', content: 'export const x = 1;\n' } },
    { name: 'tst_explore', args: { mode: 'tree', prefix: 'src' } },
  ] });
  assert.match(results[1].output, /already returned earlier/, 'an unchanged repeat is still deduplicated');
  assert.doesNotMatch(results[3].output, /already returned earlier/);
  assert.match(results[3].output, /src\/new_file\.js/);
});

// ─────────────────────────────── tst_edit_batch ───────────────────────────────

test('tst_edit_batch keeps a symlink a symlink and edits its target (CLAUDE.md -> AGENTS.md)', async () => {
  const env = await fixture({ files: { 'AGENTS.md': 'rules v1\n' } });
  await symlink('AGENTS.md', join(env.root, 'CLAUDE.md'));
  const [prepared] = await drive(env.tools, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'prepare', operations: [{ op: 'replace_text', path: 'CLAUDE.md', old_text: 'v1', new_text: 'v2' }] } }] });
  const [applied] = await drive(env.tools, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'apply', batch_id: batchId(prepared.output) } }] });
  assert.equal(applied.success, true, applied.output);
  assert.equal((await lstat(join(env.root, 'CLAUDE.md'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(env.root, 'AGENTS.md'), 'utf8'), 'rules v2\n');
});

test('tst_edit_batch asks for permission on the symlink target, not the alias', async () => {
  const env = await fixture({ files: { '.env': 'TOKEN=abc\n' } });
  await symlink('.env', join(env.root, 'config.txt'));
  const seen = [];
  const rt = env.runtimeWith({ permissions: { autoStatus() { return {}; }, async authorize(request) { seen.push(request.resources); return { allowed: true, source: 'test' }; } } });
  const [prepared] = await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'prepare', operations: [{ op: 'replace_text', path: 'config.txt', old_text: 'abc', new_text: 'xyz' }] } }] });
  await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'apply', batch_id: batchId(prepared.output) } }] });
  assert.deepEqual(seen.at(-1), ['.env']);
});

test('batch diff is a real unified diff: changes past line 400 are visible and hunks apply with git', async () => {
  const body = Array.from({ length: 1000 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const edited = body.replace('const v900 = 900;', "const v900 = 'CHANGED';");
  const diff = renderBatchDiff([{ path: 'big.js', exists: true, before: Buffer.from(body), after: Buffer.from(edited) }]);
  assert.ok(diff.includes("+const v900 = 'CHANGED';") && diff.includes('-const v900 = 900;'));
  assert.ok(diff.split('\n').length < 20, `expected a compact diff, got ${diff.split('\n').length} lines`);
  assert.match(diff, /^@@ -898,7 \+898,7 @@$/m);

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-diff-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(join(dir, 'big.js'), body); await writeFile(join(dir, 'p.diff'), diff);
  execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
  assert.equal(await readFile(join(dir, 'big.js'), 'utf8'), edited);
});

test('batch diff handles created files, deletions at EOF and missing trailing newlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-diff-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const cases = [
    { before: '', after: 'one\ntwo\n' },
    { before: 'a\nb\nc', after: 'a\nb\nc\nd' },
    { before: 'a\nb\nc\n', after: 'a\nb\n' },
    { before: 'x\ny\nx\ny\nx\n', after: 'x\ny\nz\ny\nx\n' },
  ];
  for (const { before, after } of cases) {
    const exists = before.length > 0;
    const diff = renderBatchDiff([{ path: 'f.txt', exists, before: Buffer.from(before), after: Buffer.from(after) }]);
    if (exists) await writeFile(join(dir, 'f.txt'), before); else await rm(join(dir, 'f.txt'), { force: true });
    await writeFile(join(dir, 'p.diff'), diff.endsWith('\n') ? diff : `${diff}\n`);
    execFileSync('git', ['apply', '--whitespace=nowarn', 'p.diff'], { cwd: dir });
    assert.equal(await readFile(join(dir, 'f.txt'), 'utf8'), after);
  }
});

test('diff_digest binds to the full state transition: edits that look identical when truncated get different digests', async () => {
  const body = Array.from({ length: 1000 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const env = await fixture({ files: { 'big.js': body } });
  const prepare = (n) => drive(env.tools, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'prepare', operations: [{ op: 'replace_text', path: 'big.js', old_text: `const v${n} = ${n};`, new_text: `const v${n} = 'CHANGED';` }] } }] });
  const [a] = await prepare(900); const [b] = await prepare(901);
  const digest = (output) => output.match(/diff_digest: (\w+)/)[1];
  assert.notEqual(digest(a.output), digest(b.output));
  assert.ok(a.output.includes("+const v900 = 'CHANGED';"));
});

test('the approval prompt states how many lines each file gains and loses (computed from the edit script)', async () => {
  const env = await fixture({ files: { 'a.txt': 'one\ntwo\nthree\n' } });
  const requests = [];
  const rt = env.runtimeWith({ permissions: { autoStatus() { return {}; }, async authorize(request) { requests.push(request); return { allowed: true, source: 'test' }; } } });
  const [prepared] = await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'prepare', operations: [{ op: 'replace_text', path: 'a.txt', old_text: 'two', new_text: 'TWO\nextra' }] } }] });
  await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_edit_batch', args: { action: 'apply', batch_id: batchId(prepared.output) } }] });
  assert.match(requests.at(-1).description, /a\.txt \(\+2 -1\)/);
});

test('a pending approval does not hold the project write lock, and Stop works while waiting for it', async () => {
  const env = await fixture({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const permissions = { autoStatus() { return {}; }, async authorize(request) { if (request.sessionId === 's') await gate; return { allowed: true, source: 'test' }; } };
  const rt = env.runtimeWith({ permissions });
  const first = drive(rt, { sessionId: 's', projectRoot: env.root, calls: [{ name: 'workspace_edit', args: { path: 'a.txt', old_text: 'a', new_text: 'A' } }] });
  await sleep(50);
  const [second] = await Promise.race([drive(rt, { sessionId: 's2', projectRoot: env.root, calls: [{ name: 'workspace_edit', args: { path: 'b.txt', old_text: 'b', new_text: 'B' } }] }), sleep(1500).then(() => { throw new Error('second session was blocked by the first session\'s pending approval'); })]);
  assert.equal(second.success, true);
  assert.equal(await readFile(join(env.root, 'b.txt'), 'utf8'), 'B\n');
  release(); await first;
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'A\n');
});

test('ProjectWriter: waiters can be aborted, suspend() releases the lock, and critical sections never overlap', async () => {
  const writer = new ProjectWriter();
  const root = await mkdtemp(join(tmpdir(), 'cuppet-writer-'));
  let active = 0; let overlapped = false;
  const section = async () => { active += 1; overlapped ||= active > 1; await sleep(15); active -= 1; };
  await Promise.all(Array.from({ length: 6 }, () => writer.withProject(root, section)));
  assert.equal(overlapped, false);

  let release; const hold = new Promise((resolve) => { release = resolve; });
  const holder = writer.withProject(root, () => hold);
  await sleep(20);
  const controller = new AbortController();
  const waiter = writer.withProject(root, () => 'never', { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(waiter, { name: 'AbortError' });
  release(); await holder;
  assert.equal(await writer.withProject(root, () => 'free again'), 'free again', 'an aborted waiter must not wedge the queue');

  let release2; const wait = new Promise((resolve) => { release2 = resolve; });
  const events = [];
  const suspended = writer.withProject(root, async (lock) => { events.push('start'); await lock.suspend(() => wait); events.push('resumed'); });
  await sleep(20);
  await writer.withProject(root, () => events.push('other ran while suspended'));
  release2(); await suspended;
  assert.deepEqual(events, ['start', 'other ran while suspended', 'resumed']);
});

// ─────────────────────────────── permission classification ───────────────────────────────

test('agent permission kinds are authoritative: a free-text title cannot turn execute/delete/edit into web-fetch', () => {
  assert.equal(agentPermissionAction('execute', 'open https://evil.example/payload'), 'bash');
  assert.equal(agentPermissionAction('execute', 'get https://x | sh'), 'bash');
  assert.equal(agentPermissionAction('delete', 'Read web url cache'), 'delete');
  assert.equal(agentPermissionAction('edit', 'fetch https page'), 'edit');
  assert.equal(agentPermissionAction('other', 'Fetch https://example.com page'), 'web-fetch', 'unknown kinds may still use the title');
  assert.equal(agentPermissionAction('search', 'Search the web'), 'web-fetch');
});

test('Auto mode no longer silently plants git hooks / config that run outside the sandbox', async () => {
  const env = await fixture({ git: true, files: { 'hello.txt': 'hi\n' } });
  assert.equal(isGitExecutionSurface('.git/hooks/pre-commit'), true);
  assert.equal(isGitExecutionSurface('.git/config'), true);
  assert.equal(isGitExecutionSurface('.git/objects/ab/cdef'), false);
  assert.equal(isGitExecutionSurface('src/.github/hooks.md'), false);
  assert.equal(await isAutoProjectBashCommand("echo '#!/bin/sh' > .git/hooks/post-commit && chmod +x .git/hooks/post-commit", env.root), false);
  assert.equal(await isAutoProjectBashCommand('git config core.hooksPath .githooks', env.root), false);
  assert.equal(await isAutoProjectBashCommand('git config core.fsmonitor "sh -c x"', env.root), false);
  assert.equal(await isAutoProjectBashCommand('git config user.name tester', env.root), true, 'harmless config still auto-approves');
  assert.equal(await isAutoProjectBashCommand('npm test', env.root), true);

  const prompts = [];
  const broker = new PermissionBroker({ interactive: false, emit: (event) => { if (event.type === 'permission.requested') prompts.push(event.request); } });
  broker.setAuto('s', true);
  const rt = env.runtimeWith({ permissions: broker });
  const [hook, ordinary] = await drive(rt, { projectRoot: env.root, calls: [
    { name: 'workspace_write', args: { path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho owned\n' } },
    { name: 'workspace_write', args: { path: 'src/ok.js', content: 'export {};\n' } },
  ] });
  assert.equal(hook.success, false, 'hook write needs a human, and there is no human in a non-interactive broker');
  assert.equal(ordinary.success, true, 'ordinary project writes stay automatic in Auto mode');
  await assert.rejects(() => stat(join(env.root, '.git', 'hooks', 'pre-commit')), { code: 'ENOENT' });
});

// ─────────────────────────────── execution kernel ───────────────────────────────

test('a human rejection or policy denial does not unlock the raw tools; a real tool failure still does', async () => {
  const kernel = new ExecutionKernel();
  const run = (sessionId, name, result) => kernel.execute({ id: sessionId, name, arguments: '{}' }, { sessionId, projectRoot: '/p', execute: async () => result });
  await run('denied', 'tst_edit_batch', { success: false, denied: true, output: 'Permission denied: Permission rejected by user.' });
  await run('denied', 'tst_read', { success: false, denied: true, output: 'Permission denied: protected resource' });
  assert.equal(kernel.snapshot('denied').rawMutationFallback, false);
  assert.equal(kernel.snapshot('denied').rawReadFallback, false);
  await run('broken', 'tst_edit_batch', { success: false, output: 'Tool failed: daemon unavailable' });
  await run('broken', 'tst_read', { success: false, output: 'Tool failed: File exceeds read limit' });
  assert.equal(kernel.snapshot('broken').rawMutationFallback, true);
  assert.equal(kernel.snapshot('broken').rawReadFallback, true);
});

test('shell heuristics: fd redirects, pipe filters and hyphenated arguments are not source reads/writes; real ones still are', async () => {
  const kernel = new ExecutionKernel();
  const blocked = async (command) => { let ran = false; await kernel.execute({ id: command, name: 'cuppet_execute', arguments: JSON.stringify({ command }) }, { sessionId: `k:${command}`, projectRoot: '/p', execute: async () => { ran = true; return { success: true, output: 'ok' }; } }); return !ran; };
  for (const command of ['npm test 2>&1 | tail -20', 'pytest -q 2>&1', 'cargo test 2>&1 >/dev/null', 'git log --oneline | head -5', 'node scripts/check.js | grep FAIL', 'npm install patch-package', 'echo "a > b"', 'npm run find-bugs']) {
    assert.equal(await blocked(command), false, `${command} should be allowed`);
  }
  for (const command of ['cat src/a.js', 'grep -rn TODO src', 'sed -i s/a/b/ f.txt', 'echo hi > out.txt', 'npm run build > build.log', 'rm -rf dist', 'mv a.js b.js', 'cp a b', 'ls | xargs cat', 'find . -name "*.js"', 'tee out.txt']) {
    assert.equal(await blocked(command), true, `${command} should stay blocked`);
  }
});

// ─────────────────────────────── TST client / supervisor ───────────────────────────────

async function startFakeDaemon({ mode = 'ok' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-tst-'));
  const socketPath = join(dir, 's.sock');
  const stats = { connections: 0, calls: 0 };
  const reply = (socket, id, result) => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header, body])); };
  const server = createServer((socket) => {
    stats.connections += 1; let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0); if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString()); buffer = buffer.subarray(4 + length);
        if (request.method === 'initialize') reply(socket, request.id, { protocol: 'cuppet.tst.v3', capabilities: ['graph.list'] });
        else { stats.calls += 1; if (mode === 'ok') reply(socket, request.id, { ok: true }); }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath, stats, close: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('TstClient.call times out instead of hanging forever on a daemon that never answers', async () => {
  const daemon = await startFakeDaemon({ mode: 'silent' });
  const client = await TstClient.connect(daemon.socketPath, 'token');
  const started = Date.now();
  await assert.rejects(client.call('graph.list', {}, { timeoutMs: 150 }), /timed out after 150ms/);
  assert.ok(Date.now() - started < 2000);
  client.destroy(); await daemon.close();
});

test('TstBridge shares one in-flight connection across concurrent first calls', async () => {
  const daemon = await startFakeDaemon();
  const bridge = new TstBridge({ socketPath: daemon.socketPath, token: 'token' });
  await Promise.all(Array.from({ length: 6 }, () => bridge.call('graph.list', {})));
  assert.equal(daemon.stats.connections, 1);
  bridge.close(); await daemon.close();
});

test('a hung TST observation cannot withhold a tool result from the model', async () => {
  const env = await fixture({ files: { 'a.txt': 'a\n' } });
  const hung = { ...env.tst, observeMemory: () => new Promise(() => {}) };
  const rt = env.runtimeWith({ tst: hung });
  const outcome = await Promise.race([drive(rt, { projectRoot: env.root, calls: [{ name: 'workspace_edit', args: { path: 'a.txt', old_text: 'a', new_text: 'A' } }] }).then(() => 'returned'), sleep(6000).then(() => 'blocked')]);
  assert.equal(outcome, 'returned');
  assert.equal(await readFile(join(env.root, 'a.txt'), 'utf8'), 'A\n');
});

test('TstSupervisor starts a single daemon for concurrent cold-start callers and bounds a wedged start', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sup-'));
  const binary = join(dir, 'fake-tst.mjs'); const log = join(dir, 'pids.log');
  await writeFile(binary, `#!/usr/bin/env node
import { createServer } from 'node:net'; import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--protocol')) { console.log('cuppet.tst.v3'); process.exit(0); }
const sock = args[args.indexOf('--socket') + 1]; appendFileSync(process.env.FAKE_LOG, process.pid + '\\n');
const reply = (s, id, result) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); s.write(Buffer.concat([h, b])); };
createServer((s) => { let buf = Buffer.alloc(0); s.on('data', (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= 4) { const n = buf.readUInt32BE(0); if (buf.length < n + 4) return; const r = JSON.parse(buf.subarray(4, 4 + n).toString()); buf = buf.subarray(4 + n);
  if (process.env.FAKE_MODE === 'wedged') continue;
  if (r.method === 'initialize') reply(s, r.id, { protocol: 'cuppet.tst.v3', capabilities: [] }); else if (r.method === 'shutdown') { reply(s, r.id, {}); setTimeout(() => process.exit(0), 20); } else reply(s, r.id, { ok: true }); } }); }).listen(sock);
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(binary, 0o755);
  const make = (name) => new TstSupervisor({ binaryPath: binary, projectRoot: dir, projectStore: join(dir, name, 'ps'), globalStore: join(dir, name, 'gs'), runRoot: join(dir, name, 'run'), idleMs: 0, projectKey: name });
  process.env.FAKE_LOG = log; process.env.FAKE_MODE = 'ok'; await writeFile(log, '');
  const healthy = make('ok');
  await Promise.all(Array.from({ length: 4 }, () => healthy.call('graph.list', {})));
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1, 'exactly one daemon must be spawned');
  await healthy.close();

  process.env.FAKE_MODE = 'wedged';
  const wedged = make('wedged');
  const started = Date.now();
  await assert.rejects(wedged.call('graph.list', {}), /Timed out waiting for managed TST daemon/);
  assert.ok(Date.now() - started < 30_000, 'the startup deadline must actually be enforced');
  await wedged.close().catch(() => undefined);
});

// ─────────────────────────────── workspace fallback handle ───────────────────────────────

test('fallback handle: .github is indexed, trace says "unavailable" (not "0 edges"), and a capped index is disclosed', async () => {
  const env = await fixture({ files: { '.github/workflows/ci.yml': 'on: push\n', 'src/a.js': 'export function handleLogin() {}\n', 'src/b.js': "import { handleLogin } from './a.js'; handleLogin();\n" } });
  const handle = new WorkspaceTstHandle({ projectRoot: env.root, projectKey: 'k', projectStore: join(env.dir, 'ps'), globalStore: join(env.dir, 'gs') });
  const listing = await handle.graphList('');
  assert.ok(listing.paths.includes('.github/workflows/ci.yml'));
  const rt = env.runtimeWith({ tst: handle, batchEdits: new TstBatchEditManager({ tst: handle, journal: env.journal, writer: env.writer }) });
  const [trace] = await drive(rt, { projectRoot: env.root, calls: [{ name: 'tst_explore', args: { mode: 'trace', query: 'handleLogin', direction: 'callers' } }] });
  assert.match(trace.output, /unavailable/);
  assert.doesNotMatch(trace.output, /0 edges/);
});

test('fallback handle: prefix queries reach files past the whole-repository cap and cannot escape the project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-cap-'));
  await mkdir(join(dir, 'aaa_docs'), { recursive: true }); await mkdir(join(dir, 'zzz_src'), { recursive: true });
  await writeFile(join(dir, '..', 'outside-secret.txt'), 'nope').catch(() => undefined);
  await Promise.all(Array.from({ length: 5050 }, (_, i) => writeFile(join(dir, 'aaa_docs', `d${i}.md`), 'x')));
  await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(dir, 'zzz_src', `s${i}.js`), 'needle')));
  const handle = new WorkspaceTstHandle({ projectRoot: dir, projectKey: 'k', projectStore: join(dir, '.ps'), globalStore: join(dir, '.gs') });
  const workspace = await handle.graphWorkspace(50);
  assert.equal(workspace.graph.truncated, true, 'the capped index must be disclosed');
  const sub = await handle.graphList('zzz_src');
  assert.equal(sub.paths.length, 5, 'a prefix query must see its whole subtree');
  const found = await handle.graphLocate('needle', 'zzz_src', 12);
  assert.ok(found.matches.length >= 1);
  for (const prefix of ['..', '../', 'aaa_docs/../..', '/etc', '..\\']) assert.deepEqual((await handle.graphList(prefix)).paths, [], `prefix ${prefix} must not escape`);
});

test('fallback handle: a torn memory file is preserved, and concurrent writers do not lose updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-mem-'));
  const make = () => new WorkspaceTstHandle({ projectRoot: dir, projectKey: 'k', projectStore: join(dir, 'ps'), globalStore: join(dir, 'gs') });
  const a = make();
  await Promise.all(Array.from({ length: 8 }, (_, i) => a.rememberMemory('s', { key: `k${i}`, value: `v${i}`, scope: 'project' })));
  const file = join(dir, 'ps', 'memory.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 8, 'no lost update under concurrency');

  const good = await readFile(file, 'utf8');
  await writeFile(file, good.slice(0, Math.floor(good.length / 2)));
  await make().rememberMemory('s', { key: 'after', value: 'new', scope: 'project' });
  const preserved = (await readdir(join(dir, 'ps'))).filter((name) => name.startsWith('memory.json.corrupt-'));
  assert.equal(preserved.length, 1, 'the damaged file must be kept for recovery, not overwritten');
});
