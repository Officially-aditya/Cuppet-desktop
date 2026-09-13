import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';
import { publicEventFor } from '../src/runtime/remote/protocol.mjs';

const actor = { deviceID: 'dev_projection' };

function fixture() {
  const session = {
    id: 's1',
    projectId: 'p1',
    title: 'Projection chat',
    lastStatus: 'streaming',
    messages: [
      { id: 'm-user', role: 'user', status: 'complete', content: 'Inspect it.' },
      { id: 'm-assistant', role: 'assistant', status: 'streaming', content: 'Working.' },
    ],
    activities: [
      { sessionId: 's1', messageId: 'm-assistant', sequence: 1, source: 'provider', activity: { type: 'activity.reasoning.delta', text: 'Checking.' } },
      { sessionId: 's1', messageId: 'm-assistant', sequence: 2, source: 'execution', activity: { type: 'activity.tool.closed', callId: 'tool-1', tool: 'workspace_read', status: 'success' } },
    ],
    toolExecutions: [
      { id: 'exec-1', sessionId: 's1', callId: 'tool-1', tool: 'workspace_read', status: 'complete' },
    ],
  };
  const run = {
    runId: 'm-assistant',
    sessionId: 's1',
    sourceSessionId: null,
    projectId: 'p1',
    status: 'running',
    phase: 'tool_running',
    error: null,
    createdAt: 100,
    updatedAt: 120,
  };
  const call = async (method, params = {}) => {
    switch (method) {
      case 'project.list': return [{ id: 'p1', name: 'Project', canonicalPath: '/tmp/project' }];
      case 'project.get': return { id: 'p1', name: 'Project', canonicalPath: '/tmp/project', missing: false };
      case 'session.list': return [{ id: 's1', projectId: 'p1', title: 'Projection chat', lastStatus: 'streaming' }];
      case 'session.get': assert.equal(params.sessionId, 's1'); return structuredClone(session);
      case 'session.mode.get': return { sessionId: 's1', mode: 'build' };
      case 'session.auto.get': return { sessionId: 's1', enabled: false };
      case 'session.run.latest': assert.equal(params.sessionId, 's1'); return structuredClone(run);
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return new RemoteCommandAdapter({
    call,
    identity: { hostId: 'host_projection', deviceName: 'Laptop' },
    providerConfig: { baseUrl: 'https://api.example.test/v1', model: 'model-a', apiKey: 'secret' },
  });
}

function providerConfig(variants = ['low', 'high']) {
  return {
    providerID: 'future-provider',
    baseUrl: 'https://provider.example.test/v1',
    apiKey: 'secret',
    models: [{
      providerID: 'future-provider',
      modelID: 'coder',
      name: 'Coder',
      capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
      variants: variants.map((id) => ({ id, body: { reasoning: { effort: id } } })),
    }],
    primary: { providerID: 'future-provider', modelID: 'coder', variant: 'low' },
  };
}

test('remote session.snapshot returns durable transcript, tool, and run projections intact', async () => {
  const adapter = fixture();
  await adapter.execute(actor, 'workspace.attach', { workspaceId: 'p1' });
  await adapter.execute(actor, 'session.resume', { sessionID: 's1' });
  const snapshot = await adapter.execute(actor, 'session.snapshot');

  assert.equal(snapshot.projectionVersion, 1);
  assert.equal(snapshot.session.id, 's1');
  assert.deepEqual(snapshot.session.messages.map((item) => item.id), ['m-user', 'm-assistant']);
  assert.deepEqual(snapshot.session.activities.map((item) => item.activity.type), ['activity.reasoning.delta', 'activity.tool.closed']);
  assert.deepEqual(snapshot.session.toolExecutions.map((item) => item.callId), ['tool-1']);
  assert.deepEqual(snapshot.run, {
    runId: 'm-assistant',
    sessionId: 's1',
    sourceSessionId: null,
    projectId: 'p1',
    status: 'running',
    phase: 'tool_running',
    error: null,
    createdAt: 100,
    updatedAt: 120,
  });
  assert.equal(snapshot.mode, 'build');
  assert.equal(snapshot.autoMode, false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
});

test('remote runtime publication invalidates durable projections instead of rematerializing live transcript/tool state', () => {
  const runtimeEvents = [
    { type: 'message.created', sessionId: 's1' },
    { type: 'message.delta', sessionId: 's1', delta: 'partial' },
    { type: 'message.completed', sessionId: 's1' },
    { type: 'runtime.activity', sessionId: 's1', activity: { type: 'activity.reasoning.delta', text: 'thinking' } },
    { type: 'tool.started', sessionId: 's1', callId: 't1', tool: 'read' },
    { type: 'tool.finished', sessionId: 's1', callId: 't1', tool: 'read', success: true },
    { type: 'run.started', sessionId: 's1' },
    { type: 'run.finished', sessionId: 's1' },
    { type: 'session.updated', session: { id: 's1' } },
    { type: 'pe3.routed', targetSessionId: 's1', sourceSessionId: 's0' },
  ];

  const mapped = runtimeEvents.map(publicEventFor);
  assert.ok(mapped.every((event) => event?.type === 'session.projection.invalidated'));
  assert.ok(mapped.every((event) => event?.sessionId === 's1'));
  assert.equal(mapped.some((event) => ['assistant.text.delta', 'tool.started', 'tool.completed', 'session.idle', 'session.updated'].includes(event?.type)), false);
});

test('remote device provider selection is reconciled against refreshed host authority', async () => {
  const adapter = new RemoteCommandAdapter({
    call: async () => { throw new Error('runtime calls are not needed for provider projection reconciliation'); },
    identity: { hostId: 'host_projection', deviceName: 'Laptop' },
    providerConfig: providerConfig(),
  });

  await adapter.execute(actor, 'provider.select', { providerID: 'future-provider' });
  await adapter.execute(actor, 'model.select', { providerID: 'future-provider', modelID: 'coder', variant: 'high' });
  assert.equal((await adapter.execute(actor, 'model.list'))[0]?.selectedVariant, 'high');

  adapter.setProviderConfig({ ...providerConfig(), apiKey: 'rotated-secret' });
  assert.equal((await adapter.execute(actor, 'model.list'))[0]?.selectedVariant, 'high', 'still-advertised device selection should survive host refresh');

  adapter.setProviderConfig(providerConfig(['low']));
  const models = await adapter.execute(actor, 'model.list');
  assert.equal(models[0]?.selected, true);
  assert.equal(models[0]?.selectedVariant, 'low', 'removed effort must fall back to the host primary projection');
  assert.deepEqual(models[0]?.variants, ['low']);
});

test('remote browser consumes durable session/run/provider projections instead of owning live reducers', async () => {
  const [source, commands, manager] = await Promise.all([
    readFile(new URL('../src/remote-app/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/remote/commands.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/remote/manager.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /case 'session\.projection\.invalidated'/);
  assert.match(source, /case 'provider\.projection\.invalidated'/);
  assert.match(source, /command\('session\.snapshot'\)/);
  assert.match(source, /renderSessionProjection\(snap\)/);
  assert.match(source, /snapshot\?\.run\?\.status/);
  assert.match(source, /\['starting','running','waiting','settling'\]\.includes\(status\)/);
  assert.match(source, /session\.activities/);
  assert.match(commands, /this\.#call\('session\.run\.latest',\{sessionId\}\)/);
  assert.match(commands, /resolveAdvertisedSelection\(this\.#provider,state\.selection\)/);
  assert.match(manager, /this\.#bridge\?\.publish\('provider\.projection\.invalidated',\{\}\)/);
  assert.doesNotMatch(source, /command\('session\.messages'\)/);
  assert.doesNotMatch(source, /case 'assistant\.text\.delta'/);
  assert.doesNotMatch(source, /case 'tool\.started'/);
  assert.doesNotMatch(source, /case 'tool\.completed'/);
  assert.doesNotMatch(source, /liveAssistant/);
});