import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { PermissionBroker } from '../src/runtime/permissions.mjs';
import { ToolRuntime, runShell } from '../src/runtime/tool-runtime.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';

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

test('runShell returns after the parent exits even when a background descendant keeps stdio open', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-shell-inherited-stdio-'));
  let orphanPid = null;
  try {
    const childScript = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); console.log('child-pid=' + child.pid); child.unref();";
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(childScript)}`;
    const started = Date.now();
    const result = await runShell(command, dir, 3000, new AbortController().signal);
    const elapsed = Date.now() - started;
    const match = result.stdout.match(/child-pid=(\d+)/);
    orphanPid = match ? Number(match[1]) : null;
    assert.equal(result.code, 0);
    assert.ok(elapsed < 2000, `expected inherited-stdio command to return promptly; took ${elapsed}ms`);
    assert.ok(orphanPid > 0);
  } finally {
    if (orphanPid) { try { process.kill(orphanPid, 'SIGKILL'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test('background_process starts, reads logs, and stops a long-lived project server without blocking the turn', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  try {
    broker.setAuto('s1', 'full');
    let processId = '';
    let step = 0;
    const adapter = {
      async stream(messages, { tools }) {
        assert.ok(tools.some((entry) => entry.function?.name === 'background_process'));
        step += 1;
        if (step === 1) {
          const script = "console.log('server-ready'); setInterval(() => {}, 1000);";
          return { text: '', toolCalls: [{ id: 'call_start', name: 'background_process', arguments: JSON.stringify({ action: 'start', command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`, label: 'test-server' }) }], usage: null };
        }
        const latest = [...messages].reverse().find((message) => message.role === 'tool');
        if (step === 2) {
          assert.match(latest?.content ?? '', /BACKGROUND PROCESS STARTED/);
          processId = latest.content.match(/process_id: (process_[^\s]+)/)?.[1] ?? '';
          assert.ok(processId);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { text: '', toolCalls: [{ id: 'call_logs', name: 'background_process', arguments: JSON.stringify({ action: 'logs', process_id: processId }) }], usage: null };
        }
        if (step === 3) {
          assert.match(latest?.content ?? '', /status: running/);
          assert.match(latest?.content ?? '', /server-ready/);
          return { text: '', toolCalls: [{ id: 'call_stop', name: 'background_process', arguments: JSON.stringify({ action: 'stop', process_id: processId }) }], usage: null };
        }
        assert.match(latest?.content ?? '', /BACKGROUND PROCESS STOPPED/);
        assert.match(latest?.content ?? '', /status: exited/);
        return { text: 'server lifecycle complete', toolCalls: [], usage: null };
      },
    };
    const started = Date.now();
    const result = await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'run the dev server in the background' }], sessionId: 's1', projectId: 'p1', projectRoot: root, mode: 'build', signal: new AbortController().signal, onDelta: async () => {} });
    assert.equal(result.toolSteps, 3);
    assert.ok(Date.now() - started < 5000);
    assert.equal(db.listToolExecutions('s1').every((execution) => execution.status === 'complete'), true);
  } finally {
    await toolRuntime.close();
    broker.close(); db.close(); await rm(dir, { recursive: true, force: true });
  }
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

