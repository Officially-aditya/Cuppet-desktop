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

test('Copilot keeps ambiguous pre-tool text out of the live assistant preview', async () => {
  const emitted = [];
  const finalDeltas = [];
  const descriptor = {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    transport: 'acp',
    command: 'copilot',
    args: [],
    envOverride: '',
    textStream: { framing: 'tokenized-whitespace', preview: 'defer-unclassified' },
  };
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => ({
      async start() {},
      async newSession() {},
      async runTurn(_input, hooks) {
        await hooks.onText('the\n\nrepository\n\nand\n\nreport\n\nits\n\nstatus');
        const toolResult = await hooks.executeTool({ id: 'call-preview', name: 'cuppet_plan', arguments: '{"action":"overview"}' });
        assert.equal(toolResult.success, true);
        await hooks.onText('Final answer.');
        return { text: 'the repository and report its status Final answer.', usage: null, stopReason: 'end_turn' };
      },
      async cancel() {},
      async close() {},
    }),
  });
  const adapter = {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'github-copilot',
      descriptor,
      configuration: { providerID: 'github-copilot' },
    }),
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    emit: (event) => emitted.push(event),
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-preview', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: () => ({}),
      finishToolExecution: () => ({}),
    },
    providerRuntimeManager: manager,
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  try {
    await runtime.run({
      adapter,
      messages: [{ role: 'user', content: 'Inspect the repository.' }],
      sessionId: 'chat-copilot-preview',
      projectRoot: null,
      onDelta: async (delta) => finalDeltas.push(delta),
    });
    const previews = emitted.filter((event) => event.type === 'message.preview').map((event) => String(event.content ?? ''));
    assert.ok(!previews.some((content) => content.includes('repository')));
    assert.deepEqual(finalDeltas, ['Final answer.']);
    const reasoning = emitted.filter((event) => event.type === 'runtime.activity' && event.source === 'provider' && event.activity?.type === 'activity.reasoning.delta');
    assert.ok(reasoning.some((event) => String(event.activity.text).includes('repository')));
  } finally {
    await runtime.close();
  }
});

test('aborting deferred provider text does not persist ambiguous pre-tool content', async () => {
  const emitted = [];
  const finalDeltas = [];
  const controller = new AbortController();
  const descriptor = {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    transport: 'acp',
    command: 'copilot',
    args: [],
    envOverride: '',
    textStream: { framing: 'tokenized-whitespace', preview: 'defer-unclassified' },
  };
  const adapter = {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'github-copilot',
      descriptor,
      configuration: { providerID: 'github-copilot' },
    }),
    async stream(_messages, { onDelta }) {
      await onDelta('ambiguous pre-tool text');
      controller.abort();
      const error = new Error('stopped');
      error.name = 'AbortError';
      throw error;
    },
  };
  const manager = {
    adapterFor: ({ adapter: selected }) => selected,
    async close() {},
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    emit: (event) => emitted.push(event),
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-abort', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: () => ({}),
      finishToolExecution: () => ({}),
    },
    providerRuntimeManager: manager,
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  try {
    await assert.rejects(
      runtime.run({
        adapter,
        messages: [{ role: 'user', content: 'Inspect the repository.' }],
        sessionId: 'chat-copilot-abort',
        projectRoot: null,
        signal: controller.signal,
        onDelta: async (delta) => finalDeltas.push(delta),
      }),
      (error) => error?.name === 'AbortError',
    );
    assert.deepEqual(finalDeltas, []);
    const previews = emitted.filter((event) => event.type === 'message.preview').map((event) => String(event.content ?? ''));
    assert.ok(!previews.some((content) => content.includes('ambiguous')));
  } finally {
    await runtime.close();
  }
});

test('malformed provider telemetry and host emit failures cannot fail a successful turn', async () => {
  const adapter = {
    async stream(_messages, options) {
      await options.onProviderEvent?.({ type: 'tool.started', tool: 'broken-without-call-id' });
      options.onDelta('Done.');
      return { text: 'Done.', toolCalls: [] };
    },
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    emit: () => { throw new Error('renderer event observer failed'); },
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
    const result = await runtime.run({
      adapter,
      messages: [{ role: 'user', content: 'work' }],
      sessionId: 'chat-observer-failure',
      projectRoot: null,
      onDelta: async () => {},
    });
    assert.equal(result.usage, null);
  } finally {
    await runtime.close();
  }
});

test('renderer consumes canonical Activity directly and preload suppresses duplicate legacy activity', async () => {
  const [preload, chat] = await Promise.all([
    readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(preload, /LEGACY_ACTIVITY_EVENTS/);
  assert.match(preload, /callback\(payload\)/);
  assert.doesNotMatch(preload, /projectActivityForLegacyUi/);
  assert.match(chat, /event\.type === 'runtime\.activity'/);
  assert.match(chat, /event\.source === 'provider'.*activity\.reasoning\.delta/s);
  assert.match(chat, /event\.source === 'execution'.*activity\.tool\./s);
  assert.match(chat, /appendReasoningTrace/);
  assert.match(chat, /updateToolTraceFromActivity/);
  assert.match(chat, /sequence: existing\?\.sequence \?\? nextTraceSequence\(trace\)/);
  assert.match(chat, /const ordered = orderedTrace\(trace\)/);
  assert.match(chat, /const \[traceOpen, setTraceOpen\] = useState\(live\)/);
  assert.match(chat, /hasTrace && traceOpen && <TraceView trace=\{trace\} \/>/);
  assert.doesNotMatch(chat, /hasTrace && live && <TraceView/);
  assert.doesNotMatch(chat, /event\.type === 'message\.reasoning'/);
  assert.doesNotMatch(chat, /event\.type === 'tool\.started'.*event\.type === 'tool\.finished'/s);
});
