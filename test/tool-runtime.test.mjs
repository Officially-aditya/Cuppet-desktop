import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
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

test('git_push exposes and forwards a nested repository path to repository-bound approval', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const { dir, root, db, broker } = await fixture();
  try {
    await mkdir(join(root, 'packages', 'app', 'src'), { recursive: true });
    const repositoryRoot = await realpath(join(root, 'packages', 'app'));
    const commit = 'a'.repeat(40);
    let request;
    const toolRuntime = new ToolRuntime({
      tst: { configured: false }, planStore: { async toolResult() { return null; } }, db, dataDir: dir,
      permissions: { async authorize(value) { request = value; throw new Error('Test approval blocked'); } },
      sandboxManager: { async execute(command) {
        assert.doesNotMatch(command, /'bundle'/);
        return { code: 0, stdout: command.includes("'--show-toplevel'") ? repositoryRoot : command.includes("'rev-parse'") ? commit : 'https://github.com/example/project.git' };
      } },
    });
    const definition = toolRuntime.definitions({ projectRoot: root }).find((tool) => tool.function.name === 'git_push');
    assert.equal(definition.function.parameters.properties.repository_path.type, 'string');
    assert.equal(definition.function.parameters.required.includes('repository_path'), false);
    const adapter = scriptedAdapter([
      { toolCalls: [{ id: 'call_push', name: 'git_push', arguments: JSON.stringify({ repository_path: 'packages/app/src', remote: 'origin', branch: 'main', commit }) }] },
      { assertMessages(messages) { assert.match(messages.at(-1).content, /Test approval blocked/); } },
    ]);
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'push the nested repository' }], sessionId: 's1', projectId: 'p1', projectRoot: root, mode: 'build', signal: new AbortController().signal, onDelta: async () => {} });
    assert.equal(request.projectRoot, root);
    assert.deepEqual(request.resources, [repositoryRoot, 'origin', 'https://github.com/example/project.git', 'main', commit]);
  } finally { broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

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

test('long turns keep executing tools beyond 64 calls through dynamic and returned tool bridges', async (t) => {
  for (const dynamic of [true, false]) {
    await t.test(dynamic ? 'dynamic tools' : 'returned tool calls', async () => {
      const { dir, root, db, broker, toolRuntime } = await fixture();
      try {
        const call = (index) => ({ id: `long_${index}`, name: 'cuppet_plan', arguments: '{}' });
        let index = 0;
        const adapter = {
          async stream(messages, { executeTool }) {
            if (dynamic) {
              for (; index < 80; index++) {
                const result = await executeTool(call(index));
                assert.equal(result.success, true);
              }
            } else if (index < 80) {
              if (index > 0) assert.equal(messages.at(-1).role, 'tool');
              return { text: '', toolCalls: [call(index++)] };
            }
            return { text: 'done', toolCalls: [] };
          },
        };
        const result = await toolRuntime.run({
          adapter, messages: [], sessionId: 's1', projectId: 'p1', projectRoot: root,
          signal: new AbortController().signal, onDelta: async () => {},
        });
        assert.equal(result.toolSteps, 80);
        assert.equal(db.listToolExecutions('s1').length, 80);
        assert.ok(db.listToolExecutions('s1').every((execution) => execution.status === 'complete'));
      } finally {
        await toolRuntime.close();
        broker.close(); db.close(); await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('long returned-tool turns still stop when the user aborts', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  const controller = new AbortController();
  let calls = 0;
  try {
    const adapter = {
      async stream() {
        calls += 1;
        if (calls === 80) controller.abort();
        return { text: '', toolCalls: [{ id: `abort_${calls}`, name: 'cuppet_plan', arguments: '{}' }] };
      },
    };
    await assert.rejects(toolRuntime.run({
      adapter, messages: [], sessionId: 's1', projectId: 'p1', projectRoot: root,
      signal: controller.signal, onDelta: async () => {},
    }), (error) => error?.name === 'AbortError');
    assert.equal(calls, 80);
  } finally {
    await toolRuntime.close();
    broker.close(); db.close(); await rm(dir, { recursive: true, force: true });
  }
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
          await new Promise((resolve) => setTimeout(resolve, process.platform === 'win32' ? 900 : 400));
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
    broker.close(); db.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function shellQuote(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replaceAll('"', '""')}"`;
  }
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

test('memory tool searches durable user history and pages exact text without TST', async () => {
  const { dir, db, broker, toolRuntime } = await fixture();
  try {
    db.createSession({ id: 'history-chat' });
    const content = `${'first-page '.repeat(1500)}tail-marker: preserve the original requirement`;
    db.appendMessage({ id: 'old-user', sessionId: 'history-chat', role: 'user', content });
    db.appendMessage({ id: 'old-assistant', sessionId: 'history-chat', role: 'assistant', content: 'assistant-only-result' });
    db.appendMessage({ id: 'recent-user', sessionId: 'history-chat', role: 'user', content: 'Continue the task' });
    const parse = (messages) => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n')).messages;
    const adapter = scriptedAdapter([
      { assertMessages(messages) { assert.doesNotMatch(JSON.stringify(messages), /tail-marker/); }, toolCalls: [{ id: 'search', name: 'cuppet_memory_search', arguments: '{"source":"messages","query":"tail-marker"}' }] },
      { assertMessages(messages) {
        const [record] = parse(messages);
        assert.equal(record.message_id, 'old-user');
        assert.match(record.content, /tail-marker/);
        assert.equal(record.characters, content.length);
        assert.ok(record.offset > 12000, 'search snippets must include matches beyond the stored TST preview');
      }, toolCalls: [{ id: 'read', name: 'cuppet_memory_search', arguments: '{"message_id":"old-user","max_chars":12000}' }] },
      { assertMessages(messages) {
        const [record] = parse(messages);
        assert.equal(record.content, content.slice(0, 12000));
        assert.equal(record.next_offset, 12000);
      }, toolCalls: [{ id: 'continue', name: 'cuppet_memory_search', arguments: '{"source":"messages","message_id":"old-user","offset":12000,"max_chars":12000}' }] },
      { assertMessages(messages) {
        const [record] = parse(messages);
        assert.equal(record.content, content.slice(12000));
        assert.equal(record.next_offset, null);
      }, toolCalls: [{ id: 'list', name: 'cuppet_memory_search', arguments: '{"source":"messages","limit":1}' }] },
      { delta: 'Retrieved the original request.', assertMessages(messages) { assert.deepEqual(parse(messages).map((message) => message.message_id), ['recent-user']); } },
    ]);
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'Check my earlier requirement' }], sessionId: 'history-chat', mode: 'build', signal: new AbortController().signal, onDelta: async () => {} });
    assert.equal(db.listToolExecutions('history-chat').every((execution) => execution.status === 'complete'), true);
  } finally { await toolRuntime.close(); broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('memory user-message search matches separated keywords and explains genuine misses', async () => {
  const { dir, db, broker, toolRuntime } = await fixture();
  try {
    db.createSession({ id: 'keyword-chat' });
    const content = `${'earlier context '.repeat(100)}Release the app only after\nrollback checks pass.`;
    db.appendMessage({ id: 'keyword-user', sessionId: 'keyword-chat', role: 'user', content });
    db.appendMessage({ id: 'keyword-assistant', sessionId: 'keyword-chat', role: 'assistant', content: 'release rollback missing-marker' });
    db.appendMessage({ id: 'recent-user', sessionId: 'keyword-chat', role: 'user', content: 'Continue the task' });
    const queries = ['rollback release', 'RELEASE   rollback', 'release,\n rollback', 'release checks pass'];
    const adapter = {
      async stream(_messages, { executeTool }) {
        for (const [index, query] of [...queries, 'missing-marker', '  '].entries()) {
          const result = await executeTool({ id: `keywords-${index}`, name: 'cuppet_memory_search', arguments: JSON.stringify({ source: 'messages', query, limit: 1 }) });
          assert.equal(result.success, true);
          const payload = JSON.parse(result.output.split('\n').slice(1).join('\n'));
          if (index < queries.length) {
            assert.deepEqual(payload.messages.map((message) => message.message_id), ['keyword-user'], query);
            const [record] = payload.messages;
            assert.match(record.content, /Release the app only after\nrollback checks pass/);
            assert.ok(record.offset > 600, 'the snippet must start near the matching keywords');
            assert.equal(record.content, content.slice(record.offset, record.offset + 600));
          } else if (query === 'missing-marker') {
            assert.deepEqual(payload.messages, []);
            assert.match(payload.hint, /fewer keywords|omit query/i);
          } else {
            assert.deepEqual(payload.messages.map((message) => message.message_id), ['recent-user']);
          }
        }
        return { text: '', toolCalls: [] };
      },
    };
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'Find the earlier requirement' }], sessionId: 'keyword-chat', signal: new AbortController().signal, onDelta: async () => {} });
  } finally { await toolRuntime.close(); broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('message retrieval cannot read another chat or assistant messages', async () => {
  const { dir, root, db, broker, toolRuntime } = await fixture();
  try {
    db.createSession({ id: 'other-chat', projectId: 'p1' });
    db.appendMessage({ id: 'private-user', sessionId: 'other-chat', role: 'user', content: 'private-cross-session-content' });
    db.appendMessage({ id: 'assistant-id', sessionId: 's1', role: 'assistant', content: 'assistant-only-result', now: 50 });
    const adapter = scriptedAdapter([
      { toolCalls: [
        { id: 'cross-session', name: 'cuppet_memory_search', arguments: '{"message_id":"private-user"}' },
        { id: 'wrong-role', name: 'cuppet_memory_search', arguments: '{"message_id":"assistant-id"}' },
        { id: 'search-private', name: 'cuppet_memory_search', arguments: '{"source":"messages","query":"private-cross-session-content"}' },
      ] },
      { assertMessages(messages) {
        const outputs = messages.filter((message) => message.role === 'tool').map((message) => message.content);
        assert.match(outputs[0], /Message not found in this chat/);
        const activity = JSON.parse(outputs[1].split('\n').slice(1).join('\n'));
        assert.equal(activity.message.message_id, 'assistant-id');
        assert.deepEqual(activity.tools, []);
        assert.doesNotMatch(outputs.join('\n'), /private-cross-session-content|assistant-only-result/);
        assert.deepEqual(JSON.parse(outputs[2].split('\n').slice(1).join('\n')).messages, []);
      } },
    ]);
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'Search history' }], sessionId: 's1', projectRoot: root, mode: 'plan', signal: new AbortController().signal, onDelta: async () => {} });
    assert.deepEqual(Object.fromEntries(db.listToolExecutions('s1').map((execution) => [execution.callId, execution.status])), { 'cross-session': 'error', 'wrong-role': 'complete', 'search-private': 'complete' });
  } finally { await toolRuntime.close(); broker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
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



