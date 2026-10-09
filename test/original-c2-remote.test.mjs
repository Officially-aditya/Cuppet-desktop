import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';

function fixture() {
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case 'session.get': return { id: params.sessionId, projectId: 'p1', title: 'Session', messages: [] };
      case 'session.steer': return { accepted: true, sessionId: params.sessionId, steered: true };
      case 'session.send': return { accepted: true, sessionId: params.sessionId, messageId: 'm1' };
      case 'memory.query': return { available: true, records: [] };
      case 'session.undo': return { undone: true, sessionId: params.sessionId };
      default: throw new Error(`unexpected runtime call: ${method}`);
    }
  };
  const adapter = new RemoteCommandAdapter({
    call,
    identity: { hostId: 'host_1', deviceName: 'Laptop' },
    providerConfig: {
      baseUrl: 'https://api.example.test/v1',
      model: 'model-a',
      backgroundModel: 'model-b',
      apiKey: 'secret',
    },
  });
  return { adapter, calls };
}

test('remote session.submit reauthorizes the inner slash command scope', async () => {
  const { adapter, calls } = fixture();
  const writer = { deviceID: 'writer', scopes: ['session.write'] };
  await assert.rejects(
    () => adapter.execute(writer, 'session.submit', { prompt: '/memory query' }, { id: 'memory-denied', sessionId: 's1' }),
    /missing scope 'session\.read'/,
  );
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);

  const reader = { deviceID: 'reader', scopes: ['session.read'] };
  const result = await adapter.execute(reader, 'session.submit', { prompt: '/memory query' }, { id: 'memory-query', sessionId: 's1' });
  assert.equal(result.command, true);
  assert.equal(result.id, 'memory');
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
});

test('remote undo and steer controls delegate while removed slash commands stay out of send', async () => {
  const { adapter, calls } = fixture();
  const actor = { deviceID: 'writer', scopes: ['session.write'] };

  const undone = await adapter.execute(actor, 'session.submit', { prompt: '/undo' }, { id: 'slash-undo', sessionId: 's1' });
  assert.equal(undone.command, true);
  assert.equal(undone.id, 'undo');
  assert.equal(undone.result.undone, true);
  const steered = await adapter.execute(actor, 'session.steer', { instruction: 'focus on the failing test' }, { id: 'steer-control', sessionId: 's1' });
  assert.equal(steered.steered, true);
  const steerCall = calls.find((entry) => entry.method === 'session.steer');
  assert.equal(steerCall.params.sessionId, 's1');
  assert.equal(steerCall.params.text, 'focus on the failing test');
  assert.equal(calls.some((entry) => entry.method === 'session.stop'), false);
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);

  for (const prompt of ['/steer focus on the failing test', '/effort status', '/remote-control', '/login', '/unknown-cuppet-command']) {
    await assert.rejects(
      () => adapter.execute(actor, 'session.submit', { prompt }, { id: 'slash-unknown', sessionId: 's1' }),
      /Unknown Cuppet command/,
    );
  }
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
});


test('remote provider-free status slash stays provider-free', async () => {
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case 'health': return { ok: true, activeRuns: 0 };
      case 'project.list': return [];
      case 'session.list': return [];
      case 'permission.list': return [];
      case 'cognitive.status': return { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false }, roles: {} };
      default: throw new Error(`unexpected runtime call: ${method}`);
    }
  };
  const adapter = new RemoteCommandAdapter({ call, identity: { hostId: 'host_1', deviceName: 'Laptop' }, providerConfig: {} });
  const actor = { deviceID: 'viewer', scopes: ['session.read'] };
  const result = await adapter.execute(actor, 'session.submit', { prompt: '/status' }, { id: 'slash-status', sessionId: 's1' });
  assert.equal(result.command, true);
  assert.equal(result.id, 'status');
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
});
