import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providerFactory() {
  return () => ({
    async stream(messages, { signal, onDelta }) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      await onDelta(`done:${user.includes('billing') ? 'billing' : 'auth'}`);
      return { text: 'done' };
    },
  });
}

function backgroundFactory() {
  return () => ({
    stats: { queued: 0, runs: 0 },
    async ready() {},
    async close() {},
    foregroundStarted() {},
    setProviderConfig() {},
    async recordTurn() {},
    foregroundIdle() {},
    pause() {},
    resume() {},
  });
}

async function waitComplete(service, sessionId) {
  for (let i = 0; i < 50; i++) {
    const session = await service.handle('session.get', { sessionId });
    const last = [...session.messages].reverse().find((message) => message.role === 'assistant');
    if (last && last.status !== 'streaming') return session;
    await sleep(10);
  }
  throw new Error('generation did not complete');
}

async function waitFinished(events, sessionId) {
  for (let i = 0; i < 50; i++) {
    if (events.some((event) => event.type === 'run.finished' && event.sessionId === sessionId)) return;
    await sleep(10);
  }
  throw new Error('run did not finish');
}

test('runtime PE3 create handoff writes the new task only to its target SQLite session', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-runtime-pe3-'));
  const projectRoot = join(dir,'project');
  await import('node:fs/promises').then((fs) => fs.mkdir(projectRoot,{recursive:true}));
  const events = [];
  const service = new RuntimeService({
    databasePath:join(dir,'db.sqlite3'),
    dataDir:join(dir,'runtime'),
    emit:(event)=>events.push(event),
    providerFactory:providerFactory(),
    backgroundFactory:backgroundFactory(),
  });
  try {
    const project = await service.handle('project.add-local',{path:projectRoot,name:'Project'});
    const source = await service.handle('session.create',{projectId:project.id});
    const first = await service.handle('session.send',{sessionId:source.id,text:'Implement auth in src/auth.ts',provider:{model:'test'}});
    assert.equal(first.sessionId,source.id);
    await waitComplete(service,source.id);
    await waitFinished(events,source.id);

    const second = await service.handle('session.send',{sessionId:source.id,text:'New task: implement billing in src/billing.ts',provider:{model:'test'}});
    assert.equal(second.pe3.action,'create',second.pe3.reason);
    assert.notEqual(second.sessionId,source.id);
    const target = await waitComplete(service,second.sessionId);
    await waitFinished(events,second.sessionId);
    const sourceAfter = await service.handle('session.get',{sessionId:source.id});

    assert.equal(sourceAfter.messages.filter((message)=>message.role==='user').length,1);
    assert.equal(sourceAfter.messages.filter((message)=>message.role==='system'&&message.content.includes('[PE3 routing marker]')).length,1);
    assert.deepEqual(target.messages.filter((message)=>message.role==='user').map((message)=>message.content),['New task: implement billing in src/billing.ts']);
    assert.equal(target.messages.find((message)=>message.role==='assistant')?.content,'done:billing');
    assert.equal(events.some((event)=>event.type==='pe3.routed'&&event.targetSessionId===second.sessionId),true);
  } finally { await service.close(); await rm(dir,{recursive:true,force:true}); }
});
