import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFailureError } from '../src/runtime/providers/provider-failure.mjs';
import { withControlState } from '../src/runtime/providers/control-plane.mjs';
import {
  providerRuntimeHealth,
  recordProviderRuntimeFailure,
  resetProviderRuntimeHealthForTests,
} from '../src/runtime/providers/runtime-health-registry.mjs';
import { SupervisedAcpSessionRuntime } from '../src/runtime/providers/transports/acp/supervised-acp-runtime.mjs';

test('provider control distinguishes lazy stopped runtime from a recent crash', () => {
  resetProviderRuntimeHealthForTests();
  const connected = {
    providerID: 'opencode',
    installed: true,
    connected: true,
    installation: { detected: true, executable: '/tmp/opencode' },
  };

  const idle = withControlState(connected, providerRuntimeHealth('opencode', 1_000));
  assert.equal(idle.control.overall, 'ready');
  assert.equal(idle.control.runtime.state, 'stopped');

  recordProviderRuntimeFailure('opencode', {
    code: 'ACP_TRANSPORT_CLOSED',
    category: 'transport_closed',
    retryable: true,
    at: 2_000,
  }, 2_000);
  const crashed = withControlState(connected, providerRuntimeHealth('opencode', 2_000));
  assert.equal(crashed.control.overall, 'needs_retry');
  assert.equal(crashed.control.runtime.state, 'crashed');
  assert.equal(crashed.control.runtime.lastFailure.category, 'transport_closed');
  assert.equal(crashed.control.runtime.lastFailure.retryable, true);

  resetProviderRuntimeHealthForTests();
});

test('supervised ACP runtime publishes starting, ready, busy, and stopped process health', async () => {
  resetProviderRuntimeHealthForTests();
  let state = 'idle';
  let releaseTurn;
  const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
  const fake = {
    snapshot: () => ({ state }),
    async start() { state = 'ready'; return this.snapshot(); },
    async newSession() { state = 'ready'; return this.snapshot(); },
    async runTurn() {
      state = 'running';
      await turnGate;
      state = 'ready';
      return { text: 'ok' };
    },
    async cancel() {},
    async close() { state = 'closed'; },
    setHostHandlers() {},
    async capabilities() { return {}; },
  };
  const runtime = new SupervisedAcpSessionRuntime(
    { descriptor: { id: 'opencode' } },
    { runtimeFactory: () => fake },
  );

  assert.equal(providerRuntimeHealth('opencode').state, 'starting');
  await runtime.start();
  assert.equal(providerRuntimeHealth('opencode').state, 'ready');

  const running = runtime.runTurn();
  await new Promise((resolve) => setImmediate(resolve));
  const busy = providerRuntimeHealth('opencode');
  assert.equal(busy.state, 'busy');
  assert.equal(busy.busyProcesses, 1);

  releaseTurn();
  await running;
  assert.equal(providerRuntimeHealth('opencode').state, 'ready');
  await runtime.close();
  assert.equal(providerRuntimeHealth('opencode').state, 'stopped');
  resetProviderRuntimeHealthForTests();
});

test('provider health and control state expose sanitized bounded pre-turn retry diagnostics', async () => {
  resetProviderRuntimeHealthForTests();
  let generation = 0;
  const runtime = new SupervisedAcpSessionRuntime(
    { descriptor: { id: 'opencode' } },
    {
      retryPolicy: { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 50 },
      sleep: async () => {},
      runtimeFactory: () => {
        generation += 1;
        const id = generation;
        return {
          async start() {
            if (id === 1) throw providerFailureError('pipe closed', {
              code: 'PROVIDER_TRANSPORT_CLOSED',
              category: 'transport_closed',
              retryable: true,
              action: 'retry',
              diagnostic: 'Bearer should-not-leak',
            });
            return { state: 'ready', sessionId: `s${id}` };
          },
          async close() {},
          snapshot() { return { state: id === 1 ? 'error' : 'ready', sessionId: id === 1 ? null : `s${id}` }; },
        };
      },
    },
  );

  await runtime.start();
  const health = providerRuntimeHealth('opencode');
  assert.equal(health.state, 'ready');
  assert.equal(health.generation, 2);
  assert.equal(health.restarts, 1);
  assert.equal(health.preTurnRetries, 1);
  assert.deepEqual(health.retryPolicy, { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 50 });
  assert.equal(health.lastRetry.retry, 1);
  assert.equal(health.lastRetry.delayMs, 25);
  assert.equal(health.lastRetry.failure.category, 'transport_closed');
  assert.equal(JSON.stringify(health).includes('should-not-leak'), false);

  const connected = {
    providerID: 'opencode',
    installed: true,
    connected: true,
    installation: { detected: true, executable: '/tmp/opencode' },
  };
  const projected = withControlState(connected, health);
  assert.equal(projected.control.runtime.preTurnRetries, 1);
  assert.deepEqual(projected.control.runtime.retryPolicy, { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 50 });
  assert.equal(projected.control.runtime.lastRetry.failure.category, 'transport_closed');

  await runtime.close();
  resetProviderRuntimeHealthForTests();
});

test('transport failure remains visible after failed runtime is evicted', async () => {
  resetProviderRuntimeHealthForTests();
  let state = 'idle';
  const fake = {
    snapshot: () => ({ state }),
    async start() { state = 'ready'; return this.snapshot(); },
    async newSession() { state = 'ready'; return this.snapshot(); },
    async runTurn() {
      state = 'error';
      throw providerFailureError('provider pipe closed', {
        code: 'ACP_TRANSPORT_CLOSED',
        category: 'transport_closed',
        retryable: true,
        action: 'retry',
        providerID: 'opencode',
      });
    },
    async cancel() {},
    async close() { state = 'closed'; },
    setHostHandlers() {},
    async capabilities() { return {}; },
  };
  const runtime = new SupervisedAcpSessionRuntime(
    { descriptor: { id: 'opencode' } },
    { runtimeFactory: () => fake },
  );
  await runtime.start();
  await assert.rejects(() => runtime.runTurn(), /provider pipe closed/);
  assert.equal(providerRuntimeHealth('opencode').state, 'unhealthy');
  await runtime.close();
  const health = providerRuntimeHealth('opencode');
  assert.equal(health.state, 'crashed');
  assert.equal(health.activeProcesses, 0);
  assert.equal(health.lastFailure.category, 'transport_closed');
  resetProviderRuntimeHealthForTests();
});
