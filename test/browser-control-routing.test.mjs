import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeService } from '../src/runtime/service.mjs';

function browserTool(name) {
  return { type: 'function', function: { name, description: 'Connected Chrome tool', parameters: { type: 'object', properties: {} } } };
}

async function waitForTurn(events, messageId) {
  for (let i = 0; i < 300; i++) {
    if (events.some((event) => event.type === 'run.finished' && event.messageId === messageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for browser turn');
}

test('connected Chrome works for plain-language requests, follow-ups, and optional mentions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-browser-routing-'));
  const events = [];
  const calls = [];
  const browserControl = {
    async status() { return { connected: true }; },
    definitions() { return [browserTool('browser_observe')]; },
    has(name) { return name === 'browser_observe'; },
    async call(name, args) { calls.push({ name, args }); return { output: 'Current tab: Example' }; },
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    emit: (event) => events.push(event),
    browserControl,
    providerFactory: () => {
      let step = 0;
      return {
        async stream(messages, { tools, onDelta }) {
          assert.ok(tools.some((tool) => tool.function?.name === 'browser_observe'));
          if (step++ === 0) {
            const integration = messages.find((message) => message.role === 'system' && message.content.includes('CUPPET_INTEGRATION'));
            assert.match(integration?.content ?? '', /@browserControl mention is optional/);
            return { toolCalls: [{ id: 'observe', name: 'browser_observe', arguments: '{}' }] };
          }
          assert.match(messages.at(-1).content, /Current tab: Example/);
          await onDelta('The current tab is Example.');
          return { text: 'The current tab is Example.' };
        },
      };
    },
  });
  try {
    const session = await runtime.handle('session.create');
    const prompts = ['Use browserControl to inspect the current tab.', 'What is the title on that page?', '@browserControl inspect the current tab.'];
    for (const text of prompts) {
      const accepted = await runtime.handle('session.send', { sessionId: session.id, text, provider: {} });
      await waitForTurn(events, accepted.messageId);
      const stored = await runtime.handle('session.get', { sessionId: session.id });
      assert.equal(stored.messages.at(-1).status, 'complete');
      assert.equal(stored.messages.at(-1).content, 'The current tab is Example.');
    }
    assert.deepEqual(calls, prompts.map(() => ({ name: 'browser_observe', args: {} })));
    const stored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(stored.messages.filter((message) => message.role === 'user').map((message) => message.content), prompts);
    assert.equal(stored.messages.some((message) => message.role === 'system' && message.content.includes('CUPPET_INTEGRATION')), false);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('without connected Chrome, ordinary chat works and explicit mentions explain how to connect', async () => {
  for (const browserControl of [null, { async status() { return { connected: false }; }, definitions() { return []; } }]) {
    const dir = await mkdtemp(join(tmpdir(), 'cuppet-browser-disconnected-'));
    const events = [];
    const runtime = new RuntimeService({
      databasePath: join(dir, 'db.sqlite3'),
      emit: (event) => events.push(event),
      browserControl,
      providerFactory: () => ({
        async stream(messages, { tools, onDelta }) {
          assert.equal(tools.some((tool) => tool.function?.name?.startsWith('browser_')), false);
          assert.equal(messages.some((message) => message.content?.includes('CUPPET_INTEGRATION')), false);
          await onDelta('Ordinary chat still works.');
          return { text: 'Ordinary chat still works.' };
        },
      }),
    });
    try {
      const session = await runtime.handle('session.create');
      const accepted = await runtime.handle('session.send', { sessionId: session.id, text: 'Hello', provider: {} });
      await waitForTurn(events, accepted.messageId);
      const stored = await runtime.handle('session.get', { sessionId: session.id });
      assert.equal(stored.messages.at(-1).content, 'Ordinary chat still works.');
      await assert.rejects(
        runtime.handle('session.send', { sessionId: session.id, text: '@browserControl read this page', provider: {} }),
        browserControl ? /Connect Chrome in Settings > General > Integrations/ : /browserControl is not available/,
      );
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});


test('refreshed browser tools reach the next model call and later turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-browser-refresh-'));
  const events = [];
  let availableTools = [browserTool('browser_observe')];
  let step = 0;
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    emit: (event) => events.push(event),
    browserControl: {
      async status() { return { connected: true }; },
      definitions() { return availableTools; },
      has(name) { return availableTools.some((tool) => tool.function.name === name); },
      async call() {
        availableTools = [browserTool('browser_tabs')];
        return { output: 'Tools refreshed.' };
      },
    },
    providerFactory: () => ({
      async stream(messages, { tools, onDelta }) {
        if (!tools.length) return { text: 'Browser refresh' };
        const names = tools.map((tool) => tool.function.name);
        if (step++ === 0) {
          assert.ok(names.includes('browser_observe'));
          return { toolCalls: [{ id: 'observe', name: 'browser_observe', arguments: '{}' }] };
        }
        assert.ok(names.includes('browser_tabs'));
        assert.equal(names.includes('browser_observe'), false);
        await onDelta('Updated tools are available.');
        return { text: 'Updated tools are available.' };
      },
    }),
  });
  try {
    const session = await runtime.handle('session.create');
    for (const text of ['Inspect Chrome.', 'List the tabs.']) {
      const accepted = await runtime.handle('session.send', { sessionId: session.id, text, provider: {} });
      await waitForTurn(events, accepted.messageId);
      const stored = await runtime.handle('session.get', { sessionId: session.id });
      assert.equal(stored.messages.at(-1).content, 'Updated tools are available.', events.find((event) => event.type === 'runtime.error')?.providerError?.diagnostic);
      assert.equal(stored.messages.at(-1).status, 'complete');
    }
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('plain-language browser control still goes through the permission broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-browser-permission-'));
  const events = [];
  let browserCalls = 0;
  let step = 0;
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    emit: (event) => events.push(event),
    interactive: false,
    browserControl: {
      async status() { return { connected: true }; },
      definitions() { return [browserTool('browser_click')]; },
      has(name) { return name === 'browser_click'; },
      async call() { browserCalls += 1; return { output: 'Clicked' }; },
    },
    providerFactory: () => ({
      async stream(messages, { tools, onDelta }) {
        assert.ok(tools.some((tool) => tool.function?.name === 'browser_click'));
        if (step++ === 0) return { toolCalls: [{ id: 'click', name: 'browser_click', arguments: '{}' }] };
        assert.match(messages.at(-1).content, /Permission denied: .*non-interactive runtime/);
        await onDelta('Approval is required.');
        return { text: 'Approval is required.' };
      },
    }),
  });
  try {
    const session = await runtime.handle('session.create');
    const accepted = await runtime.handle('session.send', { sessionId: session.id, text: 'Click the button in Chrome.', provider: {} });
    await waitForTurn(events, accepted.messageId);
    assert.equal(browserCalls, 0);
    assert.ok(events.some((event) => event.type === 'tool.finished' && event.tool === 'browser_click' && event.rejected));
    const stored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(stored.messages.at(-1).content, 'Approval is required.');
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
