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
      case 'session.mode.get': return { sessionId: params.sessionId, mode: 'build' };
      case 'session.auto.get': return { sessionId: params.sessionId, enabled: false };
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
    () => adapter.execute(writer, 'session.submit', { prompt: '/effort status' }, { id: 'effort-denied', sessionId: 's1' }),
    /missing scope 'model\.write'/,
  );
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);

  const modelWriter = { deviceID: 'model-writer', scopes: ['model.write'] };
  const result = await adapter.execute(modelWriter, 'session.submit', { prompt: '/effort status' }, { id: 'effort-status', sessionId: 's1' });
  assert.equal(result.command, true);
  assert.equal(result.id, 'effort');
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
});

test('remote slash steer delegates to canonical runtime session.steer and unknown slash stays out of send', async () => {
  const { adapter, calls } = fixture();
  const actor = { deviceID: 'writer', scopes: ['session.write'] };

  const steered = await adapter.execute(actor, 'session.submit', { prompt: '/steer focus on the failing test' }, { id: 'slash-steer', sessionId: 's1' });
  assert.equal(steered.command, true);
  assert.equal(steered.id, 'steer');
  const steerCall = calls.find((entry) => entry.method === 'session.steer');
  assert.equal(steerCall.params.sessionId, 's1');
  assert.equal(steerCall.params.text, 'focus on the failing test');
  assert.equal(calls.some((entry) => entry.method === 'session.stop'), false);
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);

  await assert.rejects(
    () => adapter.execute(actor, 'session.submit', { prompt: '/unknown-cuppet-command' }, { id: 'slash-unknown', sessionId: 's1' }),
    /Unknown Cuppet command/,
  );
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
