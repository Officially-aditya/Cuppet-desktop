import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { Pe3ProjectRouter, normalizeAttachments } from '../src/runtime/pe3/router.mjs';

class NeverSemantic {
  modelID = 'never';
  async decide() { return { action:'continue', reason:'test fallback', fallback:true, activeSimilarity:0, promptEmbeddingCount:0, agentEmbeddingCount:0, embeddingLatencyMs:0, modelID:'never' }; }
}

test('PE3 transactional create rolls back target writes and preserves the source request on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-tx-'));
  const db = new ConversationDatabase(join(dir,'db.sqlite3'));
  try {
    db.createProject({ id:'project-1', name:'P', canonicalPath:dir });
    db.createSession({ id:'session-a', projectId:'project-1' });
    const router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:join(dir,'pe3'), db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();

    const first = await router.prepare({ sourceSessionId:'session-a', prompt:'Implement auth in src/auth.ts' });
    router.accept(first.token);
    await router.commit(first.token, () => db.transaction(() => db.appendMessage({ id:'m1', sessionId:'session-a', role:'user', content:'Implement auth in src/auth.ts' })));

    const prepared = await router.prepare({ sourceSessionId:'session-a', prompt:'New task: implement billing in src/billing.ts' });
    assert.equal(prepared.action,'create');
    router.accept(prepared.token);
    const target = prepared.targetSessionId;
    await assert.rejects(() => router.commit(prepared.token, () => db.transaction(() => {
      db.createSession({ id:target, projectId:'project-1' });
      db.appendMessage({ id:'marker-failed', sessionId:'session-a', role:'system', content:'should rollback' });
      throw new Error('forced database failure');
    })), /forced database failure/);
    assert.equal(db.getSessionSummary(target),null);
    assert.deepEqual(db.getSession('session-a').messages.map((message)=>message.id),['m1']);

    const retry = await router.prepare({ sourceSessionId:'session-a', prompt:'New task: implement billing in src/billing.ts' });
    router.accept(retry.token);
    const committed = await router.commit(retry.token, (tx) => db.transaction(() => {
      db.createSession({ id:tx.targetSessionId, projectId:'project-1', title:'Billing' });
      db.appendMessage({ id:'marker-ok', sessionId:'session-a', role:'system', content:`routed to ${tx.targetSessionId}` });
      db.appendMessage({ id:'billing-user', sessionId:tx.targetSessionId, role:'user', content:'New task: implement billing in src/billing.ts' });
      return tx.targetSessionId;
    }));
    assert.equal(committed.route.action,'create');
    const sourceMessages = db.getSession('session-a').messages;
    assert.equal(sourceMessages.filter((message)=>message.role==='user').length,1);
    assert.equal(sourceMessages.filter((message)=>message.role==='system').length,1);
    const targetMessages = db.getSession(committed.route.targetSessionId).messages;
    assert.deepEqual(targetMessages.map((message)=>message.content),['New task: implement billing in src/billing.ts']);
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('PE3 accept reserves a target until the accepted handoff commits or aborts', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-reservation-'));
  const db = new ConversationDatabase(join(dir,'db.sqlite3'));
  try {
    db.createProject({ id:'project-1', name:'P', canonicalPath:dir });
    db.createSession({ id:'session-a', projectId:'project-1' });
    const router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:join(dir,'pe3'), db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();

    const first = await router.prepare({ sourceSessionId:'session-a', prompt:'first turn' });
    const second = await router.prepare({ sourceSessionId:'session-a', prompt:'second turn' });
    assert.equal(first.targetSessionId,'session-a');
    assert.equal(second.targetSessionId,'session-a');

    router.accept(first.token);
    assert.throws(() => router.accept(second.token), /target session is busy/);

    assert.equal(router.abort(first.token).aborted,true);
    const accepted = router.accept(second.token);
    assert.equal(accepted.state,'accepted');
    assert.equal(accepted.targetSessionId,'session-a');
    assert.equal(router.abort(second.token).aborted,true);
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('attachment routing envelope is bounded and rejects invalid MIME metadata', () => {
  const values = Array.from({length:20},(_,index)=>({name:`file-${index}.txt`,mime:'text/plain',path:`src/file-${index}.txt`,size:index}));
  values[1] = { name:'bad', mime:'not a mime', path:'src/bad' };
  const normalized = normalizeAttachments(values);
  assert.ok(normalized.length <= 16);
  assert.equal(normalized.some((item)=>item.name==='bad'),false);
  assert.equal(normalized[0].mime,'text/plain');
});
