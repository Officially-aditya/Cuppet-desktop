import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

function waitFor(events, predicate, timeout = 2_000) {
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

test('switching projects cannot retarget a run already bound to another project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-project-binding-'));
  const projectAPath = join(dir, 'project-a');
  const projectBPath = join(dir, 'project-b');
  await mkdir(projectAPath);
  await mkdir(projectBPath);

  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const providerFactory = () => ({
    async stream(_messages, { onDelta }) {
      await onDelta('project A ');
      await gate;
      await onDelta('complete');
      return { text: 'project A complete' };
    },
  });

  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    emit: (event) => events.push(event),
    providerFactory,
  });

  try {
    const projectA = await runtime.handle('project.add-local', { path: projectAPath, name: 'A' });
    const projectB = await runtime.handle('project.add-local', { path: projectBPath, name: 'B' });
    const session = await runtime.handle('session.create', { projectId: projectA.id });

    await runtime.handle('session.send', { sessionId: session.id, text: 'work in A', provider: {} });
    const started = await waitFor(events, (event) => event.type === 'run.started' && event.sessionId === session.id);
    assert.equal(started.projectId, projectA.id);

    await runtime.handle('project.open', { projectId: projectB.id });
    release();

    const finished = await waitFor(events, (event) => event.type === 'run.finished' && event.sessionId === session.id);
    assert.equal(finished.projectId, projectA.id);

    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.projectId, projectA.id);
    assert.equal(restored.messages.at(-1).content, 'project A complete');
    assert.equal(restored.messages.at(-1).status, 'complete');
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
