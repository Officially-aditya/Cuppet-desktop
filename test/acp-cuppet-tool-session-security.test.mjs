import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'node:net';
import { CuppetMcpToolSession } from '../src/runtime/providers/transports/acp/cuppet-mcp-tool-session.mjs';
import steeringPlugin from '../src/runtime/providers/opencode-steering/index.js';

const definition = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

function descriptorEnv(descriptor, name) {
  return descriptor.env.find((item) => item.name === name)?.value ?? '';
}

function bridgeClient(endpoint) {
  const socket = createConnection(endpoint);
  socket.setEncoding('utf8');
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const wait = pending.get(message.id);
      if (!wait) continue;
      pending.delete(message.id);
      message.error ? wait.reject(new Error(message.error.message)) : wait.resolve(message.result);
    }
  });
  socket.on('error', (error) => {
    for (const wait of pending.values()) wait.reject(error);
    pending.clear();
  });
  socket.on('close', () => {
    for (const wait of pending.values()) wait.reject(new Error('bridge closed'));
    pending.clear();
    closedResolve();
  });
  return {
    socket,
    closed,
    request(method, params = {}, extra = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params, ...extra })}\n`);
      });
    },
  };
}

test('Cuppet ACP tool session rejects an invalid bridge token', async () => {
  const session = new CuppetMcpToolSession({ sessionId: 'chat-security-1', backendId: 'opencode' });
  await session.start();
  let executed = false;
  session.setTurn({ tools: [definition('cuppet_plan')], executeTool: async () => { executed = true; return { success: true, output: 'unexpected' }; } });
  const descriptor = session.descriptor();
  const endpoint = descriptorEnv(descriptor, 'CUPPET_MCP_BRIDGE_ENDPOINT');
  const client = bridgeClient(endpoint);
  try {
    await assert.rejects(() => client.request('hello', {}, { token: 'definitely-wrong-token' }), /authentication failed|bridge closed/i);
    await client.closed;
    assert.equal(executed, false);
  } finally {
    client.socket.destroy();
    await session.close();
  }
});

test('Cuppet ACP tool authority disappears when the scoped tool session closes', async () => {
  const session = new CuppetMcpToolSession({ sessionId: 'chat-security-2', backendId: 'opencode' });
  await session.start();
  const calls = [];
  session.setTurn({
    tools: [definition('cuppet_plan')],
    executeTool: async (call) => { calls.push(call); return { success: true, output: 'scoped-result' }; },
  });
  const descriptor = session.descriptor();
  const endpoint = descriptorEnv(descriptor, 'CUPPET_MCP_BRIDGE_ENDPOINT');
  const token = descriptorEnv(descriptor, 'CUPPET_MCP_BRIDGE_TOKEN');
  const client = bridgeClient(endpoint);
  try {
    await client.request('hello', {}, { token });
    const listed = await client.request('tools/list');
    assert.deepEqual(listed.tools.map((item) => item.name), ['cuppet_plan']);
    const result = await client.request('tools/call', { name: 'cuppet_plan', arguments: { action: 'overview' } });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, 'scoped-result');
    assert.equal(calls.length, 1);

    await session.close();
    await client.closed;
    assert.equal(calls.length, 1);

    await assert.rejects(async () => {
      const stale = bridgeClient(endpoint);
      try {
        await stale.request('hello', {}, { token });
      } finally {
        stale.socket.destroy();
      }
    });
  } finally {
    client.socket.destroy();
    await session.close();
  }
});

test('warm native steering preserves its connection while revoking previous MCP clients and tokens', async () => {
  const session = new CuppetMcpToolSession({ sessionId: 'native-authority', backendId: 'opencode' });
  await session.start();
  session.setTurn({ tools: [definition('cuppet_plan')], executeTool: async () => ({ success: true, output: 'ok' }) });
  const descriptor = session.descriptor();
  const token = descriptorEnv(descriptor, 'CUPPET_MCP_BRIDGE_TOKEN');
  const endpoint = descriptor.steering.endpoint;
  assert.notEqual(descriptor.steering.token, token);
  const calls = [];
  const cleanup = await steeringPlugin.setup({ options: descriptor.steering, session: {
    async prompt(input) { calls.push(input); },
  } });
  const client = bridgeClient(endpoint);
  try {
    await client.request('hello', {}, { token });
    await assert.rejects(client.request('steering/register'), /Unsupported/);
    assert.equal(await session.steer({ sessionId: 'native-session', text: 'first' }), true);
    session.setTurn({ tools: [], executeTool: null });
    await client.closed;
    assert.equal(session.canSteer(), false);

    session.setTurn({ tools: [definition('cuppet_plan')], executeTool: async () => ({ success: true, output: 'next' }) });
    const stale = bridgeClient(endpoint);
    try { await assert.rejects(stale.request('hello', {}, { token }), /authentication failed|bridge closed/); }
    finally { stale.socket.destroy(); }
    assert.equal(await session.steer({ sessionId: 'next-session', text: 'second' }), true);
    assert.deepEqual(calls.map(({ sessionID, text, delivery }) => [sessionID, text, delivery]), [
      ['native-session', 'first', 'steer'], ['next-session', 'second', 'steer'],
    ]);
  } finally {
    cleanup();
    client.socket.destroy();
    await session.close();
  }
});

test('closing native steering rejects an in-flight delivery instead of leaving it pending', async () => {
  const session = new CuppetMcpToolSession({ sessionId: 'native-close', backendId: 'opencode' });
  await session.start();
  session.setTurn({ tools: [], executeTool: async () => ({ success: true }) });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const cleanup = await steeringPlugin.setup({ options: session.descriptor().steering, session: {
    async prompt() { started.resolve(); await release.promise; },
  } });
  try {
    const pending = session.steer({ sessionId: 'native-session', text: 'in flight' });
    const rejected = assert.rejects(pending, /connection closed/);
    await started.promise;
    await session.close();
    await rejected;
  } finally {
    release.resolve();
    cleanup();
    await session.close();
  }
});
