import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providerFactory() {
  return () => {
    let step = 0;
    return {
      async stream(messages, { signal, onDelta, tools }) {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        assert.equal(Array.isArray(tools), true);
        if (step++ === 0) {
          assert.equal(tools.some((entry) => entry.function?.name === 'workspace_write'), true);
          return {
            text: '',
            toolCalls: [{ id: 'call_write', name: 'workspace_write', arguments: '{"path":"src/generated.txt","content":"created by C1\\n"}' }],
          };
        }
        const tool = [...messages].reverse().find((message) => message.role === 'tool');
        assert.match(tool?.content ?? '', /Wrote \d+ bytes to src\/generated\.txt/);
        await onDelta('tool completed');
        return { text: 'tool completed', toolCalls: [] };
      },
    };
  };
}

function backgroundFactory() {
  return () => ({
    stats: { queued: 0, runs: 0 },
    async ready() {}, async close() {}, async recordTurn() {}, async flushNow() { return { status: 'empty', candidates: 0 }; },
    foregroundStarted() {}, foregroundIdle() {}, setProviderConfig() {}, pause() {}, resume() {},
  });
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) {
    const value = await predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(message);
}

test('runtime blocks a model tool on permission, resumes after approval, and keeps tool audit outside visible transcript', async () => {
  const previousPe3 = process.env.CUPPET_PE3;
  process.env.CUPPET_PE3 = '0';
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-c1-'));
  const projectRoot = join(dir, 'project');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  const events = [];
  const service = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: join(dir, 'runtime'),
    emit: (event) => events.push(event),
    providerFactory: providerFactory(),
    backgroundFactory: backgroundFactory(),
  });

  try {
    const project = await service.handle('project.add-local', { path: projectRoot, name: 'Project' });
    const session = await service.handle('session.create', { projectId: project.id });
    const accepted = await service.handle('session.send', { sessionId: session.id, text: 'Create src/generated.txt', provider: { model: 'test' } });
    assert.equal(accepted.sessionId, session.id);

    const permission = await waitFor(
      async () => events.find((event) => event.type === 'permission.requested')?.request,
      'permission request did not appear',
    );
    assert.equal(permission.action, 'write');
    assert.deepEqual(permission.resources, ['src/generated.txt']);
    assert.equal(permission.autoEligible, true);
    assert.equal((await service.handle('permission.list', { sessionId: session.id })).length, 1);

    assert.deepEqual(
      await service.handle('permission.reply', { requestId: permission.id, reply: 'once' }),
      { resolved: true, requestId: permission.id, reply: 'once' },
    );

    const completed = await waitFor(async () => {
      const current = await service.handle('session.get', { sessionId: session.id });
      const assistant = [...current.messages].reverse().find((message) => message.role === 'assistant');
      return assistant?.status === 'complete' ? current : null;
    }, 'generation did not finish after permission approval');

    assert.equal(await readFile(join(projectRoot, 'src', 'generated.txt'), 'utf8'), 'created by C1\n');
    assert.equal(completed.messages.find((message) => message.role === 'assistant')?.content, 'tool completed');
    assert.equal(completed.messages.some((message) => message.content.includes('Wrote 14 bytes')), false);
    assert.equal(completed.toolExecutions.length, 1);
    assert.equal(completed.toolExecutions[0].toolName, 'workspace_write');
    assert.equal(completed.toolExecutions[0].status, 'complete');
    assert.equal(completed.toolExecutions[0].permissionSource, 'user-once');
    assert.match(completed.toolExecutions[0].output, /Wrote \d+ bytes to src\/generated\.txt/);
    assert.equal(events.some((event) => event.type === 'permission.resolved' && event.requestId === permission.id && event.allowed === true), true);
    assert.equal(events.some((event) => event.type === 'tool.finished' && event.tool === 'workspace_write' && event.success === true), true);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
    if (previousPe3 === undefined) delete process.env.CUPPET_PE3; else process.env.CUPPET_PE3 = previousPe3;
  }
});