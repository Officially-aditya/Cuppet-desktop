import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';
import { fetchProviderModelCatalog } from '../src/main/provider-model-catalog.mjs';
import { providerPreset } from '../src/main/provider-presets.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

const sessionMetaFixture = fileURLToPath(new URL('./fixtures/fake-acp-session-meta-agent.mjs', import.meta.url));
const mcpFixture = fileURLToPath(new URL('./fixtures/fake-acp-mcp-agent.mjs', import.meta.url));
const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const CLAUDE_SESSION_META = {
  disableBuiltInTools: true,
  claudeCode: { options: { settingSources: [] } },
};

test('Claude Code is a managed ACP backend with isolated Cuppet execution policy', () => {
  const descriptor = localCliDescriptor('claude-code');
  assert.equal(descriptor.transport, 'acp');
  assert.equal(descriptor.command, 'claude-agent-acp');
  assert.deepEqual(descriptor.sessionMeta, CLAUDE_SESSION_META);

  // Callers receive a deep clone so provider/runtime code cannot mutate the
  // canonical descriptor and re-enable Claude project/user setting sources.
  descriptor.sessionMeta.claudeCode.options.settingSources.push('project');
  assert.deepEqual(localCliDescriptor('claude-code').sessionMeta, CLAUDE_SESSION_META);

  const provider = createUntrackedChatProvider({ providerID: 'claude-code', model: 'cli-default' });
  const managed = provider.cuppetManagedRuntime();
  assert.equal(managed.protocol, 'acp');
  assert.equal(managed.backendId, 'claude-code');
  assert.deepEqual(managed.descriptor.sessionMeta, CLAUDE_SESSION_META);
});

test('Claude Code ACP session forwards descriptor metadata that isolates native execution and settings', async () => {
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

test('Claude Code receives the same Cuppet MCP tools and ExecutionKernel path as OpenCode', async () => {
  const provider = createUntrackedChatProvider({
    providerID: 'claude-code',
    model: 'cli-default',
    cliCommand: process.execPath,
    cliArgs: [mcpFixture],
  });
  const events = [];
  const runtime = new JournaledToolRuntime({
    journal: null,
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: (value) => { events.push(['tool-created', value.toolName]); return value; },
      finishToolExecution: (_id, value) => { events.push(['tool-finished', value.status]); return value; },
    },
    tst: { configured: false },
    planStore: { toolResult: async () => 'claude-plan-through-cuppet' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  const final = [];
  try {
    await runtime.run({
      adapter: provider,
      messages: [{ role: 'user', content: 'Use Cuppet tools.' }],
      sessionId: 'claude-mcp-session',
      projectRoot: tmpdir(),
      onDelta: async (value) => final.push(value),
    });
    assert.deepEqual(final, ['MCP:claude-plan-through-cuppet']);
    assert.ok(events.some(([kind, value]) => kind === 'tool-created' && value === 'cuppet_plan'));
    const metrics = runtime.executionSnapshot('claude-mcp-session');
    assert.equal(metrics.semanticExecuted, 1);
    assert.equal(metrics.rawFallbackExecuted, 0);
  } finally {
    await runtime.close();
  }
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

  const windowsInstall = installSpec('claude-code', 'win32');
  assert.equal(windowsInstall.command, 'powershell.exe');
  assert.match(windowsInstall.args.join(' '), /@agentclientprotocol\/claude-agent-acp/);

  const login = loginSpec('claude-code', 'claude-agent-acp');
  assert.equal(login.command, 'claude-agent-acp');
  assert.deepEqual(login.args, ['--cli', 'auth', 'login']);
});
