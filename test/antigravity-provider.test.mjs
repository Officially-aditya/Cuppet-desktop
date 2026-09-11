import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AntigravityHeadlessProvider } from '../src/runtime/antigravity-provider.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-antigravity-agent.mjs', import.meta.url));

test('Antigravity provider stays in safe headless plan/sandbox mode', async () => {
  let streamed = '';
  const provider = new AntigravityHeadlessProvider({ providerID: 'antigravity', cliCommand: process.execPath, cliArgs: [fixture] });
  const result = await provider.stream([{ role: 'user', content: 'Inspect this project.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
  });
  assert.equal(result.text, 'Plan ready.');
  assert.equal(streamed, 'Plan ready.');
  assert.equal(result.usage.totalTokens, 14);
  assert.equal(result.usage.cachedInputTokens, 4);
  assert.equal(result.usage.reasoningTokens, 2);
});
