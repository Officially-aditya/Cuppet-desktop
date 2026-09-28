import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { WorkspaceTstHandle } from '../src/runtime/workspace-tst-handle.mjs';
import { ManagedTstManager } from '../src/runtime/tst-supervisor.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';

test('WorkspaceTstHandle provides workspace graph exploration, search, and memory persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-workspace-tst-'));
  const workspace = join(root, 'project');
  const store = join(root, 'store');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true });

  await writeFile(join(workspace, 'package.json'), '{"name":"sample"}\n');
  await writeFile(join(workspace, 'src', 'index.js'), 'export function executeTask() { return 42; }\n');
  await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');

  try {
    const handle = new WorkspaceTstHandle({
      projectRoot: workspace,
      projectStore: join(store, 'project'),
      globalStore: join(store, 'global'),
    });

    assert.equal(handle.configured, true);
    assert.equal(handle.status.mode, 'workspace-fallback');
    assert.equal(handle.supports('graph.workspace'), true);
    assert.equal(handle.supports('edit.parse_staged'), false);

    // 1. graphWorkspace should ignore .git and node_modules
    const ws = await handle.graphWorkspace(50);
    assert.equal(ws.root, workspace);
    assert.deepEqual(ws.files, ['package.json', 'src/index.js']);
    assert.equal(ws.graph.files, 2);

    // 2. graphList with prefix
    const list = await handle.graphList('src', 50);
    assert.deepEqual(list.paths, ['src/index.js']);
    assert.equal(list.total, 1);

    // 3. graphLocate finding content
    const located = await handle.graphLocate('executeTask', undefined, 10);
    assert.equal(located.matches.length, 1);
    assert.equal(located.matches[0].path, 'src/index.js');
    assert.equal(located.matches[0].line, 1);
    assert.equal(located.matches[0].symbol, 'executeTask');

    // 4. refreshGraphPaths computing sha256
    const refreshed = await handle.refreshGraphPaths(['src/index.js', 'missing.txt']);
    assert.equal(refreshed.paths.length, 2);
    assert.equal(refreshed.paths[0].path, 'src/index.js');
    assert.ok(/^[a-f0-9]{64}$/.test(refreshed.paths[0].content_hash));
    assert.equal(refreshed.paths[1].content_hash, null);

    // 5. Memory operations and persistence across handle recreation
    await handle.rememberMemory('session-1', {
      key: 'preference',
      value: 'use-typescript',
      scope: 'project',
      pinned: true,
    });
    const memories = await handle.queryMemory('session-1', 'typescript', 10);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].key, 'preference');
    assert.equal(memories[0].value, 'use-typescript');

    // Recreate handle with same store: project memory persists
    const handle2 = new WorkspaceTstHandle({
      projectRoot: workspace,
      projectStore: join(store, 'project'),
      globalStore: join(store, 'global'),
    });
    const reloaded = await handle2.queryMemory('session-2', 'preference', 10);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].value, 'use-typescript');

    await handle2.forgetMemory('session-2', 'preference');
    const forgotten = await handle2.queryMemory('session-2', 'preference', 10);
    assert.equal(forgotten.length, 0);

    // Unsupported edit target methods reject cleanly
    await assert.rejects(() => handle.resolveEditTargets('a.js', 'q', 'h'), /does not support revision-bound edit targets/);
    await assert.rejects(() => handle.parseStaged('a.js', 'h', 'c'), /does not support staged parsing/);

    handle.close();
    handle2.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ManagedTstManager falls back to WorkspaceTstHandle when native binary is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-managed-fallback-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'file.txt'), 'hello world\n');

  try {
    const manager = new ManagedTstManager({
      dataDir: join(root, 'data'),
      binaryPath: null,
      existsImpl: () => false,
    });

    assert.equal(manager.configured, true);
    assert.equal(manager.status.mode, 'workspace-fallback');
    assert.equal(manager.status.connected, true);

    const runtime = new RuntimeTstManager({ manager });
    await runtime.runWithProject({ sessionId: 'session-fb', projectId: 'proj-fb', projectRoot: workspace }, async () => {
      const ws = await runtime.graphWorkspace(10);
      assert.deepEqual(ws.files, ['file.txt']);

      const found = await runtime.graphLocate('hello', undefined, 5);
      assert.equal(found.matches.length, 1);
      assert.equal(found.matches[0].path, 'file.txt');

      await runtime.rememberMemory('session-fb', { key: 'marker', value: 'fallback-works', scope: 'project' });
      const query = await runtime.queryMemory('session-fb', 'fallback');
      assert.equal(query.length, 1);
      assert.equal(query[0].value, 'fallback-works');
    });

    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tst_edit_batch works with WorkspaceTstHandle fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-batch-fallback-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'first.txt'), 'version 1\n');
  await writeFile(join(workspace, 'second.txt'), 'count 1\n');

  try {
    const handle = new WorkspaceTstHandle({ projectRoot: workspace });
    const journal = new MutationJournal(join(root, 'journal'));
    const batchManager = new TstBatchEditManager({ tst: handle, journal });

    const prepared = await batchManager.prepare({
      sessionId: 'session-batch',
      projectRoot: workspace,
      operations: [
        { op: 'replace_text', path: 'first.txt', old_text: '1', new_text: '2' },
        { op: 'create_file', path: 'third.txt', content: 'new file\n' },
      ],
    });

    assert.ok(prepared.id);
    assert.match(prepared.diff, /first\.txt/);
    assert.match(prepared.diff, /third\.txt/);

    const applied = await batchManager.apply({
      batchId: prepared.id,
      sessionId: 'session-batch',
      projectRoot: workspace,
      executionId: 'exec-batch',
      authorize: async () => ({ allowed: true, source: 'test' }),
    });

    assert.equal(applied.graphReady, true);
    assert.equal(await readFile(join(workspace, 'first.txt'), 'utf8'), 'version 2\n');
    assert.equal(await readFile(join(workspace, 'third.txt'), 'utf8'), 'new file\n');

    handle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

