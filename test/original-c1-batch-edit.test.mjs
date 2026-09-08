import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MutationJournal, UndoConflictError } from '../src/runtime/mutation-journal.mjs';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';

function sha(value) { return createHash('sha256').update(value).digest('hex'); }

class FakeTst {
  configured = true;
  failRefresh = false;
  constructor(root) { this.root = root; }
  async parseStaged(path, baseHash, content) {
    return {
      path, base_hash: baseHash, staged_hash: sha(Buffer.from(content)), supported: true,
      base_syntax_ok: true, staged_syntax_ok: !content.includes('SYNTAX_BAD'),
      introduced_syntax_errors: content.includes('SYNTAX_BAD') ? 1 : 0,
      base_diagnostics: [], staged_diagnostics: content.includes('SYNTAX_BAD') ? [{ kind: 'ERROR' }] : [],
    };
  }
  async refreshGraphPaths(paths) {
    if (this.failRefresh) throw new Error('graph offline');
    return { paths: await Promise.all(paths.map(async (path) => ({ path, content_hash: sha(await readFile(join(this.root, path))) }))), graph: { files: paths.length } };
  }
  async resolveEditTargets(path, query) { return { path, query, matches: [] }; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-c1-'));
  await mkdir(join(root, '.cuppet'), { recursive: true });
  const journal = new MutationJournal(join(root, '.cuppet', 'journal'));
  const tst = new FakeTst(root);
  const manager = new TstBatchEditManager({ tst, journal });
  return { root, journal, tst, manager };
}

function authorizeCapture(target) {
  return async (request) => { target.push(request); return { allowed: true, source: 'test' }; };
}

test('prepare is write-free; apply mutates multiple files behind one undo boundary', async () => {
  const { root, journal, manager } = await fixture();
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');
  const prepared = await manager.prepare({ sessionId: 's1', projectRoot: root, operations: [
    { op: 'replace_text', path: 'a.ts', old_text: '1', new_text: '10' },
    { op: 'replace_text', path: 'b.ts', old_text: '2', new_text: '20' },
  ] });
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.match(prepared.diff, /a\.ts/);
  assert.match(prepared.diff, /b\.ts/);

  const permissions = [];
  const applied = await manager.apply({ batchId: prepared.id, sessionId: 's1', projectRoot: root, executionId: 'tool-1', authorize: authorizeCapture(permissions) });
  assert.equal(applied.graphReady, true);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'export const a = 10;\n');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'export const b = 20;\n');
  assert.equal(permissions.length, 1);
  assert.match(permissions[0].fingerprintKey, new RegExp(`^tst-batch:${prepared.id}:`));

  const status = await journal.status('s1');
  assert.equal(status.latest.kind, 'batch');
  assert.deepEqual(status.latest.paths, ['a.ts', 'b.ts']);
  const undone = await journal.undoLatest({ sessionId: 's1', projectRoot: root });
  assert.equal(undone.undone, true);
  assert.deepEqual(undone.paths, ['a.ts', 'b.ts']);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'export const b = 2;\n');
});

test('stale file between prepare/apply rejects the whole batch without touching other files', async () => {
  const { root, manager } = await fixture();
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'const b = 2;\n');
  const prepared = await manager.prepare({ sessionId: 's1', projectRoot: root, operations: [
    { op: 'replace_text', path: 'a.ts', old_text: '1', new_text: '3' },
    { op: 'replace_text', path: 'b.ts', old_text: '2', new_text: '4' },
  ] });
  await writeFile(join(root, 'a.ts'), 'const a = 99;\n');
  await assert.rejects(() => manager.apply({ batchId: prepared.id, sessionId: 's1', projectRoot: root, executionId: 'tool-2', authorize: async () => ({ allowed: true }) }), /became stale/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const a = 99;\n');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'const b = 2;\n');
});

