import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RuntimeService } from '../src/runtime/service.mjs';
import { McpServerManager } from '../src/runtime/mcp-manager.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
const environmentOptions = { loginPathProbe: () => process.env.PATH ?? '' };

const definition = (name) => ({ type: 'function', function: { name, description: 'Stub MCP tool', parameters: { type: 'object', properties: {} } } });

/** A counting stand-in for McpServerManager, so a test can prove a denied call never reached the server. */
function stubMcp() {
  const calls = [];
  const known = { 'mcp__stub__lookup': true, 'mcp__stub__create': false };
  return {
    calls,
    hasServers: () => true,
    async ready() {},
    status: () => [{ id: 'stub', name: 'stub', state: 'ready', message: '', toolCount: 2, tools: [] }],
    definitions: () => Object.keys(known).map(definition),
    has: (name) => name in known,
    describe: (name) => (name in known ? { serverId: 'stub', serverName: 'stub', toolName: name.split('__')[2], readOnly: known[name] } : null),
    async call(name, args) { calls.push({ name, args }); return { output: `ok:${name}`, contentItems: [] }; },
    async close() {},
  };
}

/** Each step issues the next scripted tool call; the final step ends the turn. Records what the model saw. */
function scriptedProvider(script) {
  const seen = { tools: [], system: [], outputs: [] };
  const factory = () => {
    let step = 0;
    return {
      async stream(messages, { tools, onDelta }) {
        if (step === 0) {
          seen.tools = tools.map((tool) => tool.function?.name);
          seen.system = messages.filter((message) => message.role === 'system').map((message) => message.content);
        } else {
          seen.outputs.push(messages.at(-1).content);
        }
        if (step < script.length) {
          const { name, args } = script[step++];
          return { toolCalls: [{ id: `call${step}`, name, arguments: JSON.stringify(args) }] };
        }
        await onDelta('done');
        return { text: 'done' };
      },
    };
  };
  return { factory, seen };
}

