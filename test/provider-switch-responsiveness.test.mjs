import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { verifyLocalProviderExecutableVersion, clearLocalProviderVersionCache } from '../src/runtime/providers/local-provider-version-check.mjs';
import { ProviderCapabilitySnapshotStore } from '../src/runtime/providers/capability-snapshot.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

test('verifyLocalProviderExecutableVersion caches version check for 30 minutes', async () => {
  clearLocalProviderVersionCache('opencode');
  let execCount = 0;
  const descriptor = { id: 'opencode', label: 'OpenCode', command: 'opencode' };
  const mockRun = async () => {
    execCount += 1;
    return { stdout: 'opencode 1.18.35' };
  };

  const first = await verifyLocalProviderExecutableVersion(descriptor, {}, { runVersionImpl: mockRun });
  assert.equal(first.observedVersion, '1.18.35');
  assert.equal(execCount, 1);

  const second = await verifyLocalProviderExecutableVersion(descriptor, {}, { runVersionImpl: mockRun });
  assert.equal(second.observedVersion, '1.18.35');
  assert.equal(execCount, 1); // Hit cache, not incremented!

  // Force bypasses cache
  const third = await verifyLocalProviderExecutableVersion(descriptor, {}, { runVersionImpl: mockRun, force: true });
  assert.equal(third.observedVersion, '1.18.35');
  assert.equal(execCount, 2);

  clearLocalProviderVersionCache('opencode');
});

test('ProviderCapabilitySnapshotStore persists to disk and reloads on startup', async () => {
  const cacheFile = join(tmpdir(), `cuppet-cap-test-${Date.now()}.json`);
  try {
    const store1 = new ProviderCapabilitySnapshotStore({ cacheFile });
    const registry = {
      requireResolved: () => ({ id: 'fake', transport: 'acp' }),
      operation: async () => ({
        providerID: 'fake',
        source: 'acp',
        available: true,
        models: [{ id: 'model-x', label: 'Model X' }],
        defaultModel: 'model-x',
      }),
    };
    const config = { providerID: 'fake', baseUrl: 'https://example.invalid' };

    await store1.refresh(registry, config);
    const cached1 = store1.get(config);
    assert.ok(cached1);
    assert.equal(cached1.models[0].id, 'model-x');

    // Create a new store pointing to the same disk cache file (simulates app restart)
    const store2 = new ProviderCapabilitySnapshotStore({ cacheFile });
    const cached2 = store2.get(config);
    assert.ok(cached2, 'Snapshot should be loaded from disk cache');
    assert.equal(cached2.models[0].id, 'model-x');
  } finally {
    try { rmSync(cacheFile, { force: true }); } catch {}
  }
});

test('ProviderRuntimeManager adopts warm runtime from discovery and claims it for turns', async () => {
  const logs = [];
  const fakeAcp = {
    async start() { logs.push('start'); },
    async newSession() { logs.push('newSession'); },
    async runTurn({ messages }, hooks) {
      logs.push('runTurn');
      await hooks.onText?.('hello');
      return { text: 'hello' };
    },
    async close() { logs.push('close'); },
  };

  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => fakeAcp,
  });

  const descriptor = localCliDescriptor('opencode');
  const adopted = manager.adoptWarmRuntime({
    runtime: fakeAcp,
    providerID: 'opencode',
    descriptor,
    configuration: { providerID: 'opencode', primary: { modelID: 'claude-3-7-sonnet' } },
    projectRoot: '/test/proj',
    selection: { model: 'claude-3-7-sonnet' },
    sessionId: 'session-warm',
  });

  assert.equal(adopted, true);
  assert.equal(manager.size, 1);

  // Now run turn on session-warm with opencode
  const adapter = {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'opencode',
      descriptor,
      configuration: { providerID: 'opencode', primary: { modelID: 'claude-3-7-sonnet' } },
    }),
  };

  const managed = manager.adapterFor({ sessionId: 'session-warm', adapter, projectRoot: '/test/proj' });
  const result = await managed.stream([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hello');
  // It called newSession instead of start, because it was already warm and started!
  assert.deepEqual(logs, ['newSession', 'runTurn']);

  await manager.close();
});

test('ProviderRuntimeManager.applyModelSwitch performs in-session model update without restart', async () => {
  let switchSelection = null;
  const fakeAcp = {
    async start() { },
    async newSession() { },
    async applyModelSwitch(selection) {
      switchSelection = selection;
      return { model: selection.model };
    },
    async runTurn() { return { text: 'ok' }; },
    async close() { },
  };

  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => fakeAcp,
  });

  const descriptor = localCliDescriptor('opencode');
  manager.adoptWarmRuntime({
    runtime: fakeAcp,
    providerID: 'opencode',
    descriptor,
    configuration: { providerID: 'opencode' },
    projectRoot: '/test/proj',
    selection: { model: 'model-1' },
    sessionId: 'session-switch',
  });

  const switched = await manager.applyModelSwitch({
    sessionId: 'session-switch',
    configuration: { providerID: 'opencode', primary: { modelID: 'model-2', variant: 'high' } },
  });

  assert.equal(switched, true);
  assert.deepEqual(switchSelection, { model: 'model-2', effort: 'high' });
  await manager.close();
});
