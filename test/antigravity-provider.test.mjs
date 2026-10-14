import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ManagedAntigravityProvider, antigravityAcpDescriptor } from '../src/runtime/providers/backends/antigravity.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

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

const authFixture = fileURLToPath(new URL('./fixtures/fake-antigravity-auth-acp.mjs', import.meta.url));
function authRuntime(configuration = {}, environment = {}) {
  const descriptor = antigravityAcpDescriptor({ command: process.execPath, args: [authFixture], harnessPath: authFixture });
  const inheritedEnvironment = descriptor.environment;
  descriptor.environment = (inherited) => ({ ...inheritedEnvironment(inherited), FAKE_AUTH_COMPLETE: '1', ...environment });
  return new AcpSessionRuntime({ descriptor, configuration, liveness: { startupMs: 2000, authenticationMs: 2000 } });
}

test('Antigravity uses existing authentication even when initialize advertises OAuth', async () => {
  const urls = [];
  const runtime = authRuntime({ onAuthenticationUrl: (url) => urls.push(url) }, { FAKE_AUTHENTICATED: '1' });
  try {
    assert.equal((await runtime.start()).state, 'ready');
    assert.deepEqual(urls, []);
  } finally { await runtime.close(); }
});

test('Antigravity read-only discovery reports required auth without opening sign-in', async () => {
  const urls = [];
  const runtime = authRuntime({ onAuthenticationUrl: (url) => urls.push(url) });
  try {
    await assert.rejects(() => runtime.start(), { code: 'PROVIDER_AUTHENTICATION_REQUIRED' });
    assert.deepEqual(urls, []);
  } finally { await runtime.close(); }
});

test('Antigravity forced reconnect authenticates even when an existing session is usable', async () => {
  const urls = [];
  const runtime = authRuntime({ allowInteractiveAuth: true, forceAuthentication: true, onAuthenticationUrl: (url) => urls.push(url) }, { FAKE_AUTHENTICATED: '1' });
  try {
    assert.equal((await runtime.start()).state, 'ready');
    assert.deepEqual(urls, ['https://accounts.google.com/test']);
  } finally { await runtime.close(); }
});

for (const output of ['stdout', 'stderr']) {
  test(`Antigravity explicit Connect forwards its split ${output} sign-in URL once and completes auth`, async () => {
    const urls = [];
    const runtime = authRuntime({ allowInteractiveAuth: true, onAuthenticationUrl: (url) => urls.push(url) }, {
      FAKE_AUTH_OUTPUT: output, FAKE_AUTH_DUPLICATE: '1',
    });
    try {
      assert.equal((await runtime.start()).state, 'ready');
      assert.deepEqual(urls, ['https://accounts.google.com/test']);
    } finally { await runtime.close(); }
  });
}

test('Antigravity only forwards Google sign-in URLs during explicit authentication', () => {
  const descriptor = antigravityAcpDescriptor(installation);
  const urls = [];
  const configuration = { allowInteractiveAuth: true, onAuthenticationUrl: (url) => urls.push(url) };
  descriptor.diagnosticError('Open the following link to authenticate the ACP server: https://example.com/login', configuration);
  descriptor.diagnosticError('Open the following link to authenticate the ACP server: https://accounts.google.com.example.com/login', configuration);
  assert.deepEqual(urls, []);
});
