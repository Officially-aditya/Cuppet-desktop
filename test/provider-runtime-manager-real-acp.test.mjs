import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const kiroFixture = fileURLToPath(new URL('./fixtures/fake-kiro-acp-agent.mjs', import.meta.url));

test('production runtime manager does not inject external MCP into ACP providers unless explicitly supported', async () => {
  const descriptor = localCliDescriptor('kiro');
  assert.equal(descriptor.mcpToolBridge, undefined);
  const adapter = new AcpProviderAdapter({
    providerID: 'kiro',
    cliCommand: process.execPath,
    cliArgs: [kiroFixture],
  }, { descriptor });
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {} });
  let output = '';
  try {
    const result = await manager.adapterFor({ sessionId: 'kiro-chat', projectRoot: tmpdir(), adapter }).stream(
      [{ role: 'user', content: 'Hello Kiro' }],
      {
        tools: [{ type: 'function', function: { name: 'cuppet_plan', description: 'Plan', parameters: { type: 'object', properties: {} } } }],
        executeTool: async () => ({ success: true, output: 'unused' }),
        onDelta: async (delta) => { output += delta; },
      },
    );
    assert.equal(result.text, 'Kiro ready.');
    assert.equal(output, 'Kiro ready.');
  } finally {
    await manager.close();
  }
});
