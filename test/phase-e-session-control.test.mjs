import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuestionBroker, QuestionInteractionRequiredError, QuestionRejectedError } from '../src/runtime/questions.mjs';
import { MutationJournal, UndoConflictError } from '../src/runtime/mutation-journal.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { PermissionBroker } from '../src/runtime/permissions.mjs';
import { ConversationDatabase } from '../src/runtime/database.mjs';

function nextTick(){return new Promise((resolve)=>setImmediate(resolve));}

test('question broker is bounded, resumable, rejectable, and noninteractive fails closed', async () => {
  const events=[];const broker=new QuestionBroker({emit:(event)=>events.push(event),interactive:true});
  try{
    const pending=broker.ask({sessionId:'s1',questions:[{header:'Choice',question:'Which route?',options:[{label:'A',description:'first'},{label:'B'}]}]});
    await nextTick();const request=broker.list('s1')[0];assert.ok(request?.id);assert.equal(request.questions.length,1);assert.equal(events[0].type,'question.requested');
    assert.deepEqual(broker.reply(request.id,[['B']]),{resolved:true,requestId:request.id,accepted:true});
    assert.deepEqual(await pending,{requestId:request.id,answers:[['B']]});

    const rejected=broker.ask({sessionId:'s1',questions:[{question:'Continue?'}]});await nextTick();const rejectId=broker.list('s1')[0].id;broker.reject(rejectId);
    await assert.rejects(rejected,QuestionRejectedError);
  } finally { broker.close(); }

  const headless=new QuestionBroker({interactive:false});
  await assert.rejects(()=>headless.ask({sessionId:'s1',questions:[{question:'Need user?'}]}),QuestionInteractionRequiredError);
  headless.close();
});

test('mutation journal restores exact bytes and survives restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-e-journal-'));const root=join(dir,'project');const journalDir=join(dir,'journal');const target=join(root,'src','a.js');
  try{
    await mkdir(join(root,'src'),{recursive:true});await writeFile(target,'before\n','utf8');
    const first=new MutationJournal(journalDir);const token=await first.beginFile({sessionId:'s1',executionId:'call1',tool:'workspace_edit',projectRoot:root,path:'src/a.js'});
    await writeFile(target,'after\n','utf8');await first.commitFile(token);
    const restored=new MutationJournal(journalDir);const result=await restored.undoLatest({sessionId:'s1',projectRoot:root});
    assert.equal(result.undone,true);assert.equal(result.path,'src/a.js');assert.equal(await readFile(target,'utf8'),'before\n');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('mutation journal removes a newly-created file on undo', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-e-create-'));const root=join(dir,'project');const target=join(root,'new.txt');
  try{
    await mkdir(root,{recursive:true});const journal=new MutationJournal(join(dir,'journal'));const token=await journal.beginFile({sessionId:'s1',executionId:'call1',tool:'workspace_write',projectRoot:root,path:'new.txt'});
    await writeFile(target,'created','utf8');await journal.commitFile(token);assert.equal((await journal.undoLatest({sessionId:'s1',projectRoot:root})).undone,true);await assert.rejects(access(target));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('undo refuses to overwrite external edits and refuses to cross opaque shell mutation', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-e-conflict-'));const root=join(dir,'project');const target=join(root,'a.txt');
  try{
    await mkdir(root,{recursive:true});await writeFile(target,'before','utf8');const journal=new MutationJournal(join(dir,'journal'));
    const token=await journal.beginFile({sessionId:'s1',executionId:'edit1',tool:'workspace_edit',projectRoot:root,path:'a.txt'});await writeFile(target,'cuppet','utf8');await journal.commitFile(token);await writeFile(target,'human edit','utf8');
    await assert.rejects(()=>journal.undoLatest({sessionId:'s1',projectRoot:root}),UndoConflictError);assert.equal(await readFile(target,'utf8'),'human edit');

    const second=new MutationJournal(join(dir,'journal2'));const token2=await second.beginFile({sessionId:'s2',executionId:'edit2',tool:'workspace_edit',projectRoot:root,path:'a.txt'});await writeFile(target,'cuppet2','utf8');await second.commitFile(token2);await second.recordBarrier({sessionId:'s2',executionId:'bash1',paths:['a.txt']});
    await assert.rejects(()=>second.undoLatest({sessionId:'s2',projectRoot:root}),/opaque/);assert.equal(await readFile(target,'utf8'),'cuppet2');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('journaled tool runtime snapshots before mutation and records reversible workspace write', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-e-runtime-'));const root=join(dir,'project');const db=new ConversationDatabase(join(dir,'db.sqlite3'));const permissions=new PermissionBroker();
  try{
    await mkdir(root,{recursive:true});db.createProject({id:'p1',name:'Project',canonicalPath:root});db.createSession({id:'s1',projectId:'p1'});permissions.setAuto('s1',true);
    const journal=new MutationJournal(join(dir,'journal'));const tools=new JournaledToolRuntime({journal,tst:{configured:false},planStore:{async toolResult(){return null;}},permissions,questions:new QuestionBroker(),db});
    let step=0;const adapter={async stream(){step++;if(step===1)return{text:'',toolCalls:[{id:'call_write',name:'workspace_write',arguments:'{"path":"generated.txt","content":"hello"}'}]};return{text:'done',toolCalls:[]};}};
    await tools.run({adapter,messages:[{role:'user',content:'write it'}],sessionId:'s1',projectId:'p1',projectRoot:root,mode:'build',signal:new AbortController().signal,onDelta:async()=>{}});
    assert.equal(await readFile(join(root,'generated.txt'),'utf8'),'hello');const status=await journal.status('s1');assert.equal(status.available,true);assert.equal(status.latest.kind,'file');
    assert.equal((await journal.undoLatest({sessionId:'s1',projectRoot:root})).undone,true);await assert.rejects(access(join(root,'generated.txt')));
  } finally { permissions.close();db.close();await rm(dir,{recursive:true,force:true}); }
});
