import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';

function fixture() {
  const calls = [];
  const session = { id: 's1', projectId: 'p1', title: 'One', messages: [] };
  const call = async (method, params = {}, context) => {
    calls.push({ method, params, ...(context ? { context } : {}) });
    switch (method) {
      case 'project.list': return [{ id: 'p1', name: 'Project', canonicalPath: '/tmp/project' }];
      case 'project.get': return { id: 'p1', name: 'Project', canonicalPath: '/tmp/project', missing: false };
      case 'session.list': return [session];
      case 'session.get': return session;
      case 'session.send': return { accepted: true, sessionId: 's1', messageId: 'm1' };
      case 'session.mode.get': return { sessionId: 's1', mode: 'build' };
      case 'session.auto.get': return { sessionId: 's1', enabled: false };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const providerConfig = {
    providerID: 'future-provider', baseUrl: 'https://private-provider.example/v1', apiKey: 'private-key',
    models: [
      {
        providerID: 'future-provider', modelID: 'coder', name: 'Coder', api: { id: 'transport-coder' },
        capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
        variants: [
          { id: 'low', body: { reasoning: { effort: 'low' } } },
          { id: 'high', headers: { 'x-reasoning': 'high', authorization: 'drop-me' }, body: { reasoning: { effort: 'high' }, api_key: 'drop-me' } },
        ],
      },
    ],
    primary: { providerID: 'future-provider', modelID: 'coder', variant: 'low' },
    secondary: { providerID: 'future-provider', modelID: 'coder', variant: 'high' },
  };
  return { adapter: new RemoteCommandAdapter({ call, identity: { hostId: 'host', deviceName: 'Laptop' }, providerConfig }), calls };
}
const actor = { deviceID: 'phone' };

test('Remote lists sanitized host variants and lowers only the selected advertised effort', async () => {
  const { adapter, calls } = fixture();
  const models = await adapter.execute(actor, 'model.list');
  assert.deepEqual(models, [{ providerID: 'future-provider', modelID: 'coder', name: 'Coder', roles: ['primary', 'secondary'], variants: ['low', 'high'], selected: true, selectedVariant: 'low' }]);
  assert.doesNotMatch(JSON.stringify(models), /private-key|private-provider|authorization|api_key/);

  await adapter.execute(actor, 'workspace.attach', { workspaceId: 'p1' });
  await adapter.execute(actor, 'session.resume', { sessionID: 's1' });
  assert.deepEqual(await adapter.execute(actor, 'model.select', { providerID: 'future-provider', modelID: 'coder', variant: 'HIGH', requestBody: { injected: true } }), {
    providerID: 'future-provider', modelID: 'coder', variant: 'high',
  });
  await adapter.execute(
    actor,
    'session.submit',
    { prompt: 'Implement it', requestBody: { injected: true }, baseUrl: 'https://attacker.invalid', apiKey: 'attacker-key' },
    { id: 'model-policy-submit' },
  );
  const send = calls.findLast((entry) => entry.method === 'session.send');
  assert.equal(send.params.provider.model, 'transport-coder');
  assert.equal(send.params.provider.variant, 'high');
  assert.deepEqual(send.params.provider.requestBody.reasoning, { effort: 'high' });
  assert.equal(send.params.provider.requestBody.injected, undefined);
  assert.equal(send.params.provider.requestHeaders['x-reasoning'], 'high');
  assert.equal(send.params.provider.requestHeaders.authorization, undefined);
  assert.equal(send.params.provider.baseUrl, 'https://private-provider.example/v1');
  assert.equal(send.params.provider.apiKey, 'private-key');
  assert.match(send.context.commandId, /^remote:[a-f0-9]{64}$/);
  assert.doesNotMatch(send.context.commandId, /phone|model-policy-submit|private-key/);
});

test('Remote refuses unknown host effort rather than falling back or forwarding metadata', async () => {
  const { adapter } = fixture();
  await assert.rejects(() => adapter.execute(actor, 'model.select', { providerID: 'future-provider', modelID: 'coder', variant: 'extreme' }), /Available: low, high/);
  await assert.rejects(() => adapter.execute(actor, 'model.select', { providerID: 'future-provider', modelID: 'missing', variant: 'high' }), /not configured/);
});
