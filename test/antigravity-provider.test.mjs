import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ManagedAntigravityProvider, antigravityAcpDescriptor } from '../src/runtime/providers/backends/antigravity.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const installation = Object.freeze({ command: process.execPath, harnessPath: fixture, args: [fixture], version: 'test', source: 'override' });

test('Antigravity generation uses the shared ACP runtime with a managed Google ACP installation', async () => {
  let streamed = '';
  const provider = new ManagedAntigravityProvider({
    providerID: 'antigravity',
    primary: { providerID: 'antigravity', modelID: 'provider/model-b', variant: 'max' },
  }, { resolveInstallation: async () => installation });
  const result = await provider.stream([{ role: 'user', content: 'Inspect this project.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
  });
  assert.equal(result.text, 'Done.');
  assert.equal(streamed, 'Done.');
});

test('Antigravity ACP descriptor carries Google harness/auth policy without leaking it into ACP core', () => {
  const descriptor = antigravityAcpDescriptor(installation);
  assert.equal(descriptor.transport, 'acp');
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.authentication.methods, [{ id: 'oauth-personal' }]);
  const env = descriptor.environment({ ELECTRON_RUN_AS_NODE: '1', GOOGLE_API_KEY: 'do-not-forward', PATH: '/bin' });
  assert.equal(env.ANTIGRAVITY_HARNESS_PATH, fixture);
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, '1');
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, '/bin');
});
