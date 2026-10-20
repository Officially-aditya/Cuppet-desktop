import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

function waitFor(events, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timed out waiting for event')); }
    }, 5);
  });
}

function backgroundStub() {
  return { stats: { paused: false, queued: 0, running: false }, async ready() {}, pause() {}, resume() {}, foregroundStarted() {}, foregroundIdle() {}, setProviderConfig() {}, async recordTurn() {}, async flushNow() { return { status: 'empty', candidates: 0 }; }, async close() {} };
}

function tstStub() {
  return {
    configured: false,
    status: { configured: false, connected: false },
    async runWithProject(_context, callback) { return callback(); },
    async turnCompleted() {},
    close() {},
  };
}

test('steer is appended to the running turn instead of stopping and restarting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-steer-'));
  const events = [];
  const requests = [];
  let releaseFirst;
  let markStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markStarted = resolve; });
  const adapter = {
    calls: 0,
    async stream(messages, { onDelta }) {
      this.calls += 1;
      requests.push(structuredClone(messages));
      if (this.calls === 1) {
        await onDelta('Checking the workspace…');
        markStarted();
        await firstGate;
        return { text: 'Checking the workspace…', toolCalls: [] };
      }
      assert.equal(messages.at(-1)?.role, 'user');
      assert.match(messages.at(-1)?.content ?? '', /Also update the docs/);
      await onDelta('Updated the plan and docs.');
      return { text: 'Updated the plan and docs.', toolCalls: [] };
    },
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: dir,
    emit: (event) => events.push(event),
    providerFactory: () => adapter,
    tst: tstStub(),
    planStore: { async capture() { return null; }, async setAgent() {}, async toolResult() { return 'plan'; } },
    interactive: false,
    backgroundFactory: backgroundStub,
  });
  try {
    const session = await runtime.handle('session.create');
    const sent = await runtime.handle('session.send', { sessionId: session.id, text: 'Start the task', provider: {} });
    await firstStarted;
    const steered = await runtime.handle('session.steer', { sessionId: session.id, text: 'Also update the docs.' });
    assert.equal(steered.steered, true);
    assert.equal(steered.messageId, sent.messageId);
    releaseFirst();
    await waitFor(events, (event) => event.type === 'run.finished');

    assert.equal(adapter.calls, 2);
    assert.equal(events.filter((event) => event.type === 'run.started').length, 1);
    assert.equal(events.some((event) => event.type === 'message.completed' && event.message?.status === 'stopped'), false);

    const stored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(stored.messages.map((message) => [message.role, message.content, message.status]), [
      ['user', 'Start the task', 'complete'],
      ['assistant', 'Checking the workspace…', 'complete'],
      ['user', 'Also update the docs.', 'complete'],
      ['assistant', 'Updated the plan and docs.', 'complete'],
    ]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('steer queued during one tool attaches to that tool result before the next tool runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-steer-batch-'));
  const events = [];
  let releaseFirstTool;
  let markFirstToolStarted;
  const toolGate = new Promise((resolve) => { releaseFirstTool = resolve; });
  const toolStarted = new Promise((resolve) => { markFirstToolStarted = resolve; });
  let planCalls = 0;
  let streams = 0;
  const adapter = {
    async stream(messages, { onDelta }) {
      streams += 1;
      if (streams === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'call_plan_first', name: 'cuppet_plan', arguments: '{"action":"overview"}' },
            { id: 'call_plan_second', name: 'cuppet_plan', arguments: '{"action":"phase","phaseID":"P1"}' },
          ],
        };
      }
      const toolMessages = messages.filter((message) => message.role === 'tool');
      assert.equal(toolMessages.length, 2);
      const first = toolMessages.find((message) => message.tool_call_id === 'call_plan_first');
      const second = toolMessages.find((message) => message.tool_call_id === 'call_plan_second');
      assert.match(first?.content ?? '', /FIRST PLAN/);
      assert.match(first?.content ?? '', /<CUPPET_USER_STEERING>/);
      assert.match(first?.content ?? '', /Check the second file too/);
      assert.doesNotMatch(second?.content ?? '', /<CUPPET_USER_STEERING>/);
      assert.equal(messages.at(-1)?.role, 'user');
      assert.match(messages.at(-1)?.content ?? '', /Check the second file too/);
      await onDelta('Handled both files.');
      return { text: 'Handled both files.', toolCalls: [] };
    },
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: dir,
    emit: (event) => events.push(event),
    providerFactory: () => adapter,
    tst: tstStub(),
    planStore: {
      async capture() { return null; },
      async setAgent() {},
      async toolResult() {
        planCalls += 1;
        if (planCalls === 1) {
          markFirstToolStarted();
          await toolGate;
          return 'FIRST PLAN';
        }
        return 'SECOND PLAN';
      },
    },
    interactive: false,
    backgroundFactory: backgroundStub,
  });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'Work on both files', provider: {} });
    await toolStarted;
    const steered = await runtime.handle('session.steer', { sessionId: session.id, text: 'Check the second file too.' });
    assert.equal(steered.steered, true);
    releaseFirstTool();
    await waitFor(events, (event) => event.type === 'run.finished');

    assert.equal(planCalls, 2);
    assert.equal(streams, 2);
    const stored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(stored.messages.map((message) => [message.role, message.content]), [
      ['user', 'Work on both files'],
      ['assistant', ''],
      ['user', 'Check the second file too.'],
      ['assistant', 'Handled both files.'],
    ]);
    assert.equal(stored.toolExecutions.length, 2);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('steer queued during a tool call is delivered with the last tool result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-steer-tool-'));
  const events = [];
  const requests = [];
  let releaseTool;
  let markToolStarted;
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  const toolStarted = new Promise((resolve) => { markToolStarted = resolve; });
  let calls = 0;
  const adapter = {
    async stream(messages, { onDelta }) {
      calls += 1;
      requests.push(structuredClone(messages));
      if (calls === 1) return { text: '', toolCalls: [{ id: 'call_plan', name: 'cuppet_plan', arguments: '{}' }] };
      const lastTool = [...messages].reverse().find((message) => message.role === 'tool');
      assert.match(lastTool?.content ?? '', /<CUPPET_USER_STEERING>/);
      assert.match(lastTool?.content ?? '', /Focus on the failing test/);
      assert.equal(messages.at(-1)?.role, 'user');
      assert.match(messages.at(-1)?.content ?? '', /Focus on the failing test/);
      await onDelta('Focused on the failing test.');
      return { text: 'Focused on the failing test.', toolCalls: [] };
    },
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: dir,
    emit: (event) => events.push(event),
    providerFactory: () => adapter,
    tst: tstStub(),
    planStore: {
      async capture() { return null; },
      async setAgent() {},
      async toolResult() {
        markToolStarted();
        await toolGate;
        return 'PLAN CONTENT';
      },
    },
    interactive: false,
    backgroundFactory: backgroundStub,
  });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'Work on the task', provider: {} });
    await toolStarted;
    const steered = await runtime.handle('session.steer', { sessionId: session.id, text: 'Focus on the failing test.' });
    assert.equal(steered.steered, true);
    releaseTool();
    await waitFor(events, (event) => event.type === 'run.finished');

    assert.equal(calls, 2);
    const stored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(stored.messages.map((message) => [message.role, message.content]), [
      ['user', 'Work on the task'],
      ['assistant', ''],
      ['user', 'Focus on the failing test.'],
      ['assistant', 'Focused on the failing test.'],
    ]);
    assert.equal(stored.toolExecutions.length, 1);
    assert.equal(stored.toolExecutions[0].messageId, stored.messages[1].id);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
