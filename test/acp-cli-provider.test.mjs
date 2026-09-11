import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpCliAgentProvider, acpCliDescriptor } from '../src/runtime/acp-cli-provider.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

test('ACP CLI provider delegates filesystem and terminal operations through Cuppet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-acp-'));
  await writeFile(join(root, 'sample.txt'), 'hello');
  const calls = [];
  const permissions = [];
  let streamed = '';
  const provider = new AcpCliAgentProvider({ providerID: 'opencode', cliCommand: process.execPath, cliArgs: [fixture] });
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


test('local ACP provider descriptors use official stdio entrypoints', () => {
  assert.deepEqual(acpCliDescriptor('github-copilot')?.args.slice(0, 2), ['--acp', '--stdio']);
  assert.equal(acpCliDescriptor('mistral-vibe')?.command, 'vibe-acp');
  assert.deepEqual(acpCliDescriptor('kiro')?.args, ['acp']);
  assert.equal(acpCliDescriptor('antigravity'), null);
});


test('Kiro ACP compatibility accepts content prompts and session/notification updates', async () => {
  const kiroFixture = fileURLToPath(new URL('./fixtures/fake-kiro-acp-agent.mjs', import.meta.url));
  const provider = new AcpCliAgentProvider({ providerID: 'kiro', cliCommand: process.execPath, cliArgs: [kiroFixture] });
  let streamed = '';
  const result = await provider.stream([{ role: 'user', content: 'Hello Kiro' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
    executeTool: async () => ({ success: false, output: 'unexpected tool call', paths: [], mutation: false }),
  });
  assert.equal(result.text, 'Kiro ready.');
  assert.equal(streamed, 'Kiro ready.');
});


test('ACP provider applies advertised model and reasoning effort and surfaces native activity', async () => {
  const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
  const provider = new AcpCliAgentProvider({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [configFixture],
    primary: { providerID: 'opencode', modelID: 'provider/model-b' },
    primaryEffort: 'max',
  });
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
