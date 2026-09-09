import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { ManagedTstManager, runtimeKey } from '../src/runtime/tst-supervisor.mjs';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';

class FakeSupervisor {
  constructor(options) { this.options = options; this.calls = []; this.closed = false; }
  get status() { return { running: this.calls.length > 0, connected: this.calls.length > 0, capabilities: ['memory.query', 'graph.locate'], starts: this.calls.length ? 1 : 0, lastError: null }; }
  async call(method, params) { this.calls.push({ method, params }); return { method, projectRoot: this.options.projectRoot, params }; }
  async supports() { return true; }
  async close() { this.closed = true; }
}

function fixture() {
  const supervisors = [];
  const manager = new ManagedTstManager({
    dataDir: '/tmp/cuppet-f1-test-state',
    binaryPath: '/fake/tst-daemon',
    existsImpl: () => true,
    realpathImpl: async (path) => resolve(path),
    supervisorFactory: (options) => { const supervisor = new FakeSupervisor(options); supervisors.push(supervisor); return supervisor; },
  });
  return { manager, supervisors };
}

test('managed TST isolates project supervisors and session routing', async () => {
  const { manager, supervisors } = fixture();
  await manager.bindSession('session-a', 'project-a', '/workspace/a');
  await manager.bindSession('session-b', 'project-b', '/workspace/b');

  const a = await manager.queryMemory('session-a', 'marker', 5);
  const b = await manager.queryMemory('session-b', 'marker', 5);
  assert.equal(a.projectRoot, resolve('/workspace/a'));
  assert.equal(b.projectRoot, resolve('/workspace/b'));
  assert.equal(supervisors.length, 2);
  assert.notEqual(supervisors[0].options.projectStore, supervisors[1].options.projectStore);
  assert.equal(supervisors[0].options.globalStore, supervisors[1].options.globalStore);

  const status = manager.status;
  assert.equal(status.mode, 'managed-native');
  assert.equal(status.protocol, 'cuppet.tst.v3');
  assert.equal(status.projects.length, 2);
  assert.equal(new Set(status.projects.map((project) => project.projectKey)).size, 2);

  await manager.unregisterProject('project-a');
  assert.equal(supervisors.find((item) => item.options.projectRoot === resolve('/workspace/a')).closed, true);
  assert.equal(supervisors.find((item) => item.options.projectRoot === resolve('/workspace/b')).closed, false);
  await manager.close();
});

test('runtime TST context binds PE3-created sessions and project-only graph calls to the inherited project', async () => {
  const { manager, supervisors } = fixture();
  const runtime = new RuntimeTstManager({ manager });
  await runtime.runWithProject({ sessionId: 'source', projectId: 'project-a', projectRoot: '/workspace/a' }, async () => {
    const routed = await runtime.queryMemory('routed-session', 'state', 4);
    assert.equal(routed.projectRoot, resolve('/workspace/a'));
    const graph = await runtime.graphLocate('Target', undefined, 12);
    assert.equal(graph.projectRoot, resolve('/workspace/a'));
  });
  assert.equal(supervisors.length, 1, 'one project context should share one daemon supervisor');

  await assert.rejects(() => runtime.graphLocate('OutsideContext'), /no active project context/);
  await runtime.close();
});

test('managed runtime key only advertises released desktop TST platforms', () => {
  assert.equal(runtimeKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(runtimeKey('darwin', 'x64'), 'darwin-x64');
  assert.equal(runtimeKey('linux', 'arm64'), 'linux-arm64-gnu');
  assert.equal(runtimeKey('linux', 'x64'), 'linux-x64-gnu');
  assert.equal(runtimeKey('win32', 'x64'), null);
});
