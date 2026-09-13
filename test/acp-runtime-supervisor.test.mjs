import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedAcpSessionRuntime, canRebuildBeforeTurn } from '../src/runtime/providers/transports/acp/supervised-acp-runtime.mjs';
import { providerFailureError } from '../src/runtime/providers/provider-failure.mjs';

test('dead warm ACP runtime is rebuilt before the next turn begins', async () => {
  const calls = [];
  let generation = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    runtimeFactory: () => {
      generation += 1;
      const id = generation;
      return {
        async start(options) { calls.push(['start', id, options]); return { state: 'ready', sessionId: `s${id}` }; },
        async newSession(options) {
          calls.push(['newSession', id, options]);
          if (id === 1) throw providerFailureError('process exited', { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, action: 'retry' });
          return { state: 'ready', sessionId: `s${id}` };
        },
        async runTurn() { calls.push(['runTurn', id]); return { text: 'ok' }; },
        async close() { calls.push(['close', id]); },
        snapshot() { return { state: 'ready', sessionId: `s${id}` }; },
      };
    },
  });

  await runtime.start({ selection: { model: 'm1' } });
  const reopened = await runtime.newSession({ selection: { model: 'm1' } });
  assert.equal(reopened.sessionId, 's2');
  assert.deepEqual(calls.map((entry) => entry[0]), ['start', 'newSession', 'close', 'start']);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.supervisor.generation, 2);
  assert.equal(snapshot.supervisor.restarts, 1);
});

test('runTurn is never replayed automatically after a transport failure', async () => {
  let factories = 0;
  let turnCalls = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    runtimeFactory: () => {
      factories += 1;
      return {
        async start() { return { state: 'ready' }; },
        async runTurn() {
          turnCalls += 1;
          throw providerFailureError('transport died during side effects', { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, action: 'retry' });
        },
        async close() {},
        snapshot() { return { state: 'ready' }; },
      };
    },
  });
  await runtime.start();
  await assert.rejects(() => runtime.runTurn({ messages: [] }), /transport died during side effects/);
  assert.equal(turnCalls, 1);
  assert.equal(factories, 1);
  assert.equal(runtime.snapshot().supervisor.restarts, 0);
});

test('managed version preflight runs once per healthy provider process generation', async () => {
  let preflights = 0;
  let starts = 0;
  let sessions = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    versionPreflight: async () => { preflights += 1; },
    runtimeFactory: () => ({
      async start() { starts += 1; return { state: 'ready', sessionId: 's1' }; },
      async newSession() { sessions += 1; return { state: 'ready', sessionId: `s${sessions + 1}` }; },
      async close() {},
      snapshot() { return { state: 'ready', sessionId: 's1' }; },
    }),
  });

  await runtime.start();
  await runtime.newSession();
  await runtime.newSession();
  assert.equal(preflights, 1);
  assert.equal(starts, 1);
  assert.equal(sessions, 2);
});

test('managed version preflight runs again before a replacement provider process starts', async () => {
  let generation = 0;
  let preflights = 0;
  const calls = [];
  const runtime = new SupervisedAcpSessionRuntime({}, {
    versionPreflight: async () => { preflights += 1; calls.push(['preflight', generation]); },
    runtimeFactory: () => {
      generation += 1;
      const id = generation;
      return {
        async start() { calls.push(['start', id]); return { state: 'ready', sessionId: `s${id}` }; },
        async newSession() {
          calls.push(['newSession', id]);
          if (id === 1) throw providerFailureError('process exited', { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, action: 'retry' });
          return { state: 'ready', sessionId: `s${id}` };
        },
        async close() { calls.push(['close', id]); },
        snapshot() { return { state: 'ready', sessionId: `s${id}` }; },
      };
    },
  });

  await runtime.start();
  await runtime.newSession();
  assert.equal(preflights, 2);
  assert.deepEqual(calls.map((entry) => entry[0]), ['preflight', 'start', 'newSession', 'close', 'preflight', 'start']);
});

test('unsupported provider version fails before the ACP runtime can start', async () => {
  let starts = 0;
  const unsupported = new Error('OpenCode 1.18.29 is unsupported');
  unsupported.code = 'PROVIDER_VERSION_UNSUPPORTED';
  const runtime = new SupervisedAcpSessionRuntime({}, {
    versionPreflight: async () => { throw unsupported; },
    runtimeFactory: () => ({
      async start() { starts += 1; return { state: 'ready' }; },
      async close() {},
      snapshot() { return { state: 'idle' }; },
    }),
  });

  await assert.rejects(() => runtime.start(), (error) => error === unsupported);
  assert.equal(starts, 0);
  assert.equal(runtime.snapshot().supervisor.restarts, 0);
});

test('missing executable requires control-plane repair instead of respawn loop', () => {
  const error = providerFailureError('missing', {
    code: 'PROVIDER_EXECUTABLE_MISSING',
    category: 'executable_missing',
    retryable: false,
    action: 'reconnect_provider',
  });
  assert.equal(canRebuildBeforeTurn(error), false);
});
