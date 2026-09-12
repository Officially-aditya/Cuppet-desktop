import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));

test('ACP changes model and effort between logical sessions without restarting its process', async () => {
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('claude-code'),
    configuration: { cliCommand: process.execPath, cliArgs: [configFixture] },
    projectRoot: tmpdir(),
  });
  try {
    await runtime.start({ selection: { model: 'provider/model-a', effort: 'high' } });
    let capabilities = await runtime.capabilities();
    assert.equal(capabilities.settings.find((item) => item.id === 'model')?.value, 'provider/model-a');
    assert.equal(capabilities.settings.find((item) => item.id === 'effort')?.value, 'high');

    await runtime.newSession({ selection: { model: 'provider/model-b', effort: 'max' } });
    capabilities = await runtime.capabilities();
    assert.equal(capabilities.settings.find((item) => item.id === 'model')?.value, 'provider/model-b');
    assert.equal(capabilities.settings.find((item) => item.id === 'effort')?.value, 'max');

    const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'Use the switched selection.' }] });
    assert.equal(result.text, 'Done.');
    assert.equal(runtime.snapshot().state, 'ready');
  } finally {
    await runtime.close();
  }
});
