import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { Pe3ProjectRouter, normalizeAttachments } from '../src/runtime/pe3/router.mjs';
import { Pe3HandoffLedger } from '../src/runtime/pe3/handoff-ledger.mjs';

class NeverSemantic {
  modelID = 'never';
  async decide() { return { action:'continue', reason:'test fallback', fallback:true, activeSimilarity:0, promptEmbeddingCount:0, agentEmbeddingCount:0, embeddingLatencyMs:0, modelID:'never' }; }
}

function writeTurn(db, tx, { userId, assistantId, prompt, title = 'Task' }) {
  if (tx.action === 'create') db.createSession({ id:tx.targetSessionId, projectId:tx.projectId, title });
  const user = db.appendMessage({ id:userId, sessionId:tx.targetSessionId, role:'user', content:prompt, status:'complete' });
  const assistant = db.appendMessage({ id:assistantId, sessionId:tx.targetSessionId, role:'assistant', content:'', status:'streaming' });
  return { user, assistant, targetSession:db.getSessionSummary(tx.targetSessionId) };
}

async function seedFirstTurn(router, db, prompt = 'Implement auth in src/auth.ts') {
  const first = await router.prepare({ sourceSessionId:'session-a', prompt });
  router.accept(first.token);
  return router.commit(first.token, (tx) => writeTurn(db, tx, { userId:'auth-user', assistantId:'auth-run', prompt, title:'Auth' }));
}

