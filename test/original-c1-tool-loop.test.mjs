import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';
import { ProjectWriter } from '../src/runtime/project-writer.mjs';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function setup({ omitRefreshPath = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-original-c1-loop-'));
  const root = join(dir, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  const initial = 'export function Widget(){ return 1; }\n';
  await writeFile(join(root, 'src/widget.js'), initial);
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  db.createProject({ id: 'project', name: 'Project', canonicalPath: root });
  db.createSession({ id: 'session', projectId: 'project' });
  const observations = [];
  const evidence = [];
  let refreshCount = 0;
  const tst = {
    configured: true,
    async graphLocate(query) {
      return { query, matches: [{ path: 'src/widget.js', symbol: 'Widget', kind: 'function_declaration', line: 1, column: 1 }] };
    },
    async resolveEditTargets(path, query) {
      assert.equal(path, 'src/widget.js');
      assert.equal(query, 'Widget');
      const raw = await readFile(join(root, path));
      const expected = raw.toString('utf8').trimEnd();
      return {
        path,
        language: 'javascript',
        base_hash: sha256(raw),
        matches: [{
          target_id: `tst:${sha256(Buffer.from(`${path}\0${sha256(raw)}\0${expected}`)).slice(0, 32)}`,
          path,
          language: 'javascript',
          symbol: 'Widget',
          kind: 'function_declaration',
          base_hash: sha256(raw),
          start_byte: 0,
          end_byte: Buffer.byteLength(expected),
          start_row: 0,
          start_column: 0,
          end_row: 0,
          end_column: Buffer.byteLength(expected),
          expected_source: expected,
        }],
        truncated: false,
      };
    },
    async parseStaged(path, baseHash, content) {
      const current = await readFile(join(root, path)).catch(() => null);
      if (baseHash) assert.equal(baseHash, sha256(current));
      return {
        path,
        language: 'javascript',
        base_hash: baseHash,
        staged_hash: sha256(Buffer.from(content)),
        supported: true,
        base_syntax_ok: true,
        staged_syntax_ok: true,
        introduced_syntax_errors: 0,
        base_diagnostics: [],
        staged_diagnostics: [],
        diagnostics_truncated: false,
      };
    },
    async refreshGraphPaths(paths) {
      refreshCount++;
      if (omitRefreshPath) return { paths: [] };
      return { paths: await Promise.all(paths.map(async (path) => ({ path, content_hash: sha256(await readFile(join(root, path))) }))) };
    },
    async observeMemory(sessionId, observation) { observations.push({ sessionId, observation }); return { id: `memory_${observations.length}` }; },
    async recordEvidence(...args) { evidence.push(args); return {}; },
  };
  const journal = new MutationJournal(join(dir, 'journal'));
  const writer = new ProjectWriter();
  const batchEdits = new TstBatchEditManager({ tst, journal, writer });
  const permissions = { async authorize() { return { allowed: true, source: 'test' }; } };
  const toolRuntime = new ToolRuntime({
    tst,
    planStore: { async toolResult() { return null; } },
    permissions,
    questions: null,
    db,
    batchEdits,
    writer,
  });
  return { dir, root, db, journal, writer, batchEdits, toolRuntime, observations, evidence, get refreshCount() { return refreshCount; } };
}

function latestTool(messages) { return [...messages].reverse().find((message) => message.role === 'tool')?.content ?? ''; }

function parseTarget(output) {
  const marker = 'REVISION-BOUND EDIT TARGETS';
  const offset = output.indexOf(marker);
  assert.notEqual(offset, -1, 'explore output should contain revision-bound targets');
  const start = output.indexOf('[', offset);
  assert.notEqual(start, -1);
  return JSON.parse(output.slice(start))[0];
}

test('original C1 tool loop explores, reads, prepares, applies, and validates without treating prepare as a mutation', async () => {
  const fx = await setup();
  let step = 0;
  let target;
  let batchId;
  const adapter = {
    async stream(messages, { onDelta, tools }) {
      assert.ok(tools.some((item) => item.function?.name === 'tst_edit_batch'));
      switch (step++) {
        case 0:
          return { toolCalls: [{ id: 'explore', name: 'tst_explore', arguments: JSON.stringify({ mode: 'search', query: 'Widget' }) }] };
        case 1:
          target = parseTarget(latestTool(messages));
          return { toolCalls: [{ id: 'read', name: 'tst_read', arguments: JSON.stringify({ targets: [target] }) }] };
        case 2:
          assert.match(latestTool(messages), /TARGET tst:/);
          return { toolCalls: [{ id: 'prepare', name: 'tst_edit_batch', arguments: JSON.stringify({ action: 'prepare', operations: [{ op: 'replace_node', target, content: 'export function Widget(){ return 2; }' }] }) }] };
        case 3: {
          const output = latestTool(messages);
          assert.match(output, /PREPARED \(no files written\)/);
          batchId = output.match(/batch_id: (batch_[^\n]+)/)?.[1];
          assert.ok(batchId);
          assert.equal(await readFile(join(fx.root, 'src/widget.js'), 'utf8'), 'export function Widget(){ return 1; }\n');
          return { toolCalls: [{ id: 'apply', name: 'tst_edit_batch', arguments: JSON.stringify({ action: 'apply', batch_id: batchId }) }] };
        }
        case 4:
          assert.match(latestTool(messages), /TST EDIT BATCH APPLIED/);
          return { toolCalls: [{ id: 'validate', name: 'tst_validate', arguments: JSON.stringify({ paths: ['src/widget.js'], commands: ['node --check src/widget.js'] }) }] };
        default:
          assert.match(latestTool(messages), /passed: true/);
          await onDelta('done');
          return { text: 'done', toolCalls: [] };
      }
    },
  };
  const pathEvents = [];
  const validations = [];
  try {
    const result = await fx.toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'Change Widget to return 2 and validate it.' }],
      sessionId: 'session', projectId: 'project', projectRoot: fx.root, mode: 'build', signal: new AbortController().signal,
      onDelta: async () => {},
      onPaths: async (paths, mutation, details) => pathEvents.push({ paths, mutation, details: details ?? null }),
      onValidation: async (validation) => validations.push(validation),
    });
    assert.equal(result.toolSteps, 5);
    assert.equal(await readFile(join(fx.root, 'src/widget.js'), 'utf8'), 'export function Widget(){ return 2; }\n');
    assert.equal(fx.refreshCount, 1, 'batch apply owns exactly one graph refresh barrier');
    assert.equal(pathEvents.some((event) => event.mutation && event.details?.graphHandled === true), true);
    assert.equal(pathEvents.some((event) => event.details?.prepared === true), false, 'prepare publishes no path/mutation event');
    assert.equal(fx.observations.filter((item) => item.observation?.key?.startsWith('action:tst_edit_batch:')).length, 1, 'only apply becomes a durable TST action observation');
    assert.equal(validations.length, 1);
    assert.equal(validations[0].success, true);
    assert.equal(validations[0].fileHashes['src/widget.js'], sha256(await readFile(join(fx.root, 'src/widget.js'))));
    const status = await fx.journal.status('session');
    assert.equal(status.latest?.kind, 'batch');
    assert.equal(fx.db.listToolExecutions('session').length, 5);
  } finally {
    fx.db.close();
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('original C1 treats an omitted graph-refresh receipt as stale after a successful write', async () => {
  const fx = await setup({ omitRefreshPath: true });
  try {
    const raw = await readFile(join(fx.root, 'src/widget.js'));
    const expected = raw.toString('utf8').trimEnd();
    const target = {
      target_id: `tst:${'1'.repeat(32)}`,
      path: 'src/widget.js', language: 'javascript', symbol: 'Widget', kind: 'function_declaration',
      base_hash: sha256(raw), start_byte: 0, end_byte: Buffer.byteLength(expected), start_row: 0, start_column: 0, end_row: 0, end_column: Buffer.byteLength(expected), expected_source: expected,
    };
    const prepared = await fx.batchEdits.prepare({ sessionId: 'session', projectRoot: fx.root, operations: [{ op: 'replace_node', target, content: 'export function Widget(){ return 3; }' }] });
    const applied = await fx.batchEdits.apply({ batchId: prepared.id, sessionId: 'session', projectRoot: fx.root, executionId: 'tool_apply', authorize: async () => ({ allowed: true }) });
    assert.equal(applied.applied, true);
    assert.equal(applied.graphReady, false);
    assert.match(applied.graphError ?? '', /different post-edit hashes/);
    await assert.rejects(() => fx.batchEdits.prepare({ sessionId: 'session', projectRoot: fx.root, operations: [{ op: 'replace_text', path: 'src/widget.js', old_text: '3', new_text: '4' }] }), /graph refresh is required/i);
  } finally {
    fx.db.close();
    await rm(fx.dir, { recursive: true, force: true });
  }
});
