import assert from 'node:assert/strict';
import test from 'node:test';
import { executionCapabilities, emptyExecutionCapabilities, isExecutionCapabilities } from '../src/runtime/execution/execution-capabilities.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { normalizeProviderCapabilities } from '../src/runtime/providers/capabilities.mjs';

test('execution capabilities describe Cuppet authority independently of provider capabilities', () => {
  const execution = executionCapabilities({
    projectBound: true,
    tstConfigured: true,
    batchEditAvailable: true,
    planAvailable: true,
    browserAvailable: true,
  });
  assert.deepEqual(execution, {
    inspect: true,
    search: true,
    batchRead: true,
    batchEdit: true,
    validate: true,
    shell: true,
    memory: true,
    plan: true,
    browser: true,
  });
  assert.equal(Object.isFrozen(execution), true);
  assert.equal(isExecutionCapabilities(execution), true);

  const provider = normalizeProviderCapabilities({ models: [{ id: 'model-a' }] });
  for (const key of Object.keys(execution)) assert.equal(Object.prototype.hasOwnProperty.call(provider, key), false);
});

test('execution capabilities fail closed when Cuppet runtime authority is unavailable', () => {
  assert.deepEqual(emptyExecutionCapabilities(), {
    inspect: false,
    search: false,
    batchRead: false,
    batchEdit: false,
    validate: false,
    shell: false,
    memory: false,
    plan: false,
    browser: false,
  });

  const unbound = executionCapabilities({ tstConfigured: true, batchEditAvailable: true, planAvailable: true });
  assert.equal(unbound.inspect, false);
  assert.equal(unbound.search, false);
  assert.equal(unbound.batchRead, false);
  assert.equal(unbound.batchEdit, false);
  assert.equal(unbound.validate, false);
  assert.equal(unbound.shell, false);
  assert.equal(unbound.memory, true);
  assert.equal(unbound.plan, true);
});

test('JournaledToolRuntime reports live Cuppet execution state instead of advertised tool names', () => {
  const runtime = new JournaledToolRuntime({
    journal: null,
    db: null,
    tst: { configured: false },
    batchEdits: {},
    planStore: { toolResult: async () => '' },
    externalTools: { definitions: () => [{ type: 'function', function: { name: 'browser_status' } }] },
  });

  // Tool definitions exist even though TST graph/memory authority is not live.
  const names = runtime.definitions({ projectRoot: '/tmp/project', integrations: ['browserControl'] }).map((item) => item.function?.name);
  assert.ok(names.includes('tst_explore'));
  assert.ok(names.includes('cuppet_memory_search'));

  const withoutBrowser = runtime.executionCapabilities({ projectRoot: '/tmp/project' });
  assert.deepEqual(withoutBrowser, {
    inspect: false,
    search: false,
    batchRead: true,
    batchEdit: true,
    validate: true,
    shell: true,
    memory: false,
    plan: true,
    browser: false,
  });

  const withBrowser = runtime.executionCapabilities({ projectRoot: '/tmp/project', integrations: ['browserControl'] });
  assert.equal(withBrowser.browser, true);
});

test('JournaledToolRuntime enables graph and memory capability only when TST is configured', () => {
  const runtime = new JournaledToolRuntime({
    journal: null,
    db: null,
    tst: { configured: true },
    batchEdits: null,
    planStore: null,
    externalTools: null,
  });
  const capabilities = runtime.executionCapabilities({ projectRoot: '/tmp/project' });
  assert.equal(capabilities.inspect, true);
  assert.equal(capabilities.search, true);
  assert.equal(capabilities.memory, true);
  assert.equal(capabilities.batchRead, true);
  assert.equal(capabilities.batchEdit, false);
  assert.equal(capabilities.plan, false);
  assert.equal(capabilities.browser, false);
});