test('PE3 transactional create rolls back target writes and durable handoff identity on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-tx-'));
  const db = new ConversationDatabase(join(dir,'db.sqlite3'));
  try {
    db.createProject({ id:'project-1', name:'P', canonicalPath:dir });
    db.createSession({ id:'session-a', projectId:'project-1' });
    const router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:join(dir,'pe3'), db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();
    await seedFirstTurn(router, db);

    const prepared = await router.prepare({ sourceSessionId:'session-a', prompt:'New task: implement billing in src/billing.ts' });
    assert.equal(prepared.action,'create');
    router.accept(prepared.token);
    const target = prepared.targetSessionId;
    await assert.rejects(() => router.commit(prepared.token, (tx) => {
      db.createSession({ id:tx.targetSessionId, projectId:'project-1' });
      db.appendMessage({ id:'marker-failed', sessionId:'session-a', role:'system', content:'should rollback' });
      throw new Error('forced database failure');
    }), /forced database failure/);
    assert.equal(db.getSessionSummary(target),null);
    assert.deepEqual(db.getSession('session-a').messages.map((message)=>message.id),['auth-user','auth-run']);
    const ledger = new Pe3HandoffLedger({ db, projectId:'project-1' });
    assert.equal(ledger.get(prepared.token)?.state,'aborted');

    const retry = await router.prepare({ sourceSessionId:'session-a', prompt:'New task: implement billing in src/billing.ts' });
    router.accept(retry.token);
    const committed = await router.commit(retry.token, (tx) => {
      db.appendMessage({ id:'marker-ok', sessionId:'session-a', role:'system', content:`routed to ${tx.targetSessionId}` });
      return writeTurn(db, tx, { userId:'billing-user', assistantId:'billing-run', prompt:'New task: implement billing in src/billing.ts', title:'Billing' });
    });
    assert.equal(committed.route.action,'create');
    assert.ok(committed.route.handoffSequence > 0);
    assert.equal(committed.route.targetUserMessageId,'billing-user');
    assert.equal(committed.route.assistantRunId,'billing-run');
    const durable = ledger.get(retry.token);
    assert.equal(durable.state,'committed');
    assert.equal(durable.sourceSessionId,'session-a');
    assert.equal(durable.targetSessionId,committed.route.targetSessionId);
    assert.equal(durable.targetUserMessageId,'billing-user');
    assert.equal(durable.assistantRunId,'billing-run');
    const sourceMessages = db.getSession('session-a').messages;
    assert.equal(sourceMessages.filter((message)=>message.role==='user').length,1);
    assert.equal(sourceMessages.filter((message)=>message.role==='system').length,1);
    const targetMessages = db.getSession(committed.route.targetSessionId).messages;
    assert.deepEqual(targetMessages.map((message)=>message.id),['billing-user','billing-run']);
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('PE3 accept reserves a target durably until the accepted handoff commits or aborts', async () => {
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
    const ledger = new Pe3HandoffLedger({ db, projectId:'project-1' });
    assert.equal(ledger.get(first.token)?.state,'accepted');
    assert.throws(() => router.accept(second.token), /target session is busy/);

    assert.equal(router.abort(first.token).aborted,true);
    assert.equal(ledger.get(first.token)?.state,'aborted');
    const accepted = router.accept(second.token);
    assert.equal(accepted.state,'accepted');
    assert.equal(ledger.get(second.token)?.state,'accepted');
    assert.equal(router.abort(second.token).aborted,true);
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('PE3 restart interrupts accepted handoffs and never replays their side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-interrupted-'));
  const dbPath = join(dir,'db.sqlite3');
  const store = join(dir,'pe3');
  let db = new ConversationDatabase(dbPath);
  try {
    db.createProject({ id:'project-1', name:'P', canonicalPath:dir });
    db.createSession({ id:'session-a', projectId:'project-1' });
    const router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:store, db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();
    const prepared = await router.prepare({ sourceSessionId:'session-a', prompt:'first turn' });
    router.accept(prepared.token);
    db.close();

    db = new ConversationDatabase(dbPath);
    const restarted = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:store, db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await restarted.ready();
    const ledger = new Pe3HandoffLedger({ db, projectId:'project-1' });
    assert.equal(ledger.get(prepared.token)?.state,'interrupted');
    assert.deepEqual(db.getSession('session-a').messages,[]);
    assert.equal(restarted.status().pendingTransactions,0);
  } finally { db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('PE3 rebuilds committed sibling task identities from SQLite exactly once after registry loss', async () => {
  const dir = await mkdtemp(join(tmpdir(),'cuppet-pe3-rebuild-'));
  const dbPath = join(dir,'db.sqlite3');
  const store = join(dir,'pe3');
  let db = new ConversationDatabase(dbPath);
  try {
    db.createProject({ id:'project-1', name:'P', canonicalPath:dir });
    db.createSession({ id:'session-a', projectId:'project-1' });
    let router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:store, db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();
    await seedFirstTurn(router, db);

    const prepared = await router.prepare({ sourceSessionId:'session-a', prompt:'New task: implement billing in src/billing.ts' });
    router.accept(prepared.token);
    const committed = await router.commit(prepared.token, (tx) => writeTurn(db, tx, { userId:'billing-user', assistantId:'billing-run', prompt:'New task: implement billing in src/billing.ts', title:'Billing' }));
    const sibling = committed.route.targetSessionId;
    const committedSequence = committed.route.handoffSequence;
    assert.notEqual(sibling,'session-a');
    await rm(join(store,'pe3-task-agents.json'),{force:true});
    db.close();

    db = new ConversationDatabase(dbPath);
    router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:store, db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();
    let status = router.status();
    assert.equal(status.handoffSequence,committedSequence);
    assert.equal(status.active?.sessionID,sibling);
    assert.deepEqual(new Set(status.agents.map((agent)=>agent.sessionID)),new Set(['session-a',sibling]));
    assert.equal(status.agents.find((agent)=>agent.sessionID==='session-a')?.turns,1);
    assert.equal(status.agents.find((agent)=>agent.sessionID===sibling)?.turns,1);
    db.close();

    db = new ConversationDatabase(dbPath);
    router = new Pe3ProjectRouter({ projectId:'project-1', projectRoot:dir, projectStore:store, db, tst:{ configured:false }, semanticRouter:new NeverSemantic() });
    await router.ready();
    status = router.status();
    assert.equal(status.handoffSequence,committedSequence);
    assert.equal(status.agents.find((agent)=>agent.sessionID==='session-a')?.turns,1);
    assert.equal(status.agents.find((agent)=>agent.sessionID===sibling)?.turns,1);
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