test('overlapping revision-bound structural targets are rejected during prepare', async () => {
  const { root, manager } = await fixture();
  const source = Buffer.from('const π = () => 1;\n', 'utf8');
  await writeFile(join(root, 'unicode.ts'), source);
  const start = source.indexOf(Buffer.from('const π', 'utf8'));
  const targetSource = source.toString('utf8');
  const target = {
    target_id: `tst:${'a'.repeat(32)}`, path: 'unicode.ts', symbol: 'π', kind: 'lexical_declaration', base_hash: sha(source),
    start_byte: start, end_byte: source.length, start_row: 0, start_column: 0, end_row: 1, end_column: 0, expected_source: targetSource,
  };
  await assert.rejects(() => manager.prepare({ sessionId: 's1', projectRoot: root, operations: [
    { op: 'replace_node', target, content: 'const π = () => 2;\n' },
    { op: 'delete_node', target },
  ] }), /overlapping\/ambiguous/);
  assert.deepEqual(await readFile(join(root, 'unicode.ts')), source);
});

test('introduced staged parse errors block prepare and preserve the workspace', async () => {
  const { root, manager } = await fixture();
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await assert.rejects(() => manager.prepare({ sessionId: 's1', projectRoot: root, operations: [
    { op: 'replace_text', path: 'a.ts', old_text: '1', new_text: 'SYNTAX_BAD' },
  ] }), /Staged parse validation failed/);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('graph refresh failure is reported after an applied edit and blocks later structural work until recovery', async () => {
  const { root, manager, tst } = await fixture();
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const prepared = await manager.prepare({ sessionId: 's1', projectRoot: root, operations: [{ op: 'replace_text', path: 'a.ts', old_text: '1', new_text: '2' }] });
  tst.failRefresh = true;
  const applied = await manager.apply({ batchId: prepared.id, sessionId: 's1', projectRoot: root, executionId: 'tool-3', authorize: async () => ({ allowed: true }) });
  assert.equal(applied.applied, true);
  assert.equal(applied.graphReady, false);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'export const a = 2;\n');
  await assert.rejects(() => manager.prepare({ sessionId: 's1', projectRoot: root, operations: [{ op: 'replace_text', path: 'a.ts', old_text: '2', new_text: '3' }] }), /graph refresh is required/);
  tst.failRefresh = false;
  const recovered = await manager.prepare({ sessionId: 's1', projectRoot: root, operations: [{ op: 'replace_text', path: 'a.ts', old_text: '2', new_text: '3' }] });
  assert.equal(recovered.state, 'prepared');
});

test('batch undo refuses to overwrite any externally modified file', async () => {
  const { root, journal, manager } = await fixture();
  await writeFile(join(root, 'a.ts'), 'a1\n');
  await writeFile(join(root, 'b.ts'), 'b1\n');
  const prepared = await manager.prepare({ sessionId: 's1', projectRoot: root, operations: [
    { op: 'replace_text', path: 'a.ts', old_text: 'a1', new_text: 'a2' },
    { op: 'replace_text', path: 'b.ts', old_text: 'b1', new_text: 'b2' },
  ] });
  await manager.apply({ batchId: prepared.id, sessionId: 's1', projectRoot: root, executionId: 'tool-4', authorize: async () => ({ allowed: true }) });
  await writeFile(join(root, 'b.ts'), 'human edit\n');
  await assert.rejects(() => journal.undoLatest({ sessionId: 's1', projectRoot: root }), UndoConflictError);
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'a2\n');
  assert.equal(await readFile(join(root, 'b.ts'), 'utf8'), 'human edit\n');
});

test('ProjectWriter serializes mutating work for the same project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-writer-'));
  const writer = new ProjectWriter();
  const order = [];
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const first = writer.withProject(root, async () => { order.push('first-start'); await gate; order.push('first-end'); });
  const second = writer.withProject(root, async () => { order.push('second-start'); order.push('second-end'); });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.deepEqual(order, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});
