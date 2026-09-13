import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { buildProviderBackendRegistry } from '../src/runtime/providers/default-registry.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';

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

test('OpenCode descriptor uses the official ACP command and Cuppet MCP bridge without forcing Mode', () => {
  const descriptor = localCliDescriptor('opencode');
  assert.equal(descriptor.transport, 'acp');
  assert.deepEqual(descriptor.args, ['acp']);
  assert.equal(descriptor.mcpToolBridge, true);
  assert.equal(descriptor.requiredSessionSettings, undefined);
});

test('OpenCode ACP preserves CLI-owned config and auth while enforcing the native-tool permission overlay', () => {
  const descriptor = localCliDescriptor('opencode');
  const configContent = `{
    // OpenCode owns this inline config, including JSONC syntax.
    "theme": "system",
    "provider": { "custom": { "options": { "endpoint": "https://example.invalid" } } },
    "agent": { "build": { "permission": { "bash": "allow" } } },
  }`;
  const environment = descriptor.environment({
    OPENCODE_CONFIG_CONTENT: configContent,
    OPENCODE_PERMISSION: JSON.stringify({ bash: 'allow', custom_tool: 'allow' }),
    OPENCODE_SERVER_PASSWORD: 'terminal-owned-password',
    OPENCODE_SERVER_USERNAME: 'terminal-owned-user',
    CUSTOM_PROVIDER_TOKEN: 'terminal-owned-token',
  });
  const permission = JSON.parse(environment.OPENCODE_PERMISSION);

  assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, '1');
  assert.equal(environment.OPENCODE_CONFIG_CONTENT, configContent);
  assert.equal(environment.CUPPET_OPENCODE_AGENT_ID, undefined);
  assert.equal(environment.OPENCODE_SERVER_PASSWORD, 'terminal-owned-password');
  assert.equal(environment.OPENCODE_SERVER_USERNAME, 'terminal-owned-user');
  assert.equal(environment.CUSTOM_PROVIDER_TOKEN, 'terminal-owned-token');

  for (const native of ['*', 'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill', 'external_directory']) {
    assert.equal(permission[native], 'deny');
  }
  assert.equal(permission['cuppet-runtime_*'], 'allow');
  assert.equal(permission['cuppet_runtime_*'], 'allow');
  assert.equal(permission.custom_tool, undefined);
});

test('OpenCode ACP never parses or rewrites inherited inline config', () => {
  const descriptor = localCliDescriptor('opencode');
  const configContent = '{ invalid jsonc';
  const environment = descriptor.environment({ OPENCODE_CONFIG_CONTENT: configContent });
  assert.equal(environment.OPENCODE_CONFIG_CONTENT, configContent);
});

test('OpenCode runs through shared ACP using provider-owned session defaults plus model and effort', async () => {
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

test('OpenCode permission policy wins over generic cliEnv overrides and MCP stays session-scoped', async () => {
  const registry = buildProviderBackendRegistry();
  const runtime = registry.createConfiguredRuntime(configuration({
    cliEnv: {
      FAKE_OPENCODE_REQUIRE_MCP: '1',
      OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow', bash: 'allow' }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { build: { permission: { '*': 'allow' } } }, default_agent: 'build' }),
    },
  }));
  const result = await runtime.stream([{ role: 'user', content: 'Use Cuppet tools if needed.' }], {
    projectRoot: process.cwd(),
    tools: [{ name: 'workspace_read', description: 'Read a workspace file', inputSchema: { type: 'object', properties: {} } }],
    executeTool: async () => ({ ok: true }),
  });
  assert.equal(result.text, 'OpenCode ACP ready.');
});

test('warm OpenCode route opens fresh logical sessions without synthetic mode mutation', async () => {
  const registry = buildProviderBackendRegistry();
  const manager = new ProviderRuntimeManager();
  const adapter = registry.createConfiguredRuntime(configuration());
  const managed = manager.adapterFor({
    sessionId: 'opencode-warm-provider-default-test',
    projectRoot: process.cwd(),
    adapter,
  });
  try {
    const first = await managed.stream([{ role: 'user', content: 'First turn.' }], {});
    const second = await managed.stream([
      { role: 'user', content: 'First turn.' },
      { role: 'assistant', content: first.text },
      { role: 'user', content: 'Second turn.' },
    ], {});
    assert.equal(first.text, 'OpenCode ACP ready.');
    assert.equal(second.text, 'OpenCode ACP ready.');
    const snapshot = manager.conversationSnapshot('opencode-warm-provider-default-test');
    assert.equal(snapshot?.totalCompletedTurns, 2);
    assert.equal(snapshot?.completedTurns, 2);
    assert.equal(snapshot?.warmRuntimeCount, 1);
  } finally {
    await manager.close();
  }
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
