import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveEnrichment } from '../src/runtime/active-enrichment.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('active enrichment starts with primary work, doubles intervals and delivers context once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const events = [];
  let calls = 0;
  const worker = new ActiveEnrichment({ emit: (event) => events.push(event), enrich: async () => ({ status: 'completed', context: `memory-${++calls}` }) });
  t.mock.timers.tick(600_000);
  assert.equal(calls, 0);
  worker.start(); worker.start();
  for (const interval of [60_000, 120_000, 240_000, 480_000]) {
    const before = calls;
    t.mock.timers.tick(interval - 1); await flush();
    assert.equal(calls, before);
    t.mock.timers.tick(1); await flush();
    assert.equal(calls, before + 1);
    assert.equal(worker.takeContext(), `memory-${calls}`);
    assert.equal(worker.takeContext(), '');
  }
  assert.deepEqual(events.filter((event) => event.type === 'background.dynamic.running').map((event) => event.intervalMs), [60_000, 120_000, 240_000, 480_000]);
  worker.close();
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(calls, 4);
});

test('active enrichment never overlaps and discards late context after the task ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let finish;
  let calls = 0;
  let cancelled = 0;
  const worker = new ActiveEnrichment({ cancel: () => cancelled++, enrich: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  worker.start();
  t.mock.timers.tick(60_000); await flush();
  t.mock.timers.tick(600_000); await flush();
  assert.equal(calls, 1);
  worker.close();
  finish({ status: 'completed', context: 'too late' }); await flush();
  assert.equal(worker.takeContext(), '');
  assert.equal(cancelled, 1);
  t.mock.timers.tick(600_000); await flush();
  assert.equal(calls, 1);
});
