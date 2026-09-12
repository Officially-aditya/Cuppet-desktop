import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const descriptor = localCliDescriptor('opencode');
assert.ok(descriptor, 'OpenCode descriptor is missing');
assert.equal(descriptor.transport, 'acp');

const projectRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-acp-'));
const runtime = new AcpSessionRuntime({
  descriptor,
  configuration: {
    providerID: 'opencode',
    cliCommand: process.env.CUPPET_OPENCODE_BIN || 'opencode',
  },
  projectRoot,
});

try {
  const snapshot = await runtime.start({ mcpServers: [] });
  assert.equal(snapshot.state, 'ready');
  assert.ok(snapshot.sessionId, 'released OpenCode ACP did not return a session id');

  const capabilities = await runtime.capabilities();
  assert.ok(capabilities && typeof capabilities === 'object', 'released OpenCode ACP did not expose a capability snapshot');

  console.log(`OpenCode ACP smoke passed: session=${snapshot.sessionId}`);
} finally {
  await runtime.close().catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
}
