import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { CuppetMcpToolSession } from '../src/runtime/providers/transports/acp/cuppet-mcp-tool-session.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const descriptor = localCliDescriptor('opencode');
assert.ok(descriptor, 'OpenCode descriptor is missing');
assert.equal(descriptor.transport, 'acp');
assert.deepEqual(descriptor.args, ['acp']);
assert.equal(descriptor.mcpToolBridge, true);
assert.equal(descriptor.requiredSessionSettings, undefined, 'OpenCode ACP must not require a synthetic Cuppet mode');

// The released OpenCode ACP process owns its normal CLI auth/provider/config state.
// Cuppet may add its execution permission overlay, but must never rewrite the
// highest-precedence inline configuration merely to launch ACP.
const inlineConfig = '{ /* provider-owned JSONC */ "theme": "system", }';
const environment = descriptor.environment({
  OPENCODE_CONFIG_CONTENT: inlineConfig,
  OPENCODE_SERVER_PASSWORD: 'provider-owned-secret-placeholder',
});
assert.equal(environment.OPENCODE_CONFIG_CONTENT, inlineConfig, 'OpenCode inline config was rewritten');
assert.equal(environment.OPENCODE_SERVER_PASSWORD, 'provider-owned-secret-placeholder', 'OpenCode inherited auth environment was dropped');
assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, '1');
assert.equal(environment.CUPPET_OPENCODE_AGENT_ID, undefined, 'synthetic OpenCode agent authority leaked back into ACP');
const permissions = JSON.parse(environment.OPENCODE_PERMISSION || '{}');
for (const native of ['*', 'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp', 'skill', 'external_directory']) {
  assert.equal(permissions[native], 'deny', `OpenCode native ${native} permission is not denied`);
}
assert.equal(permissions['cuppet-runtime_*'], 'allow');
assert.equal(permissions['cuppet_runtime_*'], 'allow');

const projectRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-acp-'));
const toolSession = new CuppetMcpToolSession({ sessionId: 'live-smoke', backendId: 'opencode' });
await toolSession.start();
toolSession.setTurn({
  tools: [{
    type: 'function',
    function: {
      name: 'cuppet_smoke_tool',
      description: 'Cuppet live ACP smoke tool. Do not call outside the smoke test.',
      parameters: { type: 'object', properties: {} },
    },
  }],
  executeTool: async () => ({ success: true, output: 'smoke-ok' }),
});

const runtime = new AcpSessionRuntime({
  descriptor,
  configuration: {
    providerID: 'opencode',
    cliCommand: process.env.CUPPET_OPENCODE_BIN || 'opencode',
  },
  projectRoot,
});

try {
  const first = await runtime.start({ mcpServers: [toolSession.descriptor()] });
  assert.equal(first.state, 'ready');
  assert.ok(first.sessionId, 'released OpenCode ACP did not return a first session id');

  const capabilities = await runtime.capabilities();
  assert.ok(capabilities && typeof capabilities === 'object', 'released OpenCode ACP did not expose a capability snapshot');
  console.log(`OpenCode ACP capabilities: ${JSON.stringify({
    models: capabilities.models,
    settings: capabilities.settings,
  })}`);

  // Provider V2 owns durable context and opens a fresh provider logical session
  // for each Cuppet turn. Exercise the released package's session/close +
  // session/new path without imposing a Cuppet-specific model or mode contract.
  const second = await runtime.newSession({ mcpServers: [toolSession.descriptor()] });
  assert.equal(second.state, 'ready');
  assert.ok(second.sessionId, 'released OpenCode ACP did not return a second session id');
  assert.notEqual(second.sessionId, first.sessionId, 'released OpenCode ACP reused a retired logical session id');

  console.log(`OpenCode ACP + Cuppet MCP smoke passed: first=${first.sessionId} second=${second.sessionId}`);
} finally {
  await runtime.close().catch(() => undefined);
  await toolSession.close().catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
}
