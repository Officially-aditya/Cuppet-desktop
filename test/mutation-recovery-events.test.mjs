import test from 'node:test';
import assert from 'node:assert/strict';
import { TstBatchEditManager } from '../src/runtime/tst-edit-batches.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('batch manager surfaces durable journal restart recovery as runtime events', async () => {
  const events = [];
  new TstBatchEditManager({
    tst: {},
    journal: {
      async ready() {
        return {
          recoveredBatches: 1,
          restoredFiles: 2,
          recovered: [{ sessionId: 's1', mutationId: 'mutation_a', restoredFiles: 2 }],
          conflicts: [{ sessionId: 's2', mutationId: 'mutation_b', path: 'src/x.ts', error: 'external edit preserved' }],
        };
      },
    },
    emit: (event) => events.push(event),
  });

  await tick();
  assert.deepEqual(events, [
    { type: 'mutation.recovered', sessionId: 's1', mutationId: 'mutation_a', restoredFiles: 2 },
    { type: 'mutation.recovery.conflict', sessionId: 's2', mutationId: 'mutation_b', path: 'src/x.ts', message: 'external edit preserved' },
  ]);
});

test('recovery reports without session or mutation identity are not broadcast', async () => {
  const events = [];
  new TstBatchEditManager({
    tst: {},
    journal: {
      async ready() {
        return {
          recovered: [{ sessionId: '', mutationId: 'mutation_a', restoredFiles: 1 }],
          conflicts: [{ sessionId: null, mutationId: null, path: null, error: 'invalid pending file' }],
        };
      },
    },
    emit: (event) => events.push(event),
  });
  await tick();
  assert.deepEqual(events, []);
});
