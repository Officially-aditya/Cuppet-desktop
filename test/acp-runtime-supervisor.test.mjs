import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { SupervisedAcpSessionRuntime, canRebuildBeforeTurn } from '../src/runtime/providers/transports/acp/supervised-acp-runtime.mjs';
import { providerFailureError, providerFailureMetadata } from '../src/runtime/providers/provider-failure.mjs';

function transportFailure(message = 'process exited', { retryable = true } = {}) {
  return providerFailureError(message, {
    code: 'PROVIDER_PROCESS_EXITED',
    category: 'process_exited',
    retryable,
    action: retryable ? 'retry' : null,
  });
}

test('dead warm ACP runtime is rebuilt before the next turn begins', async () => {
  const calls = [];
  let generation = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    sleep: async () => {},
    runtimeFactory: () => {
      generation += 1;
      const id = generation;
      return {
        async start(options) { calls.push(['start', id, options]); return { state: 'ready', sessionId: `s${id}` }; },
        async newSession(options) {
          calls.push(['newSession', id, options]);
          if (id === 1) throw transportFailure();
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
  assert.equal(snapshot.supervisor.preTurnRetries, 1);
});

test('safe pre-turn transport recovery uses bounded exponential backoff', async () => {
  const delays = [];
  let generation = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 15 },
    sleep: async (ms) => { delays.push(ms); },
    runtimeFactory: () => {
      generation += 1;
      const id = generation;
      return {
        async start() {
          if (id < 3) throw transportFailure(`generation ${id} failed`);
          return { state: 'ready', sessionId: `s${id}` };
        },
        async close() {},
        snapshot() { return { state: id < 3 ? 'error' : 'ready', sessionId: id < 3 ? null : `s${id}` }; },
      };
    },
  });

  const result = await runtime.start();
  assert.equal(result.sessionId, 's3');
  assert.equal(generation, 3);
  assert.deepEqual(delays, [10, 15]);
  const snapshot = runtime.snapshot().supervisor;
  assert.equal(snapshot.restarts, 2);
  assert.equal(snapshot.preTurnRetries, 2);
  assert.deepEqual(snapshot.retryPolicy, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 15 });
  assert.equal(snapshot.lastRetry.retry, 2);
  assert.equal(snapshot.lastRetry.delayMs, 15);
  assert.equal(snapshot.lastRetry.failure.category, 'process_exited');
});

test('safe pre-turn recovery stops after the configured attempt bound', async () => {
  const delays = [];
  let factories = 0;
  let starts = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    retryPolicy: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50 },
    sleep: async (ms) => { delays.push(ms); },
    runtimeFactory: () => {
      factories += 1;
      return {
        async start() { starts += 1; throw transportFailure('still unavailable'); },
        async close() {},
        snapshot() { return { state: 'error' }; },
      };
    },
  });

  await assert.rejects(() => runtime.start(), /still unavailable/);
  assert.equal(starts, 3);
  assert.equal(factories, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.equal(runtime.snapshot().supervisor.restarts, 2);
  assert.equal(runtime.snapshot().supervisor.preTurnRetries, 2);
});

test('non-retryable transport failure fails before any respawn or backoff', async () => {
  const delays = [];
  let factories = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    sleep: async (ms) => { delays.push(ms); },
    runtimeFactory: () => {
      factories += 1;
      return {
        async start() { throw transportFailure('do not retry', { retryable: false }); },
        async close() {},
        snapshot() { return { state: 'error' }; },
      };
    },
  });

  await assert.rejects(() => runtime.start(), /do not retry/);
  assert.equal(factories, 1);
  assert.deepEqual(delays, []);
  assert.equal(runtime.snapshot().supervisor.restarts, 0);
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
          throw transportFailure('transport died during side effects');
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
    sleep: async () => {},
    versionPreflight: async () => { preflights += 1; calls.push(['preflight', generation]); },
    runtimeFactory: () => {
      generation += 1;
      const id = generation;
      return {
        async start() { calls.push(['start', id]); return { state: 'ready', sessionId: `s${id}` }; },
        async newSession() {
          calls.push(['newSession', id]);
          if (id === 1) throw transportFailure();
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

test('real ACP startup preserves structured missing-executable failure metadata', async () => {
  const descriptor = {
    id: 'test-missing-acp',
    label: 'Missing ACP',
    command: `cuppet-provider-that-does-not-exist-${process.pid}`,
    args: [],
    envOverride: 'CUPPET_TEST_MISSING_ACP_COMMAND',
    loginHint: 'Install the test provider.',
  };
  const runtime = new AcpSessionRuntime({ descriptor });
  try {
    await assert.rejects(() => runtime.start(), (error) => {
      const metadata = providerFailureMetadata(error);
      assert.equal(metadata?.category, 'executable_missing');
      assert.equal(metadata?.retryable, false);
      assert.equal(error?.code, 'PROVIDER_EXECUTABLE_MISSING');
      return true;
    });
  } finally {
    await runtime.close();
  }
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
