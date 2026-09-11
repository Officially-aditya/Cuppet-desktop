import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';
import { providerPreset } from '../src/main/provider-presets.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

const sessionMetaFixture = fileURLToPath(new URL('./fixtures/fake-acp-session-meta-agent.mjs', import.meta.url));

test('Claude Code is a managed ACP backend with Cuppet-only execution policy', () => {
  const descriptor = localCliDescriptor('claude-code');
  assert.equal(descriptor.transport, 'acp');
  assert.equal(descriptor.command, 'claude-agent-acp');
  assert.deepEqual(descriptor.sessionMeta, { disableBuiltInTools: true });

  const provider = createUntrackedChatProvider({ providerID: 'claude-code', model: 'cli-default' });
  const managed = provider.cuppetManagedRuntime();
  assert.equal(managed.protocol, 'acp');
  assert.equal(managed.backendId, 'claude-code');
  assert.deepEqual(managed.descriptor.sessionMeta, { disableBuiltInTools: true });
});

test('Claude Code ACP session forwards descriptor metadata that disables native tools', async () => {
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

test('Claude Code provider preset and connection flow preserve Claude-owned auth', () => {
  const preset = providerPreset('claude-code');
  assert.equal(preset.authType, 'local-cli');
  assert.equal(preset.baseUrl, 'cli://claude-code');
  assert.equal(preset.model, 'cli-default');

  const macInstall = installSpec('claude-code', 'darwin');
  assert.equal(macInstall.command, '/bin/bash');
  assert.match(macInstall.args.join(' '), /@agentclientprotocol\/claude-agent-acp/);

  const windowsInstall = installSpec('claude-code', 'win32');
  assert.equal(windowsInstall.command, 'powershell.exe');
  assert.match(windowsInstall.args.join(' '), /@agentclientprotocol\/claude-agent-acp/);

  const login = loginSpec('claude-code', 'claude-agent-acp');
  assert.equal(login.command, 'claude-agent-acp');
  assert.deepEqual(login.args, ['--cli', 'auth', 'login']);
});