test('tool execution preserves project context in RuntimeTstManager across detached callbacks', async () => {
  class FakeProjectManager {
    configured = true;
    status = { configured: true };
    forProjectCalls = [];
    async forProject(projectId, projectRoot) {
      this.forProjectCalls.push({ projectId, projectRoot });
      return {
        graphWorkspace: async (limit) => ({ limit, projectRoot, files: [] }),
        call: async () => ({}),
        supports: async () => true,
      };
    }
    async bindSession() {}
    async close() {}
  }
  const fakeManager = new FakeProjectManager();
  const tst = new RuntimeTstManager({ manager: fakeManager });
  const { dir, root, db, broker, toolRuntime } = await fixture({ tst });
  try {
    const adapter = {
      async stream(messages, { executeTool }) {
        // Simulate an asynchronous event loop callback (like socket data / external process I/O)
        // by executing in a separate setTimeout tick where AsyncLocalStorage is lost if not re-bound
        return new Promise((resolve, reject) => {
          setTimeout(async () => {
            try {
              const result = await executeTool({
                id: 'call_explore',
                name: 'tst_explore',
                arguments: '{"mode":"workspace","limit":50}',
              });
              assert.equal(result.success, true);
              assert.match(result.output, /UNTRUSTED CUPPET CODE GRAPH RESULTS/);
              resolve({ text: 'exploration done', toolCalls: [], usage: null });
            } catch (err) {
              reject(err);
            }
          }, 10);
        });
      },
    };
    const result = await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'explore the workspace' }],
      sessionId: 's1',
      projectId: 'p1',
      projectRoot: root,
      mode: 'build',
      signal: new AbortController().signal,
      onDelta: async () => {},
    });
    assert.equal(result.toolSteps, 1);
    assert.equal(fakeManager.forProjectCalls.length, 1);
    assert.equal(fakeManager.forProjectCalls[0].projectId, 'p1');
    assert.equal(fakeManager.forProjectCalls[0].projectRoot, root);
  } finally {
    await toolRuntime.close();
    broker.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('tst_explore and cuppet_memory_search return clean messages when session has no project', async () => {
  const { dir, db, broker, toolRuntime } = await fixture({ tst: { configured: true } });
  try {
    db.createSession({ id: 'general-session', projectId: null });
    const adapter = scriptedAdapter([
      {
        toolCalls: [
          { id: 'call_exp', name: 'tst_explore', arguments: '{"mode":"workspace"}' },
          { id: 'call_mem', name: 'cuppet_memory_search', arguments: '{"query":"auth"}' },
        ],
      },
      {
        delta: 'done',
        assertMessages(messages) {
          const outputs = messages.filter((m) => m.role === 'tool').map((m) => m.content);
          assert.match(outputs[0], /requires a project-bound chat/);
          assert.match(outputs[1], /requires a project-bound chat/);
        },
      },
    ]);
    const result = await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'check workspace' }],
      sessionId: 'general-session',
      projectId: null,
      projectRoot: null,
      mode: 'build',
      signal: new AbortController().signal,
      onDelta: async () => {},
    });
    assert.equal(result.toolSteps, 2);
  } finally {
    await toolRuntime.close();
    broker.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace_edit accepts lenient aliases for oldText and newText', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  try {
    broker.setAuto('s1', true);
    await writeFile(join(root, 'src', 'greet.js'), 'const greeting = "hello";\n');
    const adapter = scriptedAdapter([
      {
        toolCalls: [
          {
            id: 'call_edit',
            name: 'workspace_edit',
            arguments: '{"path":"src/greet.js","oldText":"\\"hello\\"","newText":"\\"world\\""}',
          },
        ],
      },
      {
        delta: 'done',
        assertMessages(messages) {
          const tool = messages.find((m) => m.role === 'tool');
          assert.match(tool.content, /Edited src\/greet\.js/);
        },
      },
    ]);
    await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'update greeting' }],
      sessionId: 's1',
      projectId: 'p1',
      projectRoot: root,
      mode: 'build',
      signal: new AbortController().signal,
      onDelta: async () => {},
    });
    assert.equal(await readFile(join(root, 'src', 'greet.js'), 'utf8'), 'const greeting = "world";\n');
  } finally {
    await toolRuntime.close();
    broker.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('tst_explore search suppresses unsupported edit targets error banner', async () => {
  const fakeTst = {
    configured: true,
    async graphLocate(query) {
      return { query, matches: [{ path: 'src/app.js', line: 1, column: 1, kind: 'function', symbol: 'main' }] };
    },
  };
  const fakeBatchEdits = {
    async resolveTargets() {
      throw new Error('Connected TST daemon does not support revision-bound edit targets.');
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-c1-tools-'));
  const root = join(dir, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  db.createProject({ id: 'p1', name: 'Project', canonicalPath: root });
  db.createSession({ id: 's1', projectId: 'p1' });
  const broker = new PermissionBroker();
  const toolRuntime = new ToolRuntime({
    tst: fakeTst,
    batchEdits: fakeBatchEdits,
    planStore: { async toolResult() { return null; } },
    permissions: broker,
    db,
  });
  try {
    const adapter = scriptedAdapter([
      {
        toolCalls: [
          { id: 'call_search', name: 'tst_explore', arguments: '{"mode":"search","query":"main"}' },
        ],
      },
      {
        delta: 'done',
        assertMessages(messages) {
          const tool = messages.find((m) => m.role === 'tool');
          assert.match(tool.content, /UNTRUSTED CUPPET CODE GRAPH RESULTS/);
          assert.match(tool.content, /Locate main: 1 match/);
          assert.doesNotMatch(tool.content, /EDIT TARGETS unavailable/);
        },
      },
    ]);
    await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'locate main' }],
      sessionId: 's1',
      projectId: 'p1',
      projectRoot: root,
      mode: 'build',
      signal: new AbortController().signal,
      onDelta: async () => {},
    });
  } finally {
    await toolRuntime.close();
    broker.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('session in full access mode runs bash with fullAccess policy enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-tool-fullaccess-'));
  const root = join(dir, 'project');
  await mkdir(root, { recursive: true });
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  db.createProject({ id: 'p1', name: 'Project', canonicalPath: root });
  db.createSession({ id: 's1', projectId: 'p1' });
  const broker = new PermissionBroker();
  broker.setAuto('s1', 'full');

  let executedPolicy = null;
  const mockSandbox = {
    async execute(command, cwd, policy, options) {
      executedPolicy = policy;
      return { code: 0, stdout: 'ok', stderr: '', driverName: 'mock' };
    },
  };

  const toolRuntime = new ToolRuntime({
    tst: { configured: false },
    planStore: { async toolResult() { return null; } },
    permissions: broker,
    db,
    sandboxManager: mockSandbox,
  });

  try {
    const adapter = scriptedAdapter([
      {
        toolCalls: [
          { id: 'call_bash', name: 'bash', arguments: '{"command":"git push origin main"}' },
        ],
      },
      {
        delta: 'done',
        assertMessages(messages) {
          const tool = messages.find((m) => m.role === 'tool');
          assert.match(tool.content, /stdout:\nok/);
        },
      },
    ]);

    await toolRuntime.run({
      adapter,
      messages: [{ role: 'user', content: 'push commits' }],
      sessionId: 's1',
      projectId: 'p1',
      projectRoot: root,
      mode: 'build',
      signal: new AbortController().signal,
      onDelta: async () => {},
    });

    assert.equal(executedPolicy?.fullAccess, true);
    assert.equal(executedPolicy?.protectSensitiveCredentials, false);
  } finally {
    await toolRuntime.close();
    broker.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});



