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
assert.equal(descriptor.mcpToolBridge, true);
assert.ok(Array.isArray(descriptor.requiredSessionSettings) && descriptor.requiredSessionSettings.length > 0, 'OpenCode guarded mode is missing');

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

  // Provider V2 deliberately owns durable context and opens a fresh provider
  // logical session for each Cuppet turn. This second session therefore exercises
  // stable ACP session/close + session/new against the released OpenCode package,
  // plus re-application of the mandatory Cuppet execution mode.
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
