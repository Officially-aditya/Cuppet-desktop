import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';
import { fetchProviderModelCatalog } from '../src/main/provider-model-catalog.mjs';
import { providerPreset } from '../src/main/provider-presets.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

const sessionMetaFixture = fileURLToPath(new URL('./fixtures/fake-acp-session-meta-agent.mjs', import.meta.url));
const hostBridgeFixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));

test('Claude Code keeps its native ACP agent layer and receives Cuppet tools through MCP', () => {
  const descriptor = localCliDescriptor('claude-code');
  assert.equal(descriptor.transport, 'acp');
  assert.equal(descriptor.command, 'claude-agent-acp');
  assert.equal(descriptor.sessionMeta, undefined);
  assert.equal(descriptor.mcpToolBridge, true);

  // Callers receive independent descriptors; runtime configuration cannot
  // disable Claude's native prompt, tools, or settings for other sessions.
  descriptor.mcpToolBridge = false;
  assert.equal(localCliDescriptor('claude-code').mcpToolBridge, true);

  const provider = createUntrackedChatProvider({ providerID: 'claude-code', model: 'cli-default' });
  const managed = provider.cuppetManagedRuntime();
  assert.equal(managed.protocol, 'acp');
  assert.equal(managed.backendId, 'claude-code');
  assert.equal(managed.descriptor.sessionMeta, undefined);
  assert.equal(managed.descriptor.mcpToolBridge, true);
});

test('Claude Code ACP session receives no Cuppet session metadata overrides', async () => {
  const descriptor = localCliDescriptor('claude-code');
  const runtime = new AcpSessionRuntime({
    descriptor,
    configuration: { providerID: 'claude-code', cliCommand: process.execPath, cliArgs: [sessionMetaFixture], model: 'cli-default' },
    projectRoot: tmpdir(),
  });
  try {
    await runtime.start();
    const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'Use Cuppet tools.' }] });
    assert.equal(result.text, 'Done.');
  } finally {
    await runtime.close();
  }
});

test('Claude Code retains ACP host file and terminal capabilities alongside its MCP tool server', async () => {
  const provider = createUntrackedChatProvider({
    providerID: 'claude-code',
    model: 'cli-default',
    cliCommand: process.execPath,
    cliArgs: [hostBridgeFixture],
  });
  const calls = [];
  const permissions = [];
  let streamed = '';
  const result = await provider.stream([{ role: 'user', content: 'Use Cuppet execution.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
    requestAgentPermission: async (request) => { permissions.push(request); return 'once'; },
    executeTool: async (call) => {
      calls.push(call);
      if (call.name === 'workspace_read') return { success: true, output: 'hello', paths: ['sample.txt'], mutation: false };
      if (call.name === 'workspace_write') return { success: true, output: 'written', paths: ['sample.txt'], mutation: true };
      if (call.name === 'bash') return { success: true, output: 'stdout:\nok\nexit code: 0', paths: [], mutation: false };
      return { success: false, output: `unexpected ${call.name}`, paths: [], mutation: false };
    },
  });
  assert.equal(result.text, 'Working. Done.');
  assert.equal(streamed, 'Working. Done.');
  assert.deepEqual(calls.map((call) => call.name), ['workspace_read', 'workspace_write', 'bash']);
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].kind, 'edit');
});

test('Claude Code model and effort discovery uses the shared ACP capability parser', async () => {
  const catalog = await fetchProviderModelCatalog({
    providerID: 'claude-code',
    cliCommand: process.execPath,
    cliArgs: [configFixture],
    primary: { modelID: 'provider/model-b' },
    primaryEffort: 'max',
  });
  assert.equal(catalog.source, 'acp');
  assert.deepEqual(catalog.models.map((item) => item.id), ['provider/model-a', 'provider/model-b']);
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.configuredModel, 'provider/model-b');
  assert.equal(catalog.reasoning.currentValue, 'medium');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['medium', 'max']);
});

test('Claude Code provider preset and connection flow preserve Claude-owned auth', () => {
  const preset = providerPreset('claude-code');
  assert.equal(preset.authType, 'local-cli');
  assert.equal(preset.baseUrl, 'cli://claude-code');
  assert.equal(preset.model, 'cli-default');

  const macInstall = installSpec('claude-code', 'darwin');
  assert.equal(macInstall.command, '/bin/bash');
  assert.match(macInstall.args.join(' '), /@agentclientprotocol\/claude-agent-acp/);
  assert.match(macInstall.args.join(' '), /--prefix "\$HOME\/\.local"/);
  assert.match(macInstall.args.join(' '), /__CUPPET_INSTALLED_CLI__/);

  const windowsInstall = installSpec('claude-code', 'win32');
  assert.equal(windowsInstall.command, 'powershell.exe');
  assert.match(windowsInstall.args.join(' '), /@agentclientprotocol\/claude-agent-acp/);

  const login = loginSpec('claude-code', 'claude-agent-acp');
  assert.equal(login.command, 'claude-agent-acp');
  assert.deepEqual(login.args, ['--cli', 'auth', 'login']);
});
