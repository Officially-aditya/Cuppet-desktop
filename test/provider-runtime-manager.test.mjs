import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRuntimeManager, openCodeRuntimeFingerprint } from '../src/runtime/providers/runtime-manager.mjs';

function fakeRuntime(log) {
  return {
    async start() { log.push('start'); },
    async newSession() { log.push('newSession'); },
    async runTurn({ messages }, hooks) {
      log.push(['run', messages.at(-1)?.content]);
      await hooks.onText?.('ok');
      return { text: 'ok', usage: null };
    },
    async cancel() { log.push('cancel'); },
    async close() { log.push('close'); },
  };
}
function managedAdapter(config) {
  return { cuppetManagedRuntime: () => ({ backendId: 'opencode', configuration: config }), stream: async () => ({ text: 'stateless' }) };
}

test('manager reuses one OpenCode process per Cuppet session but refreshes ACP logical session per turn', async () => {
  const log = [];
  let constructed = 0;
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    openCodeRuntimeFactory: () => { constructed += 1; return fakeRuntime(log); },
  });
  const adapter = managedAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-a' } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'one' }]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'two' }]);
  assert.equal(constructed, 1);
  assert.deepEqual(log.filter((item) => typeof item === 'string'), ['start', 'newSession']);
  assert.equal(manager.size, 1);
  await manager.close();
  assert.equal(log.at(-1), 'close');
});

test('manager replaces OpenCode runtime when model or project authority changes', async () => {
  const logs = [];
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {}, openCodeRuntimeFactory: () => { const log = []; logs.push(log); return fakeRuntime(log); } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'a' } }), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'b' } }), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].includes('close'));
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'b' } }), projectRoot: '/tmp/b' }).stream([]);
  assert.equal(logs.length, 3);
  assert.ok(logs[1].includes('close'));
  await manager.close();
});

test('manager passes ordinary providers through untouched', () => {
  const adapter = { stream: async () => ({ text: 'fallback' }) };
  const manager = new ProviderRuntimeManager({ openCodeRuntimeFactory: () => { throw new Error('unexpected'); } });
  assert.equal(manager.adapterFor({ sessionId: 'chat-1', adapter }), adapter);
  assert.equal(manager.size, 0);
});

test('manager evicts idle OpenCode processes', async () => {
  const log = [];
  const manager = new ProviderRuntimeManager({ idleMs: 15, usageRecorder: async () => {}, openCodeRuntimeFactory: () => fakeRuntime(log) });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode' }) }).stream([]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(manager.size, 0);
  assert.ok(log.includes('close'));
});

test('OpenCode runtime fingerprint is stable and sensitive to execution authority', () => {
  const one = openCodeRuntimeFingerprint({ providerID: 'opencode', primary: { modelID: 'a' }, primaryEffort: 'high' }, '/tmp/project');
  const same = openCodeRuntimeFingerprint({ primaryEffort: 'high', primary: { modelID: 'a' }, providerID: 'opencode' }, '/tmp/project');
  const modelChanged = openCodeRuntimeFingerprint({ providerID: 'opencode', primary: { modelID: 'b' }, primaryEffort: 'high' }, '/tmp/project');
  assert.equal(one, same);
  assert.notEqual(one, modelChanged);
});
