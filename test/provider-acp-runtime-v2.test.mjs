import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { OpenCodeAcpProviderV2 } from '../src/runtime/providers/backends/opencode.mjs';

const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const authFixture = fileURLToPath(new URL('./fixtures/fake-acp-auth-agent.mjs', import.meta.url));

test('ACP v2 applies exact model-dependent config and emits Cuppet Activity', async () => {
  const runtime = new AcpSessionRuntime({ descriptor: localCliDescriptor('opencode'), configuration: { cliCommand: process.execPath, cliArgs: [configFixture], primary: { modelID: 'provider/model-b' }, primaryEffort: 'max' }, projectRoot: tmpdir() });
  const seen = [];
  try {
    await runtime.start();
    const caps = await runtime.capabilities();
    assert.equal(caps.settings.find((item) => item.id === 'model')?.value, 'provider/model-b');
    assert.deepEqual(caps.settings.find((item) => item.id === 'effort')?.options.map((item) => item.id), ['medium', 'max']);
    const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'Inspect.' }] }, { onActivity: async (activity) => seen.push(activity) });
    assert.equal(result.text, 'Done.');
    assert.deepEqual(seen.map((item) => item.type), ['activity.reasoning.delta', 'activity.tool.opened', 'activity.tool.closed', 'activity.text.delta']);
    assert.equal(seen[2].status, 'success');
  } finally { await runtime.close(); }
});

test('ACP v2 observer callbacks cannot fail an otherwise successful provider turn', async () => {
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('opencode'),
    configuration: { cliCommand: process.execPath, cliArgs: [configFixture], primary: { modelID: 'provider/model-b' }, primaryEffort: 'max' },
    projectRoot: tmpdir(),
  });
  try {
    await runtime.start();
    const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'Inspect.' }] }, {
      onText: async () => { throw new Error('renderer text observer failed'); },
      onActivity: async () => { throw new Error('renderer activity observer failed'); },
    });
    assert.equal(result.text, 'Done.');
    assert.equal(runtime.snapshot().state, 'ready');
  } finally { await runtime.close(); }
});

test('generic ACP adapter preserves current stream callbacks', async () => {
  const provider = new AcpProviderAdapter({ providerID: 'opencode', cliCommand: process.execPath, cliArgs: [configFixture], primary: { modelID: 'provider/model-b' }, primaryEffort: 'max' });
  const events = [];
  let text = '';
  const result = await provider.stream([{ role: 'user', content: 'Inspect.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { text += delta; },
    onProviderEvent: async (event) => events.push(event),
  });
  assert.equal(result.text, 'Done.');
  assert.equal(text, 'Done.');
  assert.deepEqual(events.map((event) => event.type), ['reasoning', 'tool.started', 'tool.finished']);
});

test('OpenCode compatibility export is only a thin ACP adapter alias', () => {
  const provider = new OpenCodeAcpProviderV2({ cliCommand: process.execPath, cliArgs: [configFixture] });
  const managed = provider.cuppetManagedRuntime();
  assert.equal(managed.protocol, 'acp');
  assert.equal(managed.backendId, 'opencode');
});

test('generic ACP adapter delegates ACP host operations through Cuppet', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const calls = [];
  const permissions = [];
  const provider = new AcpProviderAdapter({ providerID: 'opencode', cliCommand: process.execPath, cliArgs: [fixture] });
  const result = await provider.stream([{ role: 'user', content: 'Update' }], {
    projectRoot: tmpdir(),
    requestAgentPermission: async (request) => { permissions.push(request); return 'once'; },
    executeTool: async (call) => {
      calls.push(call);
      if (call.name === 'workspace_read') return { success: true, output: 'hello' };
      if (call.name === 'workspace_write') return { success: true, output: 'written' };
      if (call.name === 'bash') return { success: true, output: 'stdout:\nok\nexit code: 0' };
      return { success: false, output: 'bad' };
    },
  });
  assert.equal(result.text, 'Working. Done.');
  assert.deepEqual(calls.map((call) => call.name), ['workspace_read', 'workspace_write', 'bash']);
  assert.equal(permissions[0].kind, 'edit');
  assert.equal(result.usage.totalTokens, 12);
});

test('provider factory routes every ACP descriptor through the universal ACP adapter', () => {
  assert.ok(createUntrackedChatProvider({ providerID: 'opencode' }) instanceof AcpProviderAdapter);
  assert.ok(createUntrackedChatProvider({ providerID: 'grok-build' }) instanceof AcpProviderAdapter);
  assert.ok(createUntrackedChatProvider({ providerID: 'github-copilot' }) instanceof AcpProviderAdapter);
  assert.ok(createUntrackedChatProvider({ providerID: 'mistral-vibe' }) instanceof AcpProviderAdapter);
  assert.ok(createUntrackedChatProvider({ providerID: 'kiro' }) instanceof AcpProviderAdapter);
});

test('ACP authentication policy is descriptor-owned rather than provider-ID owned', async () => {
  const descriptor = {
    ...localCliDescriptor('opencode'),
    id: 'auth-fixture',
    label: 'Auth Fixture',
    environment: undefined,
    authentication: {
      methods: [
        { id: 'test.api_key', requiresEnv: 'TEST_AUTH_KEY' },
        { id: 'cached_token' },
      ],
      meta: { headless: true },
    },
  };

  const withKey = new AcpSessionRuntime({
    descriptor,
    configuration: { cliCommand: process.execPath, cliArgs: [authFixture], cliEnv: { TEST_AUTH_KEY: 'present' } },
    projectRoot: tmpdir(),
  });
  try {
    await withKey.start();
    const result = await withKey.runTurn({ messages: [{ role: 'user', content: 'Which auth?' }] });
    assert.equal(result.text, 'test.api_key');
  } finally { await withKey.close(); }

  const cached = new AcpSessionRuntime({
    descriptor,
    configuration: { cliCommand: process.execPath, cliArgs: [authFixture], cliEnv: { TEST_AUTH_KEY: null } },
    projectRoot: tmpdir(),
  });
  try {
    await cached.start();
    const result = await cached.runTurn({ messages: [{ role: 'user', content: 'Which auth?' }] });
    assert.equal(result.text, 'cached_token');
  } finally { await cached.close(); }
});

test('ACP v2 cancels and terminates a genuinely silent stalled turn', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp-hanging-agent.mjs', import.meta.url));
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('opencode'),
    configuration: { cliCommand: process.execPath, cliArgs: [fixture] },
    projectRoot: tmpdir(),
    liveness: { inactivityMs: 35, cancelGraceMs: 15 },
  });
  const seen = [];
  try {
    await runtime.start();
    await assert.rejects(
      () => runtime.runTurn({ messages: [{ role: 'user', content: 'Hang' }] }, { onActivity: async (activity) => seen.push(activity) }),
      /stopped responding via ACP/,
    );
    assert.ok(seen.some((activity) => activity.type === 'activity.warning' && activity.code === 'provider_stalled'));
  } finally { await runtime.close(); }
});

test('ACP v2 liveness resets on genuine reasoning activity', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp-heartbeat-agent.mjs', import.meta.url));
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('opencode'),
    configuration: { cliCommand: process.execPath, cliArgs: [fixture] },
    projectRoot: tmpdir(),
    liveness: { inactivityMs: 35, cancelGraceMs: 15 },
  });
  try {
    await runtime.start();
    const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'Long work' }] });
    assert.equal(result.text, 'Alive.');
  } finally { await runtime.close(); }
});