async function harness(t, { mcp, script, onPermission = () => 'once' }) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-mcp-runtime-'));
  const events = [];
  const requests = [];
  const provider = scriptedProvider(script);
  let runtime;
  runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    emit: (event) => {
      events.push(event);
      if (event.type === 'permission.requested') {
        requests.push(event.request);
        queueMicrotask(() => runtime.handle('permission.reply', { requestId: event.request.id, reply: onPermission(event.request, requests.length) }));
      }
    },
    mcp,
    providerFactory: provider.factory,
  });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await runtime.handle('session.create');
  const send = async (text = 'use the tool') => {
    const accepted = await runtime.handle('session.send', { sessionId: session.id, text, provider: {} });
    for (let i = 0; i < 600; i += 1) {
      if (events.some((event) => event.type === 'run.finished' && event.messageId === accepted.messageId)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for the turn to finish');
  };
  return { runtime, session, events, requests, send, seen: provider.seen };
}

test('end to end: a real MCP server process is offered, approved, called, and its result reaches the model', async (t) => {
  const mcp = new McpServerManager({ clientOptions: { environmentOptions } });
  t.after(() => mcp.close());
  mcp.configure([{ id: 'fixture', name: 'fixture', command: process.execPath, args: [fixture], env: {}, enabled: true }]);
  const { send, seen, requests, events } = await harness(t, { mcp, script: [{ name: 'mcp__fixture__echo', args: { text: 'hello' } }] });
  await send();

  assert.ok(seen.tools.includes('mcp__fixture__echo'), 'MCP tools are offered to the model');
  assert.ok(seen.tools.includes('mcp__fixture__write_note'));
  const context = seen.system.find((content) => content.includes('name="mcp"'));
  assert.match(context, /"fixture" \(\d+ tools?\)/);
  assert.match(context, /untrusted data/);

  assert.equal(requests.length, 1, 'an MCP call is always asked about');
  assert.equal(requests[0].action, 'mcp-read', 'the fixture declares echo as read-only');
  const shown = requests[0].resources.join('\n');
  assert.match(shown, /MCP server "fixture" · tool "echo"/);
  assert.match(shown, /"text": "hello"/, 'the approval shows the complete arguments');
  assert.deepEqual(seen.outputs, ['echo:hello']);
  assert.ok(events.some((event) => event.type === 'tool.finished' && event.tool === 'mcp__fixture__echo' && event.success === true));
});

test('a tool that is not declared read-only is requested as mcp-tool, and rejecting it means the server is never called', async (t) => {
  const mcp = stubMcp();
  const { send, seen, requests } = await harness(t, { mcp, script: [{ name: 'mcp__stub__create', args: { title: 'x' } }], onPermission: () => 'reject' });
  await send();
  assert.equal(requests[0].action, 'mcp-tool');
  assert.deepEqual(mcp.calls, []);
  assert.match(seen.outputs[0], /^Permission denied/);
});

test('approving once allows exactly one call; "always" repeats only for identical arguments', async (t) => {
  const mcp = stubMcp();
  const replies = ['once', 'always', 'reject'];
  const { send, requests } = await harness(t, {
    mcp,
    script: [
      { name: 'mcp__stub__create', args: { title: 'a' } },
      { name: 'mcp__stub__create', args: { title: 'b' } },
      { name: 'mcp__stub__create', args: { title: 'b' } },
      { name: 'mcp__stub__create', args: { title: 'c' } },
    ],
    onPermission: () => replies.shift() ?? 'reject',
  });
  await send();
  assert.equal(requests.length, 3, 'the repeat of the always-approved arguments did not prompt again');
  assert.deepEqual(mcp.calls.map((call) => call.args.title), ['a', 'b', 'b'], 'changed arguments ("c") were asked about and rejected');
});

test('plan mode refuses non-read-only MCP tools without asking, but read-only ones still ask', async (t) => {
  const mcp = stubMcp();
  const { runtime, session, send, requests, seen } = await harness(t, {
    mcp,
    script: [{ name: 'mcp__stub__create', args: {} }, { name: 'mcp__stub__lookup', args: { q: 1 } }],
  });
  await runtime.handle('session.mode.set', { sessionId: session.id, mode: 'plan' });
  await send();
  assert.match(seen.outputs[0], /^Permission denied/, 'the write-capable tool is blocked');
  assert.deepEqual(requests.map((request) => request.action), ['mcp-read'], 'only the read-only tool produced a prompt');
  assert.deepEqual(mcp.calls.map((call) => call.name), ['mcp__stub__lookup']);
});

test('arguments too large to show in full are refused rather than approved blind', async (t) => {
  const mcp = stubMcp();
  const { send, seen, requests } = await harness(t, { mcp, script: [{ name: 'mcp__stub__lookup', args: { blob: 'x'.repeat(20_000) } }] });
  await send();
  assert.equal(requests.length, 0);
  assert.deepEqual(mcp.calls, []);
  assert.match(seen.outputs[0], /^Permission denied/);
});

test('without enabled servers no MCP tools or context are offered', async (t) => {
  const mcp = new McpServerManager({ clientOptions: { environmentOptions } });
  t.after(() => mcp.close());
  mcp.configure([{ id: 'off', name: 'off', command: process.execPath, args: [fixture], env: {}, enabled: false }]);
  const { send, seen } = await harness(t, { mcp, script: [] });
  await send();
  assert.equal(seen.tools.some((name) => name.startsWith('mcp__')), false);
  assert.equal(seen.system.some((content) => content.includes('name="mcp"')), false);
});

test('a runtime with no MCP manager behaves exactly as before', async (t) => {
  const { send, seen } = await harness(t, { mcp: null, script: [] });
  await send();
  assert.equal(seen.tools.some((name) => name.startsWith('mcp__')), false);
});

test('a server that is still starting does not hold the turn hostage forever, and its tools arrive once ready', async (t) => {
  const mcp = new McpServerManager({ clientOptions: { environmentOptions } });
  t.after(() => mcp.close());
  mcp.configure([{ id: 'late', name: 'late', command: process.execPath, args: [fixture], env: {}, enabled: true }]);
  // No explicit ready(): the turn itself waits for the server, then offers its tools.
  const { send, seen } = await harness(t, { mcp, script: [] });
  await send();
  assert.ok(seen.tools.includes('mcp__late__echo'));
});
