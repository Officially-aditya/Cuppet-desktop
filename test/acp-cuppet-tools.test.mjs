import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { resolveCuppetMcpServerScript } from '../src/runtime/providers/transports/acp/cuppet-mcp-tool-session.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-mcp-agent.mjs', import.meta.url));

test('ACP session receives Cuppet tools through MCP only when the backend explicitly advertises the bridge', async () => {
  const descriptor = {
    ...localCliDescriptor('claude-code'),
    id: 'mcp-fixture',
    label: 'MCP Fixture',
    mcpToolBridge: true,
  };
  const provider = new AcpProviderAdapter({ providerID: 'mcp-fixture', cliCommand: process.execPath, cliArgs: [fixture] }, { descriptor });
  const events = [];
  const runtime = new JournaledToolRuntime({
    journal: null,
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: (value) => { events.push(['tool-created', value.toolName]); return value; },
      finishToolExecution: (_id, value) => { events.push(['tool-finished', value.status]); return value; },
    },
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan-from-cuppet-runtime' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  const final = [];
  try {
    await runtime.run({
      adapter: provider,
      messages: [{ role: 'user', content: 'Use the Cuppet plan tool.' }],
      sessionId: 'session-mcp-1',
      projectRoot: tmpdir(),
      onDelta: async (value) => final.push(value),
    });
    assert.deepEqual(final, ['MCP:plan-from-cuppet-runtime']);
    assert.ok(events.some(([kind, value]) => kind === 'tool-created' && value === 'cuppet_plan'));
    assert.ok(events.some(([kind, value]) => kind === 'tool-finished' && value === 'complete'));
  } finally {
    await runtime.close?.();
  }
});

test('packaged MCP bridge prefers the unpacked on-disk entry when resources are available', () => {
  const resources = join(tmpdir(), 'Cuppet.app', 'Contents', 'Resources');
  const expected = join(resources, 'app.asar.unpacked', 'src', 'runtime', 'providers', 'transports', 'acp', 'cuppet-mcp-stdio.mjs');
  const result = resolveCuppetMcpServerScript({
    resourcesPath: resources,
    sourcePath: join(resources, 'app.asar', 'src', 'runtime', 'providers', 'transports', 'acp', 'cuppet-mcp-stdio.mjs'),
    exists: (path) => path === expected,
  });
  assert.equal(result, expected);
});

test('source MCP bridge path remains unchanged outside a packaged app', () => {
  const source = fileURLToPath(new URL('../src/runtime/providers/transports/acp/cuppet-mcp-stdio.mjs', import.meta.url));
  assert.equal(resolveCuppetMcpServerScript({ resourcesPath: '', sourcePath: source, exists: () => false }), source);
});
