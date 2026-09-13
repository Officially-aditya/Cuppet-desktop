import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectTerminalManager, resolveProjectTerminalRoot } from '../src/main/project-terminal-manager.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    writes: [],
    ended: false,
    write(value) { this.writes.push(value); },
    end() { this.ended = true; },
  };
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function sender(id = 1) {
  const owner = new EventEmitter();
  owner.id = id;
  owner.events = [];
  owner.send = (channel, payload) => owner.events.push([channel, payload]);
  owner.isDestroyed = () => false;
  return owner;
}

test('terminal root comes only from runtime canonicalPath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-terminal-root-'));
  try {
    const calls = [];
    const resolved = await resolveProjectTerminalRoot(async (method, params) => {
      calls.push([method, params]);
      return { id: 'project-1', canonicalPath: root, path: '/renderer/supplied/path' };
    }, 'project-1');
    assert.equal(resolved, root);
    assert.deepEqual(calls, [['project.get', { projectId: 'project-1' }]]);

    await assert.rejects(
      () => resolveProjectTerminalRoot(async () => ({ id: 'project-1', path: root }), 'project-1'),
      /canonical project root is invalid/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('switching project stops the previous renderer-owned shell and rebinds cwd', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'cuppet-terminal-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'cuppet-terminal-b-'));
  const spawned = [];
  const children = [];
  const manager = new ProjectTerminalManager({
    request: async (_method, { projectId }) => ({ id: projectId, canonicalPath: projectId === 'a' ? rootA : rootB }),
    spawnProcess: (shell, args, options) => {
      const child = fakeChild();
      spawned.push({ shell, args, options });
      children.push(child);
      return child;
    },
  });
  const owner = sender(7);
  try {
    const first = await manager.start(owner, 'a');
    assert.equal(first.cwd, rootA);
    assert.equal(spawned[0].options.cwd, rootA);

    const second = await manager.start(owner, 'b');
    assert.equal(second.cwd, rootB);
    assert.equal(spawned[1].options.cwd, rootB);
    assert.deepEqual(children[0].kills, ['SIGTERM']);
    assert.equal(children[0].stdin.ended, true);
    assert.throws(() => manager.write(owner, first.sessionId, 'pwd\n'), /not active/i);

    manager.write(owner, second.sessionId, 'cd src\npwd\n');
    assert.deepEqual(children[1].stdin.writes, ['cd src\npwd\n']);
  } finally {
    manager.stopAll();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test('terminal sessions are renderer-owned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-terminal-owner-'));
  const manager = new ProjectTerminalManager({
    request: async () => ({ canonicalPath: root }),
    spawnProcess: () => fakeChild(),
  });
  const owner = sender(11);
  const other = sender(12);
  try {
    const terminal = await manager.start(owner, 'project-1');
    assert.throws(() => manager.write(other, terminal.sessionId, 'pwd\n'), /another renderer/i);
    assert.throws(() => manager.stop(other, terminal.sessionId), /another renderer/i);
  } finally {
    manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('a superseded async start cannot spawn an old project shell', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'cuppet-terminal-race-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'cuppet-terminal-race-b-'));
  let releaseA;
  const waitA = new Promise((resolve) => { releaseA = resolve; });
  const spawned = [];
  const manager = new ProjectTerminalManager({
    request: async (_method, { projectId }) => {
      if (projectId === 'a') await waitA;
      return { canonicalPath: projectId === 'a' ? rootA : rootB };
    },
    spawnProcess: (_shell, _args, options) => {
      spawned.push(options.cwd);
      return fakeChild();
    },
  });
  const owner = sender(19);
  try {
    const staleStart = manager.start(owner, 'a');
    const current = await manager.start(owner, 'b');
    releaseA();
    await assert.rejects(staleStart, /superseded/i);
    assert.equal(current.cwd, rootB);
    assert.deepEqual(spawned, [rootB]);
  } finally {
    manager.stopAll();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});
