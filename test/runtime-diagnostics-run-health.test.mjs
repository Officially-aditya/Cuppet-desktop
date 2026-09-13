import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeDoctor, buildRuntimeStatus } from '../src/runtime/diagnostics.mjs';
import {
  registerProviderRuntime,
  resetProviderRuntimeHealthForTests,
} from '../src/runtime/providers/runtime-health-registry.mjs';

function baseResponses() {
  return new Map([
    ['health', { ok: true, runtime: 'independent', activeRuns: 3, liveExecutions: 1 }],
    ['project.list', []],
    ['session.list', []],
    ['permission.list', []],
    ['cognitive.status', { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false }, roles: {} }],
  ]);
}

const providerConfig = {
  providerID: 'opencode',
  baseUrl: 'https://provider.example.test/v1',
  apiKey: 'super-secret-provider-key',
  models: [{
    providerID: 'opencode',
    modelID: 'coder',
    name: 'Coder',
    capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
  }],
  primary: { providerID: 'opencode', modelID: 'coder' },
};

test('runtime status preserves durable active runs separately from live execution handles', async () => {
  const responses = baseResponses();

  const status = await buildRuntimeStatus({
    call: async (method) => responses.get(method),
    providerConfig: {},
    version: 'test',
  });

  assert.equal(status.activeRuns, 3, 'semantic active run count must come from durable health projection');
  assert.equal(status.liveExecutions, 1, 'process-local execution handles must remain a separate diagnostic');
});

test('runtime status defaults missing run diagnostics independently', async () => {
  const responses = new Map([
    ['health', { ok: true, runtime: 'independent' }],
    ['project.list', []],
    ['session.list', []],
    ['permission.list', []],
    ['cognitive.status', {}],
  ]);

  const status = await buildRuntimeStatus({ call: async (method) => responses.get(method) });
  assert.equal(status.activeRuns, 0);
  assert.equal(status.liveExecutions, 0);
});

test('runtime status exposes sanitized provider supervisor retry diagnostics', async () => {
  resetProviderRuntimeHealthForTests();
  const unregister = registerProviderRuntime('opencode', () => ({
    state: 'ready',
    sessionId: 'provider-session-internal',
    supervisor: {
      generation: 3,
      restarts: 2,
      preTurnRetries: 2,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1000 },
      lastRetry: {
        retry: 2,
        delayMs: 300,
        at: 5_000,
        failure: { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, at: 4_900, diagnostic: 'secret-diagnostic' },
      },
      lastFailure: { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, at: 4_900, diagnostic: 'secret-diagnostic' },
      closed: false,
    },
  }));
  try {
    const responses = baseResponses();
    const status = await buildRuntimeStatus({
      call: async (method) => responses.get(method),
      providerConfig,
      version: 'test',
    });

    assert.equal(status.provider.runtime.state, 'ready');
    assert.equal(status.provider.runtime.generation, 3);
    assert.equal(status.provider.runtime.restarts, 2);
    assert.equal(status.provider.runtime.preTurnRetries, 2);
    assert.deepEqual(status.provider.runtime.retryPolicy, { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1000 });
    assert.equal(status.provider.runtime.lastRetry.retry, 2);
    assert.equal(status.provider.runtime.lastRetry.failure.category, 'process_exited');
    const rendered = JSON.stringify(status);
    assert.equal(rendered.includes('super-secret-provider-key'), false);
    assert.equal(rendered.includes('secret-diagnostic'), false);
    assert.equal(rendered.includes('provider-session-internal'), false);
  } finally {
    unregister();
    resetProviderRuntimeHealthForTests();
  }
});

test('runtime doctor warns on unhealthy provider supervisor without making runtime health fatal', async () => {
  resetProviderRuntimeHealthForTests();
  const unregister = registerProviderRuntime('opencode', () => ({
    state: 'error',
    supervisor: {
      generation: 2,
      restarts: 1,
      preTurnRetries: 1,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 150, maxDelayMs: 1000 },
      lastFailure: { code: 'PROVIDER_TRANSPORT_CLOSED', category: 'transport_closed', retryable: true, at: 6_000 },
      closed: false,
    },
  }));
  try {
    const responses = baseResponses();
    const doctor = await buildRuntimeDoctor({
      call: async (method) => responses.get(method),
      providerConfig,
      version: 'test',
    });

    assert.equal(doctor.ok, true, 'provider process health is advisory and must not redefine independent runtime health');
    const providerRuntimeCheck = doctor.checks.find((item) => item.id === 'provider-runtime');
    assert.equal(providerRuntimeCheck.status, 'warning');
    assert.match(providerRuntimeCheck.message, /1 restart\(s\).*1 safe pre-turn retry attempt\(s\)/);
    assert.ok(doctor.warnings.includes(providerRuntimeCheck.message));
  } finally {
    unregister();
    resetProviderRuntimeHealthForTests();
  }
});
