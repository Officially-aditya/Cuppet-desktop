import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCommandSerializer } from '../src/runtime/session-command-serializer.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('same-session commands execute strictly in submission order', async () => {
  const serializer = new SessionCommandSerializer();
  const firstGate = deferred();
  const started = [];

  const first = serializer.run('s1', async () => {
    started.push('first');
    await firstGate.promise;
    return 'one';
  });
  const second = serializer.run('s1', async () => {
    started.push('second');
    return 'two';
  });

  await Promise.resolve();
  assert.deepEqual(started, ['first']);
  assert.equal(serializer.activeLanes, 1);

  firstGate.resolve();
  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
  assert.deepEqual(started, ['first', 'second']);
  assert.equal(serializer.activeLanes, 0);
});

test('different sessions remain concurrent', async () => {
  const serializer = new SessionCommandSerializer();
  const gateA = deferred();
  const gateB = deferred();
  const started = [];

  const a = serializer.run('a', async () => {
    started.push('a');
    await gateA.promise;
  });
  const b = serializer.run('b', async () => {
    started.push('b');
    await gateB.promise;
  });

  await Promise.resolve();
  assert.deepEqual(new Set(started), new Set(['a', 'b']));
  assert.equal(serializer.activeLanes, 2);

  gateA.resolve();
  gateB.resolve();
  await Promise.all([a, b]);
  assert.equal(serializer.activeLanes, 0);
});

test('a rejected command releases the lane and does not poison the next command', async () => {
  const serializer = new SessionCommandSerializer();
  const failure = new Error('first failed');
  const order = [];

  const first = serializer.run('s1', async () => {
    order.push('first');
    throw failure;
  });
  const second = serializer.run('s1', async () => {
    order.push('second');
    return 'recovered';
  });

  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'recovered');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(serializer.activeLanes, 0);
});

test('invalid session ids fail closed without creating a lane', async () => {
  const serializer = new SessionCommandSerializer();
  assert.throws(() => serializer.run('', async () => undefined), /sessionId is required/);
  assert.throws(() => serializer.run('s1', null), /work function/);
  assert.equal(serializer.activeLanes, 0);
});
