import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeStatus } from '../src/runtime/diagnostics.mjs';

test('runtime status preserves durable active runs separately from live execution handles', async () => {
  const responses = new Map([
    ['health', { ok: true, runtime: 'independent', activeRuns: 3, liveExecutions: 1 }],
    ['project.list', []],
    ['session.list', []],
    ['permission.list', []],
    ['cognitive.status', { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false }, roles: {} }],
  ]);

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
