import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { OpenCodeServerProvider, discoverOpenCodeModels } from '../src/runtime/providers/backends/opencode.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-opencode-server.mjs', import.meta.url));

test('OpenCode uses managed serve/http transport with Cuppet-owned execution authority', async () => {
  let streamed = '';
  const provider = new OpenCodeServerProvider({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [fixture],
    primary: { providerID: 'opencode', modelID: 'anthropic/test-model', variant: 'high' },
  });
  const result = await provider.stream([{ role: 'user', content: 'Hello OpenCode.' }], {
    projectRoot: tmpdir(),
    tools: [{ type: 'function', function: { name: 'workspace_read', description: 'Read workspace', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => ({ success: true, output: 'fixture', contentItems: [] }),
    onDelta: async (delta) => { streamed += delta; },
  });
  assert.equal(result.text, 'OpenCode ready.');
  assert.equal(streamed, 'OpenCode ready.');
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.cachedInputTokens, 1);
  assert.equal(result.usage.reasoningTokens, 1);
});

test('OpenCode model discovery uses provider CLI inventory, not ACP session startup', async () => {
  const catalog = await discoverOpenCodeModels(localCliDescriptor('opencode'), {
    configuration: { cliCommand: process.execPath, cliArgs: [fixture] },
  });
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ['anthropic/test-model', 'openai/test-model']);
});
