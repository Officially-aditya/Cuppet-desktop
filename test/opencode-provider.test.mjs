import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { buildProviderBackendRegistry } from '../src/runtime/providers/default-registry.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-opencode-acp-agent.mjs', import.meta.url));

function configuration(extra = {}) {
  return {
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [fixture],
    primary: { modelID: 'provider/model-b', variant: 'max' },
    ...extra,
  };
}

test('OpenCode descriptor uses the official ACP command and Cuppet MCP bridge', () => {
  const descriptor = localCliDescriptor('opencode');
  assert.equal(descriptor.transport, 'acp');
  assert.deepEqual(descriptor.args, ['acp']);
  assert.equal(descriptor.mcpToolBridge, true);
});

test('OpenCode descriptor isolates built-in execution while preserving unrelated inline config', () => {
  const descriptor = localCliDescriptor('opencode');
  const environment = descriptor.environment({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'system', permission: { custom_tool: 'ask' } }),
    OPENCODE_SERVER_PASSWORD: 'should-not-cross-stdio-boundary',
  });
  const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(environment.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(config.theme, 'system');
  assert.equal(config.tools.bash, false);
  assert.equal(config.tools.read, false);
  assert.equal(config.permission.custom_tool, 'ask');
  assert.equal(config.permission['*'], 'deny');
  assert.equal(config.permission['cuppet-runtime_*'], 'allow');
  assert.equal(config.permission['cuppet_runtime_*'], 'allow');
});

test('OpenCode runs through the shared ACP adapter with model and effort selection', async () => {
  const registry = buildProviderBackendRegistry();
  const runtime = registry.createConfiguredRuntime(configuration());
  assert.equal(runtime.constructor.name, 'AcpProviderAdapter');
  const deltas = [];
  const result = await runtime.stream([{ role: 'user', content: 'Reply when ready.' }], {
    projectRoot: process.cwd(),
    onDelta: async (delta) => deltas.push(delta),
  });
  assert.equal(result.text, 'OpenCode ACP ready.');
  assert.equal(deltas.join(''), 'OpenCode ACP ready.');
  assert.equal(result.usage.totalTokens, 11);
});

test('OpenCode ACP session receives only the session-scoped Cuppet MCP bridge for tools', async () => {
  const registry = buildProviderBackendRegistry();
  const runtime = registry.createConfiguredRuntime(configuration({ cliEnv: { FAKE_OPENCODE_REQUIRE_MCP: '1' } }));
  const result = await runtime.stream([{ role: 'user', content: 'Use Cuppet tools if needed.' }], {
    projectRoot: process.cwd(),
    tools: [{ name: 'workspace_read', description: 'Read a workspace file', inputSchema: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true }),
  });
  assert.equal(result.text, 'OpenCode ACP ready.');
});

test('OpenCode ACP authentication failure reaches the generic reauthentication classifier', async () => {
  const registry = buildProviderBackendRegistry();
  const runtime = registry.createConfiguredRuntime(configuration());
  let error;
  try {
    await runtime.stream([{ role: 'user', content: 'AUTH_ERROR' }], { projectRoot: process.cwd() });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /provider authentication required/i);
  const failure = classifyProviderError(error, { providerID: 'opencode' });
  assert.equal(failure.category, 'authentication');
  assert.equal(failure.action, 'reauthenticate');
  assert.equal(failure.title, 'Sign-in required');
});

test('OpenCode ACP no-provider failure is not collapsed into unexpected error', async () => {
  const registry = buildProviderBackendRegistry();
  const runtime = registry.createConfiguredRuntime(configuration());
  let error;
  try {
    await runtime.stream([{ role: 'user', content: 'NO_PROVIDER' }], { projectRoot: process.cwd() });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /no provider available/i);
  const failure = classifyProviderError(error, { providerID: 'opencode' });
  assert.equal(failure.category, 'model_unavailable');
  assert.equal(failure.action, 'change_model');
  assert.notEqual(failure.category, 'unknown');
});
