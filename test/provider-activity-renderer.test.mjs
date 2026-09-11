import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { activityFromToolRuntimeEvent, providerActivity } from '../src/runtime/providers/activity.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';

function managedAdapter(config = { providerID: 'opencode' }) {
  return {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'opencode',
      descriptor: { id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: [], envOverride: '', loginHint: '' },
      configuration: config,
    }),
  };
}

test('ToolRuntime events normalize to Cuppet execution Activity', () => {
  const opened = activityFromToolRuntimeEvent({
    type: 'tool.started', executionId: 'execution-1', callId: 'call-1', tool: 'tst_read', argumentsJson: '{"path":"a.ts"}',
  });
  assert.equal(opened.type, 'activity.tool.opened');
  assert.equal(opened.executionId, 'execution-1');
  assert.equal(opened.callId, 'call-1');
  assert.equal(opened.tool, 'tst_read');

  const closed = activityFromToolRuntimeEvent({
    type: 'tool.finished', executionId: 'execution-1', callId: 'call-1', tool: 'tst_read', success: false, message: 'failed',
  });
  assert.equal(closed.type, 'activity.tool.closed');
  assert.equal(closed.status, 'error');
  assert.equal(closed.details, 'failed');
});

test('managed ACP forwards canonical Activity without re-materializing legacy provider events', async () => {
  const legacy = [];
  const activities = [];
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => ({
      async start() {},
      async newSession() {},
      async runTurn(_input, hooks) {
        await hooks.onActivity(providerActivity('activity.reasoning.delta', { text: 'Inspecting.' }));
        return { text: '', usage: null };
      },
      async cancel() {},
      async close() {},
    }),
  });
  try {
    await manager.adapterFor({ sessionId: 'chat-activity', adapter: managedAdapter() }).stream([], {
      onActivity: async (activity) => activities.push(activity),
      onProviderEvent: async (event) => legacy.push(event),
    });
    assert.deepEqual(activities.map((activity) => activity.type), ['activity.reasoning.delta']);
    assert.deepEqual(legacy, []);
  } finally {
    await manager.close();
  }
});

test('JournaledToolRuntime emits separate provider and execution Activity envelopes', async () => {
  const emitted = [];
  const adapter = {
    async stream(_messages, options) {
      await options.onProviderEvent?.({ type: 'reasoning', text: 'Legacy provider thought.' });
      const result = await options.executeTool({ id: 'call-1', name: 'cuppet_plan', arguments: '{"action":"overview"}' });
      assert.equal(result.success, true);
      options.onDelta('Done.');
      return { text: 'Done.', toolCalls: [] };
    },
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    emit: (event) => emitted.push(event),
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: () => ({}),
      finishToolExecution: () => ({}),
    },
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  try {
    await runtime.run({
      adapter,
      messages: [{ role: 'user', content: 'work' }],
      sessionId: 'chat-activity',
      projectRoot: null,
      onDelta: async () => {},
    });
    const activities = emitted.filter((event) => event.type === 'runtime.activity');
    assert.ok(activities.some((event) => event.source === 'provider' && event.activity.type === 'activity.reasoning.delta'));
    assert.ok(activities.some((event) => event.source === 'execution' && event.activity.type === 'activity.tool.opened' && event.activity.tool === 'cuppet_plan'));
    assert.ok(activities.some((event) => event.source === 'execution' && event.activity.type === 'activity.tool.closed' && event.activity.status === 'success'));
  } finally {
    await runtime.close();
  }
});

test('preload renderer bridge makes Activity authoritative and suppresses duplicate legacy activity', async () => {
  const source = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8');
  assert.match(source, /payload\?\.type === 'runtime\.activity'/);
  assert.match(source, /LEGACY_ACTIVITY_EVENTS/);
  assert.match(source, /payload\.source === 'provider'.*activity\.reasoning\.delta/s);
  assert.match(source, /payload\.source !== 'execution'/);
  assert.match(source, /activity\.tool\.closed/);
});
