import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { PermissionBroker } from '../src/runtime/permissions.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';

async function fixture({ tst } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-c1-tools-'));
  const root = join(dir, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  db.createProject({ id: 'p1', name: 'Project', canonicalPath: root });
  db.createSession({ id: 's1', projectId: 'p1' });
  const broker = new PermissionBroker();
  const toolRuntime = new ToolRuntime({
    tst: tst ?? { configured: false },
    planStore: { async toolResult() { return null; } },
    permissions: broker,
    db,
  });
  return { dir, root, db, broker, toolRuntime };
}

function scriptedAdapter(steps) {
  let index = 0;
  return {
    async stream(messages, { onDelta, tools }) {
      assert.equal(Array.isArray(tools), true);
      const step = steps[index++];
      if (!step) throw new Error('unexpected provider step');
      if (step.assertMessages) step.assertMessages(messages);
      if (step.delta) await onDelta(step.delta);
      return { text: step.delta ?? '', toolCalls: step.toolCalls ?? [], usage: null };
    },
  };
}

test('workspace write executes under guarded auto, persists audit, and reports PE3 mutation paths', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  try {
    broker.setAuto('s1', true);
    const observed = [];
    const adapter = scriptedAdapter([
      { toolCalls: [{ id: 'call_write', name: 'workspace_write', arguments: '{"path":"src/generated.js","content":"export const generated = true;\\n"}' }] },
      {
        delta: 'done',
        assertMessages(messages) {
          const tool = [...messages].reverse().find((message) => message.role === 'tool');
          assert.match(tool?.content ?? '', /Wrote \d+ bytes to src\/generated\.js/);
        },
      },
    ]);
    const deltas = [];
    const result = await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'create the generated file' }],
      sessionId: 's1', projectId: 'p1', projectRoot: root, mode: 'build', signal: new AbortController().signal,
      onDelta: async (delta) => deltas.push(delta),
      onPaths: async (paths, mutation) => observed.push({ paths, mutation }),
    });
    assert.equal(result.toolSteps, 1);
    assert.deepEqual(deltas, ['done']);
    assert.equal(await readFile(join(root, 'src', 'generated.js'), 'utf8'), 'export const generated = true;\n');
    assert.deepEqual(observed, [{ paths: ['src/generated.js'], mutation: true }]);
    const executions = db.listToolExecutions('s1');
    assert.equal(executions.length, 1);
    assert.equal(executions[0].toolName, 'workspace_write');
    assert.equal(executions[0].status, 'complete');
    assert.equal(executions[0].permissionSource, 'session-auto');
  } finally { broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('plan mode rejects mutation without touching the filesystem but still returns a tool result to the model', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  try {
    broker.setAuto('s1', true);
    const adapter = scriptedAdapter([
      { toolCalls: [{ id: 'call_write', name: 'workspace_write', arguments: '{"path":"src/blocked.js","content":"nope"}' }] },
      {
        delta: 'planned safely',
        assertMessages(messages) {
          const tool = [...messages].reverse().find((message) => message.role === 'tool');
          assert.match(tool?.content ?? '', /Permission denied: Plan mode is read-only/);
        },
      },
    ]);
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'plan this change' }], sessionId: 's1', projectId: 'p1', projectRoot: root, mode: 'plan', signal: new AbortController().signal, onDelta: async () => {} });
    await assert.rejects(access(join(root, 'src', 'blocked.js')));
    const execution = db.listToolExecutions('s1')[0];
    assert.equal(execution.status, 'rejected');
    assert.equal(execution.permissionSource, 'none');
  } finally { broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('identical TST exploration calls are cached per session and do not repeat daemon work', async () => {
  let calls = 0;
  const tst = {
    configured: true,
    async graphLocate(query, prefix, limit) {
      calls++;
      assert.equal(query, 'Widget');
      assert.equal(prefix, 'src');
      assert.equal(limit, 12);
      return { query, matches: [{ path: 'src/widget.js', line: 3, column: 1, kind: 'symbol', symbol: 'Widget' }], truncated: false };
    },
    async observeMemory() { return {}; },
  };
  const { dir, root, db, broker, toolRuntime } = await fixture({ tst });
  try {
    const args = '{"mode":"search","query":"Widget","prefix":"src","limit":12}';
    const adapter = scriptedAdapter([
      { toolCalls: [
        { id: 'call_a', name: 'tst_explore', arguments: args },
        { id: 'call_b', name: 'tst_explore', arguments: args },
      ] },
      {
        delta: 'found it',
        assertMessages(messages) {
          const outputs = messages.filter((message) => message.role === 'tool').map((message) => message.content);
          assert.match(outputs[0], /src\/widget\.js:3:1/);
          assert.match(outputs[1], /identical search result was already returned/);
        },
      },
    ]);
    const observed = [];
    const result = await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'find Widget' }], sessionId: 's1', projectId: 'p1', projectRoot: root, mode: 'build', signal: new AbortController().signal, onDelta: async () => {}, onPaths: async (paths, mutation) => observed.push({ paths, mutation }) });
    assert.equal(result.toolSteps, 2);
    assert.equal(calls, 1);
    assert.equal(db.listToolExecutions('s1').every((execution) => execution.status === 'complete'), true);
    assert.deepEqual(observed, [
      { paths: ['src/widget.js'], mutation: false },
      { paths: ['src/widget.js'], mutation: false },
    ]);
  } finally { broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});