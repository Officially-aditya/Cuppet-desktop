import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(events, predicate, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('timed out waiting for runtime event'));
      }
    }, 5);
  });
}

test('runtime streams into durable assistant message and completes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-'));
  const events = [];
  const providerFactory = () => ({
    async stream(_messages, { onDelta }) {
      await onDelta('one ');
      await onDelta('two');
      return { text: 'one two' };
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), emit: (event) => events.push(event), providerFactory });
  try {
    const session = await runtime.handle('session.create');
    const accepted = await runtime.handle('session.send', { sessionId: session.id, text: 'hi', provider: {} });
    assert.equal(accepted.accepted, true);
    await waitFor(events, (event) => event.type === 'run.finished');
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.title, 'hi');
    assert.deepEqual(restored.messages.map((message) => [message.role, message.content, message.status]), [
      ['user', 'hi', 'complete'],
      ['assistant', 'one two', 'complete'],
    ]);
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stop aborts the active generation and persists partial output as stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-stop-'));
  const events = [];
  const providerFactory = () => ({
    async stream(_messages, { signal, onDelta }) {
      await onDelta('partial');
      while (!signal.aborted) await sleep(5);
      const error = new Error('stopped');
      error.name = 'AbortError';
      throw error;
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), emit: (event) => events.push(event), providerFactory });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'long task', provider: {} });
    await waitFor(events, (event) => event.type === 'message.delta');
    const stop = await runtime.handle('session.stop', { sessionId: session.id });
    assert.equal(stop.stopped, true);
    await waitFor(events, (event) => event.type === 'run.finished');
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1).content, 'partial');
    assert.equal(restored.messages.at(-1).status, 'stopped');
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
