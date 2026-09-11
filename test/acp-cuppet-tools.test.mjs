import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-mcp-agent.mjs', import.meta.url));

test('ACP session receives Cuppet tools through MCP and calls back into ToolRuntime', async () => {
  const provider = new AcpProviderAdapter({ providerID: 'opencode', cliCommand: process.execPath, cliArgs: [fixture] });
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
