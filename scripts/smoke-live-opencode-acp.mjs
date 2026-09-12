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
  const snapshot = await runtime.start({ mcpServers: [toolSession.descriptor()] });
  assert.equal(snapshot.state, 'ready');
  assert.ok(snapshot.sessionId, 'released OpenCode ACP did not return a session id');

  const capabilities = await runtime.capabilities();
  assert.ok(capabilities && typeof capabilities === 'object', 'released OpenCode ACP did not expose a capability snapshot');

  console.log(`OpenCode ACP + Cuppet MCP smoke passed: session=${snapshot.sessionId}`);
} finally {
  await runtime.close().catch(() => undefined);
  await toolSession.close().catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
}
