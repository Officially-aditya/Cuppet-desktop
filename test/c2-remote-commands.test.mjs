import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';

function fixture(){
  const sessions=new Map([['s1',{id:'s1',projectId:'p1',title:'One',messages:[{role:'assistant',status:'complete',content:'ok'}]}]]);const calls=[];
  const call=async(method,params={},context)=>{calls.push({method,params,...(context?{context}:{})});switch(method){
    case 'project.list':return[{id:'p1',name:'Project',canonicalPath:'/tmp/project'}];
    case 'project.get':return params.projectId==='p1'?{id:'p1',name:'Project',canonicalPath:'/tmp/project',missing:false}:null;
    case 'session.list':return[...sessions.values()].map(({messages,...rest})=>rest).filter((s)=>params.projectId===undefined||s.projectId===params.projectId);
    case 'session.get':{const value=sessions.get(params.sessionId);if(!value)throw new Error('unknown session');return structuredClone(value);}
    case 'session.create':{const value={id:'s2',projectId:params.projectId??null,title:'Two',messages:[]};sessions.set('s2',value);return{...value,messages:undefined};}
    case 'session.mode.get':return{sessionId:params.sessionId,mode:'build'};
    case 'session.mode.set':return{sessionId:params.sessionId,mode:params.mode};
    case 'session.auto.get':return{sessionId:params.sessionId,enabled:false};
    case 'session.send':return{accepted:true,sessionId:params.sessionId,messageId:'m1'};
    case 'session.stop':return{stopped:true,sessionId:params.sessionId};
    case 'session.undo':return{undone:true,sessionId:params.sessionId,path:'src/a.js'};
    case 'context.compact':return{abort:false};
    case 'permission.list':return[];
    case 'permission.reply':return{resolved:true};
    case 'question.list':return[];
    case 'question.reply':return{resolved:true,requestId:params.requestId,accepted:true};
    case 'question.reject':return{resolved:true,requestId:params.requestId,accepted:false};
    default:throw new Error(`unexpected ${method}`);
  }};
  const adapter=new RemoteCommandAdapter({call,identity:{hostId:'host_1',deviceName:'Laptop'},providerConfig:{baseUrl:'https://api.example.test/v1',model:'model-a',backgroundModel:'model-b',apiKey:'super-secret'}});
  return{adapter,calls};
}
const actor={deviceID:'dev_1'};

function expectedRemoteCommandId(deviceID,envelopeID){
  return `remote:${createHash('sha256').update(deviceID).update('\0').update(envelopeID).digest('hex')}`;
}

test('remote command adapter keeps provider secret local and binds device workspace/session state',async()=>{
  const {adapter,calls}=fixture();
  const host=await adapter.execute(actor,'host.get');assert.equal(host.provider.configured,true);assert.equal(JSON.stringify(host).includes('super-secret'),false);
  const providers=await adapter.execute(actor,'provider.list');
  assert.equal(providers.length,1);assert.equal(providers[0].id,'openai-compatible');assert.equal(providers[0].name,'OpenAI-compatible');assert.equal(providers[0].connected,true);
  assert.equal(JSON.stringify(providers).includes('api.example.test'),false);assert.equal(JSON.stringify(providers).includes('baseUrl'),false);assert.equal(JSON.stringify(providers).includes('apiKey'),false);
  const workspaces=await adapter.execute(actor,'workspace.list');assert.deepEqual(workspaces.map((w)=>w.workspaceId),['p1']);
  await adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});
  const created=await adapter.execute(actor,'session.new',{});assert.equal(created.projectId,'p1');
  await adapter.execute(actor,'session.submit',{prompt:'Implement it'},{id:'submit_1'});
  const send=calls.findLast((entry)=>entry.method==='session.send');assert.equal(send.params.sessionId,'s2');assert.equal(send.params.provider.apiKey,'super-secret');
  assert.equal(send.params.provider.baseUrl,'https://api.example.test/v1');
  assert.deepEqual(send.context,{commandId:expectedRemoteCommandId('dev_1','submit_1')});
  assert.equal(JSON.stringify(await adapter.execute(actor,'session.snapshot')).includes('super-secret'),false);
});

