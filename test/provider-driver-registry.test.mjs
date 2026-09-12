import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localCliDescriptor, localCliProviderIDs } from '../src/runtime/local-cli-descriptors.mjs';
import { ProviderCapabilitySnapshotStore } from '../src/runtime/providers/capability-snapshot.mjs';
import { buildProviderBackendRegistry } from '../src/runtime/providers/default-registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('built-in provider registry owns transport resolution', () => {
  const registry = buildProviderBackendRegistry();
  assert.equal(registry.requireResolved({ providerID: 'opencode' }).transport, 'acp');
  assert.equal(registry.requireResolved({ providerID: 'antigravity' }).transport, 'headless-plan');
  assert.equal(registry.requireResolved({ providerID: 'some-openai-compatible-provider' }).id, 'openai-compatible');
  assert.equal(registry.operationSupport('opencode').discoverCapabilities, true);
  assert.equal(registry.operationSupport('antigravity').discoverCapabilities, true);
});

test('every ACP descriptor creates the same shared ACP provider adapter', () => {
  const registry = buildProviderBackendRegistry();
  const acpProviderIDs = localCliProviderIDs().filter((id) => localCliDescriptor(id)?.transport === 'acp');
  assert.ok(acpProviderIDs.length >= 2);
  for (const providerID of acpProviderIDs) {
    const runtime = registry.createConfiguredRuntime({ providerID });
    assert.equal(runtime.constructor.name, 'AcpProviderAdapter', `${providerID} escaped the universal ACP runtime`);
  }
});

test('capability snapshot retains last known good models on transient discovery failure', async () => {
  const store = new ProviderCapabilitySnapshotStore();
  let mode = 'success';
  const registry = {
    requireResolved: () => ({ id: 'fake', transport: 'acp' }),
    operation: async () => {
      if (mode === 'fail') throw new Error('temporary provider probe failure');
      if (mode === 'empty') return { providerID: 'fake', source: 'acp', available: false, models: [], defaultModel: null };
      return {
        providerID: 'fake', source: 'acp', available: true,
        models: [{ id: 'model-a', label: 'Model A' }], defaultModel: 'model-a',
      };
    },
  };
  const configuration = { providerID: 'fake', baseUrl: 'https://example.invalid' };

  const first = await store.refresh(registry, configuration);
  assert.deepEqual(first.models.map((item) => item.id), ['model-a']);
  assert.equal(first.stale, false);

  mode = 'fail';
  const stale = await store.refresh(registry, configuration);
  assert.deepEqual(stale.models.map((item) => item.id), ['model-a']);
  assert.equal(stale.stale, true);
  assert.match(stale.discoveryError, /temporary provider probe failure/);

  mode = 'empty';
  const authoritativeEmpty = await store.refresh(registry, configuration);
  assert.deepEqual(authoritativeEmpty.models, []);
  assert.equal(authoritativeEmpty.stale, false);
  assert.equal(authoritativeEmpty.available, false);
});

test('main model catalog and provider factory contain no provider transport dispatch', async () => {
  const [catalog, factory] = await Promise.all([
    readFile(`${root}/src/main/provider-model-catalog.mjs`, 'utf8'),
    readFile(`${root}/src/runtime/provider-factory.mjs`, 'utf8'),
  ]);

  assert.doesNotMatch(catalog, /localCliDescriptor|discoverAcpRuntimeCatalog|descriptor\.transport|providerID\s*===\s*['"]/);
  assert.doesNotMatch(factory, /MANAGED_ACP_BACKENDS|AntigravityHeadlessProvider|AcpCliAgentProvider|CodexSubscriptionProvider|providerID\s*===\s*['"]/);
  assert.match(catalog, /discoverProviderCapabilitySnapshot/);
  assert.match(factory, /createProviderRuntime/);
});

test('ACP transport core contains no provider identities or provider-specific environment logic', async () => {
  const session = await readFile(`${root}/src/runtime/providers/transports/acp/acp-session.mjs`, 'utf8');
  for (const providerID of localCliProviderIDs()) {
    assert.doesNotMatch(session, new RegExp(providerID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${providerID} leaked into ACP core`);
  }
  assert.doesNotMatch(session, /OPENCODE_|XAI_API_KEY|cached_token|xai\.api_key/);
  assert.match(session, /descriptor\?\.environment/);
  assert.match(session, /descriptor\?\.authentication/);
});
