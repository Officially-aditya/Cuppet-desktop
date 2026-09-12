import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexSubscriptionProvider } from '../src/runtime/codex-provider.mjs';
import { ProviderRuntimeManager, codexRuntimeFingerprint } from '../src/runtime/providers/runtime-manager.mjs';

function managedAcp(config = {}, backendId = 'opencode') {
  return {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId,
      descriptor: { id: backendId, label: backendId, transport: 'acp', command: backendId, args: [], envOverride: '', loginHint: '', mcpToolBridge: false },
      configuration: { providerID: backendId, ...config },
    }),
  };
}

function fakeAcpRuntime(log) {
  return {
    async start(options = {}) { log.push(['start', options.selection]); },
    async newSession(options = {}) { log.push(['newSession', options.selection]); },
    async runTurn() { log.push(['run']); return { text: 'acp', usage: null }; },
    async cancel() {},
    async close() { log.push(['close']); },
  };
}

function fakeCodexRuntime(log) {
  return {
    async start() { log.push(['start']); },
    async runTurn({ selection }, hooks = {}) {
      log.push(['run', selection]);
      await hooks.onDelta?.('codex');
      return { text: 'codex', usage: null };
    },
    async cancel() {},
    async close() { log.push(['close']); },
  };
}

test('runtime manager keeps ACP and Codex processes warm across provider and model switches', async () => {
  const acpLog = [];
  const codexLog = [];
  let acpConstructed = 0;
  let codexConstructed = 0;
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => { acpConstructed += 1; return fakeAcpRuntime(acpLog); },
    codexRuntimeFactory: () => { codexConstructed += 1; return fakeCodexRuntime(codexLog); },
  });
  const root = '/tmp/cuppet-cross-provider';
  try {
    await manager.adapterFor({
      sessionId: 'chat-cross-provider',
      projectRoot: root,
      adapter: managedAcp({ primary: { modelID: 'open-a', variant: 'high' } }),
    }).stream([{ role: 'user', content: 'one' }]);

    await manager.adapterFor({
      sessionId: 'chat-cross-provider',
      projectRoot: root,
      adapter: new CodexSubscriptionProvider({ providerID: 'codex', model: 'codex-a', primaryEffort: 'medium' }),
    }).stream([{ role: 'user', content: 'two' }]);

    await manager.adapterFor({
      sessionId: 'chat-cross-provider',
      projectRoot: root,
      adapter: new CodexSubscriptionProvider({ providerID: 'codex', model: 'codex-b', primaryEffort: 'high' }),
    }).stream([{ role: 'user', content: 'three' }]);

    await manager.adapterFor({
      sessionId: 'chat-cross-provider',
      projectRoot: root,
      adapter: managedAcp({ primary: { modelID: 'open-b', variant: 'max' } }),
    }).stream([{ role: 'user', content: 'four' }]);

    assert.equal(acpConstructed, 1);
    assert.equal(codexConstructed, 1);
    assert.equal(manager.size, 2);
    assert.deepEqual(acpLog.filter((item) => item[0] === 'start' || item[0] === 'newSession'), [
      ['start', { model: 'open-a', effort: 'high' }],
      ['newSession', { model: 'open-b', effort: 'max' }],
    ]);
    assert.deepEqual(codexLog.filter((item) => item[0] === 'run'), [
      ['run', { model: 'codex-a', effort: 'medium' }],
      ['run', { model: 'codex-b', effort: 'high' }],
    ]);
    const snapshot = manager.conversationSnapshot('chat-cross-provider');
    assert.equal(snapshot.warmRuntimeCount, 2);
    assert.equal(snapshot.totalCompletedTurns, 4);
  } finally {
    await manager.close();
  }
  assert.ok(acpLog.some((item) => item[0] === 'close'));
  assert.ok(codexLog.some((item) => item[0] === 'close'));
});

test('Codex runtime fingerprint ignores model selection but changes with process launch authority', () => {
  const one = codexRuntimeFingerprint({ configuration: { providerID: 'codex', model: 'a', primaryEffort: 'high', codexLaunch: { command: 'codex', args: ['app-server'] } }, projectRoot: '/tmp/a' });
  const selectionChanged = codexRuntimeFingerprint({ configuration: { providerID: 'codex', model: 'b', primaryEffort: 'low', codexLaunch: { command: 'codex', args: ['app-server'] } }, projectRoot: '/tmp/a' });
  const launchChanged = codexRuntimeFingerprint({ configuration: { providerID: 'codex', model: 'a', primaryEffort: 'high', codexLaunch: { command: 'other-codex', args: ['app-server'] } }, projectRoot: '/tmp/a' });
  assert.equal(one, selectionChanged);
  assert.notEqual(one, launchChanged);
});
