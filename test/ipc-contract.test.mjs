import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IPC_METHODS, IPC_EVENTS, validateIpcArguments } from '../src/shared/ipc-contract.mjs';
import { createIpcRegistrar } from '../src/main/ipc-boundary.mjs';

const sample = {
  id: 'id', nullableId: null, text: 'text', path: 'src/app.js', boolean: true,
  mode: 'build', autoMode: 'full', permissionReply: 'once', role: 'trusted', appearance: 'system',
  object: {}, dimension: 80, paths: ['src/app.js'], answers: [['answer']],
  attachments: [{ name: 'file.txt', path: 'file.txt' }], command: { id: 'status' },
};
const at = (object, path) => path.split('.').reduce((item, key) => item[key], object);

test('generated sandbox preload exposes every contract method and subscription with working cleanup', async () => {
  let api;
  const invocations = [];
  const subscriptions = new Map();
  vm.runInNewContext(readFileSync(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'cuppet'); api = value; } },
      ipcRenderer: {
        invoke(channel, ...args) { invocations.push({ channel, args }); return Promise.resolve('result'); },
        on(channel, fn) { subscriptions.set(channel, fn); },
        removeListener(channel, fn) { assert.equal(subscriptions.get(channel), fn); subscriptions.delete(channel); },
      },
    }),
    process: { platform: 'test-platform' },
  });
  assert.equal(api.native.platform, 'test-platform');
  for (const [name, spec] of Object.entries(IPC_METHODS)) {
    const args = spec.args.map(([, kind]) => sample[kind]);
    assert.equal(await at(api, name)(...args), 'result');
    assert.deepEqual(invocations.at(-1), { channel: spec.channel, args });
    assert.doesNotThrow(() => validateIpcArguments(name, args));
    assert.throws(() => validateIpcArguments(name, [...args, 'extra']), /Invalid arguments/);
  }
  for (const [name, spec] of Object.entries(IPC_EVENTS)) {
    let received;
    const unsubscribe = at(api, name)((value) => { received = value; });
    subscriptions.get(spec.channel)({}, 'payload');
    assert.equal(received, 'payload');
    unsubscribe();
    assert.equal(subscriptions.has(spec.channel), false);
  }
});

test('main IPC boundary rejects foreign windows, subframes, navigation and malformed arguments before dispatch', () => {
  const handlers = new Map();
  const frame = { url: 'file:///app/index.html#session' };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  let window = { webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const handle = createIpcRegistrar({ ipcMain: { handle(channel, fn) { handlers.set(channel, fn); } }, getWindow: () => window, rendererUrl: 'file:///app/index.html' });
  let calls = 0;
  handle('sessions.send', (_event, sessionId, text) => { calls++; return { sessionId, text }; });
  const send = handlers.get(IPC_METHODS['sessions.send'].channel);
  assert.deepEqual(send(event, 's', 'hello'), { sessionId: 's', text: 'hello' });
  for (const badEvent of [{ ...event, sender: {} }, { ...event, senderFrame: { ...frame } }, { ...event, senderFrame: null }]) {
    assert.throws(() => send(badEvent, 's', 'hello'), /Untrusted IPC sender/);
  }
  frame.url = 'https://example.com';
  assert.throws(() => send(event, 's', 'hello'), /Untrusted IPC document/);
  frame.url = 'file:///app/other.html';
  assert.throws(() => send(event, 's', 'hello'), /Untrusted IPC document/);
  frame.url = 'file:///app/index.html';
  assert.throws(() => send(event, {}, 'hello'), /Invalid sessionId/);
  assert.throws(() => send(event, 's', 3), /Invalid text/);
  assert.throws(() => send(event, 's', 'hello', [{ name: 3 }]), /Invalid attachments/);
  window = null;
  assert.throws(() => send(event, 's', 'hello'), /Untrusted IPC sender/);
  assert.equal(calls, 1);
});

test('every main handler has one contract entry and uses the guarded registrar', () => {
  const main = readFileSync(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../src/main/codex-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main + auth, /ipcMain\.handle\(/);
  const names = [...(main + auth).matchAll(/handle\('([^']+)'/g)].map((match) => match[1]);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), Object.keys(IPC_METHODS).sort());
});