test('ordinary remote submits derive stable device-scoped durable command ids',async()=>{
  const {adapter,calls}=fixture();
  await adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});
  await adapter.execute(actor,'session.resume',{sessionID:'s1'});
  await adapter.execute(actor,'session.submit',{prompt:'same request'},{id:'envelope-A'});
  await adapter.execute(actor,'session.submit',{prompt:'same request'},{id:'envelope-A'});
  const dev1Sends=calls.filter((entry)=>entry.method==='session.send');
  assert.equal(dev1Sends.length,2);
  assert.equal(dev1Sends[0].context.commandId,dev1Sends[1].context.commandId);
  assert.equal(dev1Sends[0].context.commandId,expectedRemoteCommandId('dev_1','envelope-A'));

  const actor2={deviceID:'dev_2'};
  await adapter.execute(actor2,'workspace.attach',{workspaceId:'p1'});
  await adapter.execute(actor2,'session.resume',{sessionID:'s1'});
  await adapter.execute(actor2,'session.submit',{prompt:'same request'},{id:'envelope-A'});
  const dev2Send=calls.findLast((entry)=>entry.method==='session.send');
  assert.equal(dev2Send.context.commandId,expectedRemoteCommandId('dev_2','envelope-A'));
  assert.notEqual(dev2Send.context.commandId,dev1Sends[0].context.commandId);
});

test('remote submit command identity survives adapter recreation',async()=>{
  const first=fixture();
  await first.adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});
  await first.adapter.execute(actor,'session.resume',{sessionID:'s1'});
  await first.adapter.execute(actor,'session.submit',{prompt:'survive restart'},{id:'restart-envelope'});
  const firstSend=first.calls.findLast((entry)=>entry.method==='session.send');

  const second=fixture();
  await second.adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});
  await second.adapter.execute(actor,'session.resume',{sessionID:'s1'});
  await second.adapter.execute(actor,'session.submit',{prompt:'survive restart'},{id:'restart-envelope'});
  const secondSend=second.calls.findLast((entry)=>entry.method==='session.send');

  assert.equal(firstSend.context.commandId,expectedRemoteCommandId('dev_1','restart-envelope'));
  assert.equal(secondSend.context.commandId,firstSend.context.commandId);
});

test('remote model selection stays host constrained while undo and questions delegate to runtime authorities',async()=>{
  const {adapter,calls}=fixture();await adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});await adapter.execute(actor,'session.resume',{sessionID:'s1'});
  const models=await adapter.execute(actor,'model.list');assert.deepEqual(models.map((m)=>m.modelID),['model-a','model-b']);
  assert.deepEqual(await adapter.execute(actor,'model.select',{providerID:'openai-compatible',modelID:'model-b'}),{providerID:'openai-compatible',modelID:'model-b'});
  await assert.rejects(()=>adapter.execute(actor,'model.select',{providerID:'openai-compatible',modelID:'model-c'}),/not configured/);

  assert.deepEqual(await adapter.execute(actor,'session.undo'),{undone:true,sessionId:'s1',path:'src/a.js'});
  assert.deepEqual(calls.findLast((entry)=>entry.method==='session.undo'),{method:'session.undo',params:{sessionId:'s1'}});

  await adapter.execute(actor,'question.reply',{requestID:'q1',answers:[['yes']]});
  assert.deepEqual(calls.findLast((entry)=>entry.method==='question.reply'),{method:'question.reply',params:{requestId:'q1',answers:[['yes']]}});
  await adapter.execute(actor,'question.reject',{requestID:'q2'});
  assert.deepEqual(calls.findLast((entry)=>entry.method==='question.reject'),{method:'question.reject',params:{requestId:'q2'}});
});

test('remote permission reply uses the C1 permission authority rather than a remote-side grant table',async()=>{
  const {adapter,calls}=fixture();await adapter.execute(actor,'permission.reply',{request:{id:'perm_1'},reply:'always'});
  assert.deepEqual(calls.findLast((entry)=>entry.method==='permission.reply'),{method:'permission.reply',params:{requestId:'perm_1',reply:'always'}});
});
