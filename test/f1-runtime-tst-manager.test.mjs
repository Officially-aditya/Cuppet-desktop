import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeTstManager } from '../src/runtime/runtime-tst-manager.mjs';

class FakeManager {
  configured = true;
  status = { configured: true, mode: 'managed-native' };
  binds = [];
  projectCalls = [];
  closes = 0;

  async bindSession(sessionId, projectId, projectRoot) {
    this.binds.push({ sessionId, projectId, projectRoot });
    return this.handle(projectId, projectRoot);
  }
  async forProject(projectId, projectRoot) {
    this.projectCalls.push({ projectId, projectRoot });
    return this.handle(projectId, projectRoot);
  }
  forProjectRoot(projectRoot) { return this.handle('root-only', projectRoot); }
  unregisterProject(projectId) { return { projectId, closed: true }; }
  async close() { this.closes++; await new Promise((resolve) => setTimeout(resolve, 10)); }
  async queryMemory(sessionId, query) { return { sessionId, query }; }
  handle(projectId, projectRoot) {
    return {
      graphLocate: async (pattern) => ({ projectId, projectRoot, pattern }),
      call: async (method, params) => ({ projectId, projectRoot, method, params }),
      supports: async () => true,
    };
  }
}

test('ordinary project-scoped runtime work does not eagerly bind managed TST', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({ manager });
  const result = await tst.runWithProject(
    { sessionId: 'source-session', projectId: 'project-a', projectRoot: '/workspace/a' },
    async () => 'ok',
  );
  assert.equal(result, 'ok');
  assert.deepEqual(manager.binds, []);
  assert.deepEqual(manager.projectCalls, []);
});

test('project graph operations bind lazily inside the active project context', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({ manager });
  const result = await tst.runWithProject({ projectId: 'project-a', projectRoot: '/workspace/a' }, () => tst.graphLocate('alphaOne'));
  assert.deepEqual(result, { projectId: 'project-a', projectRoot: '/workspace/a', pattern: 'alphaOne' });
  assert.deepEqual(manager.projectCalls, [
    { projectId: 'project-a', projectRoot: '/workspace/a' },
  ]);
});

test('a PE3-created session inherits the current project on its first TST call', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({ manager });
  const result = await tst.runWithProject({ sessionId: 'source-session', projectId: 'project-a', projectRoot: '/workspace/a' }, () => tst.queryMemory('target-session', 'marker'));
  assert.deepEqual(result, { sessionId: 'target-session', query: 'marker' });
  assert.deepEqual(manager.binds, [
    { sessionId: 'target-session', projectId: 'project-a', projectRoot: '/workspace/a' },
  ]);
});

test('project-scoped graph calls fail without an explicit runtime project context', async () => {
  const tst = new RuntimeTstManager({ manager: new FakeManager() });
  await assert.rejects(() => tst.graphLocate('alphaOne'), /no active project context/);
});

test('managed shutdown is deduplicated so runtime close can await the same daemon shutdown', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({ manager });
  const first = tst.close();
  const second = tst.close();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(manager.closes, 1);
});

test('project resolution fallback binds session and project handle when context has sessionId only', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({
    manager,
    resolveProjectForSession: (sessionId) => {
      if (sessionId === 'session-lazy') return { projectId: 'project-lazy', projectRoot: '/workspace/lazy' };
      return null;
    },
  });
  const result = await tst.runWithProject({ sessionId: 'session-lazy' }, () => tst.graphLocate('searchTarget'));
  assert.deepEqual(result, { projectId: 'project-lazy', projectRoot: '/workspace/lazy', pattern: 'searchTarget' });
  assert.deepEqual(manager.binds, [
    { sessionId: 'session-lazy', projectId: 'project-lazy', projectRoot: '/workspace/lazy' },
  ]);
});

test('session-scoped TST calls resolve project from session when store has no project context', async () => {
  const manager = new FakeManager();
  const tst = new RuntimeTstManager({
    manager,
    resolveProjectForSession: (sessionId) => {
      if (sessionId === 'session-detached') return { projectId: 'project-detached', projectRoot: '/workspace/detached' };
      return null;
    },
  });
  const result = await tst.queryMemory('session-detached', 'marker');
  assert.deepEqual(result, { sessionId: 'session-detached', query: 'marker' });
  assert.deepEqual(manager.binds, [
    { sessionId: 'session-detached', projectId: 'project-detached', projectRoot: '/workspace/detached' },
  ]);
});

