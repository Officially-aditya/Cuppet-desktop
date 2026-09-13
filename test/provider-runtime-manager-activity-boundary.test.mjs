import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { providerActivity } from '../src/runtime/providers/activity.mjs';
import { buildProviderBackendRegistry } from '../src/runtime/providers/default-registry.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';

const opencodeFixture = fileURLToPath(new URL('./fixtures/fake-opencode-acp-agent.mjs', import.meta.url));

function managedAdapter() {
  return {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'opencode',
      descriptor: {
        id: 'opencode',
        label: 'OpenCode',
        transport: 'acp',
        command: 'opencode',
        args: [],
        envOverride: '',
        loginHint: '',
      },
      configuration: { providerID: 'opencode' },
    }),
  };
}

test('managed ACP never downgrades canonical Activity into legacy provider events', async () => {
  const legacy = [];
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => ({
      async start() {},
      async newSession() {},
      async runTurn(_input, hooks) {
        await hooks.onActivity(providerActivity('activity.reasoning.delta', { text: 'Inspecting.' }));
        await hooks.onActivity(providerActivity('activity.tool.opened', {
          callId: 'provider-tool-1',
          tool: 'search',
          argumentsJson: '{"query":"TODO"}',
        }));
        await hooks.onActivity(providerActivity('activity.tool.closed', {
          callId: 'provider-tool-1',
          tool: 'search',
          argumentsJson: '{"query":"TODO"}',
          status: 'success',
          details: '2 matches',
        }));
        return { text: '', usage: null };
      },
      async cancel() {},
      async close() {},
    }),
  });

  try {
    await manager.adapterFor({ sessionId: 'chat-no-downgrade', adapter: managedAdapter() }).stream([], {
      onProviderEvent: async (event) => legacy.push(event),
    });
    assert.deepEqual(legacy, []);
  } finally {
    await manager.close();
  }
});

test('managed ACP still forwards canonical Activity when a canonical observer exists', async () => {
  const activities = [];
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => ({
      async start() {},
      async newSession() {},
      async runTurn(_input, hooks) {
        await hooks.onActivity(providerActivity('activity.reasoning.delta', { text: 'Canonical only.' }));
        return { text: '', usage: null };
      },
      async cancel() {},
      async close() {},
    }),
  });

  try {
    await manager.adapterFor({ sessionId: 'chat-canonical', adapter: managedAdapter() }).stream([], {
      onActivity: async (activity) => activities.push(activity),
    });
    assert.deepEqual(activities.map((activity) => [activity.type, activity.text]), [
      ['activity.reasoning.delta', 'Canonical only.'],
    ]);
  } finally {
    await manager.close();
  }
});

test('stateless ACP emits canonical Activity without a legacy provider-event mirror', async () => {
  const registry = buildProviderBackendRegistry();
  const adapter = registry.createConfiguredRuntime({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [opencodeFixture],
    primary: { modelID: 'provider/model-b', variant: 'max' },
  });
  const activities = [];
  const legacy = [];
  const result = await adapter.stream([{ role: 'user', content: 'Reply when ready.' }], {
    projectRoot: process.cwd(),
    onActivity: async (activity) => activities.push(activity),
    onProviderEvent: async (event) => legacy.push(event),
  });

  assert.equal(result.text, 'OpenCode ACP ready.');
  assert.ok(activities.some((activity) => activity.type === 'activity.text.delta' && activity.text === 'OpenCode ACP ready.'));
  assert.deepEqual(legacy, []);
});
