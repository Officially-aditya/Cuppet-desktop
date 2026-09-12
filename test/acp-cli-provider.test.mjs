import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { capabilitiesFromAcpSession } from '../src/runtime/providers/transports/acp/acp-capabilities.mjs';
import { discoverAcpRuntimeCatalog } from '../src/runtime/providers/transports/acp/acp-discovery.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const kiroFixture = fileURLToPath(new URL('./fixtures/fake-kiro-acp-agent.mjs', import.meta.url));

test('shared ACP provider delegates filesystem and terminal operations through Cuppet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-acp-'));
  await writeFile(join(root, 'sample.txt'), 'hello');
  const calls = [];
  const permissions = [];
  let streamed = '';
  const provider = new AcpProviderAdapter({ providerID: 'claude-code', cliCommand: process.execPath, cliArgs: [fixture] }, { descriptor: localCliDescriptor('claude-code') });
  try {
    const result = await provider.stream([{ role: 'user', content: 'Update the sample.' }], {
      projectRoot: root,
      onDelta: async (delta) => { streamed += delta; },
      requestAgentPermission: async (request) => { permissions.push(request); return 'once'; },
      executeTool: async (call) => {
        calls.push(call);
        const args = JSON.parse(call.arguments);
        if (call.name === 'workspace_read') return { success: true, output: 'hello', paths: ['sample.txt'], mutation: false };
        if (call.name === 'workspace_write') return { success: true, output: `Wrote ${args.path}`, paths: ['sample.txt'], mutation: true };
        if (call.name === 'bash') return { success: true, output: 'stdout:\nok\nexit code: 0', paths: [], mutation: false };
        return { success: false, output: `unexpected ${call.name}`, paths: [], mutation: false };
      },
    });
    assert.equal(result.text, 'Working. Done.');
    assert.equal(streamed, 'Working. Done.');
    assert.deepEqual(calls.map((call) => call.name), ['workspace_read', 'workspace_write', 'bash']);
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].kind, 'edit');
    assert.equal(result.usage.totalTokens, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider descriptors use their current official transport entrypoints', () => {
  assert.deepEqual(localCliDescriptor('github-copilot')?.args.slice(0, 2), ['--acp', '--stdio']);
  assert.equal(localCliDescriptor('mistral-vibe')?.command, 'vibe-acp');
  assert.deepEqual(localCliDescriptor('kiro')?.args, ['acp']);
  assert.deepEqual(localCliDescriptor('kiro')?.sessionCommandSettings, [{
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    command: 'effort',
    optionsMethod: '_kiro.dev/commands/options',
    executeMethod: '_kiro.dev/commands/execute',
  }]);
  assert.equal(localCliDescriptor('opencode')?.transport, 'acp');
  assert.deepEqual(localCliDescriptor('opencode')?.args, ['acp']);
  assert.equal(localCliDescriptor('antigravity')?.transport, 'managed-acp');
});

test('shared ACP capability parser accepts grouped config options and legacy model state', () => {
  const stable = capabilitiesFromAcpSession({
    configOptions: [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'provider/model-b',
      options: [
        { group: 'Recommended', options: [{ value: 'provider/model-a', name: 'Model A' }] },
        { group: 'More', options: [{ value: 'provider/model-b', name: 'Model B' }] },
      ],
    }],
  });
  assert.deepEqual(stable.models.map((item) => item.id), ['provider/model-a', 'provider/model-b']);
  assert.equal(stable.settings.find((item) => item.category === 'model')?.value, 'provider/model-b');

  const legacy = capabilitiesFromAcpSession({
    models: {
      availableModels: [{ modelId: 'kiro/model-a', name: 'Kiro A' }, { modelId: 'kiro/model-b', name: 'Kiro B' }],
      currentModelId: 'kiro/model-a',
    },
  });
  assert.deepEqual(legacy.models.map((item) => item.id), ['kiro/model-a', 'kiro/model-b']);
  assert.equal(legacy.settings.find((item) => item.category === 'model')?.value, 'kiro/model-a');
});

test('Kiro ACP compatibility accepts standard prompt requests and session/notification updates', async () => {
  const provider = new AcpProviderAdapter({ providerID: 'kiro', cliCommand: process.execPath, cliArgs: [kiroFixture] }, { descriptor: localCliDescriptor('kiro') });
  let streamed = '';
  const result = await provider.stream([{ role: 'user', content: 'Hello Kiro' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
    executeTool: async () => ({ success: false, output: 'unexpected tool call', paths: [], mutation: false }),
  });
  assert.equal(result.text, 'Kiro ready.');
  assert.equal(streamed, 'Kiro ready.');
});

test('Kiro legacy ACP models and model-dependent effort normalize into the shared catalog', async () => {
  const catalog = await discoverAcpRuntimeCatalog('kiro', {
    descriptor: localCliDescriptor('kiro'),
    configuration: {
      providerID: 'kiro',
      cliCommand: process.execPath,
      cliArgs: [kiroFixture],
      primary: { providerID: 'kiro', modelID: 'kiro/model-b' },
    },
    cwd: tmpdir(),
  });

  assert.deepEqual(catalog.models.map((item) => item.id), ['kiro/model-a', 'kiro/model-b']);
  assert.equal(catalog.defaultModel, 'kiro/model-a');
  assert.equal(catalog.currentModel, 'kiro/model-b');
  assert.equal(catalog.reasoning?.configId, 'effort');
  assert.equal(catalog.reasoning?.currentValue, 'medium');
  assert.deepEqual(catalog.reasoning?.options.map((item) => item.id), ['medium', 'xhigh', 'max']);
});

test('Kiro applies legacy session/set_model before its command-backed reasoning effort', async () => {
  const provider = new AcpProviderAdapter({
    providerID: 'kiro',
    cliCommand: process.execPath,
    cliArgs: [kiroFixture],
    primary: { providerID: 'kiro', modelID: 'kiro/model-b' },
    primaryEffort: 'max',
  }, { descriptor: localCliDescriptor('kiro') });

  const result = await provider.stream([{ role: 'user', content: 'ASSERT_CONFIG' }], { projectRoot: tmpdir() });
  assert.equal(result.text, 'Kiro ready.');
});

test('shared ACP provider applies advertised model and reasoning effort and surfaces native activity', async () => {
  const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
  const provider = new AcpProviderAdapter({
    providerID: 'claude-code',
    cliCommand: process.execPath,
    cliArgs: [configFixture],
    primary: { providerID: 'claude-code', modelID: 'provider/model-b' },
    primaryEffort: 'max',
  }, { descriptor: localCliDescriptor('claude-code') });
  const activity = [];
  let streamed = '';
  const result = await provider.stream([{ role: 'user', content: 'Inspect.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
    onProviderEvent: async (event) => { activity.push(event); },
  });
  assert.equal(result.text, 'Done.');
  assert.equal(streamed, 'Done.');
  assert.deepEqual(activity.map((event) => event.type), ['reasoning', 'tool.started', 'tool.finished']);
  assert.equal(activity[0].text, 'Inspecting project.');
  assert.equal(activity[1].callId, 'tool-1');
  assert.equal(activity[1].tool, 'Search files');
  assert.equal(activity[2].success, true);
});
