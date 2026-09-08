import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';

function fixture(){
  const sessions=new Map([['s1',{id:'s1',projectId:'p1',title:'One',messages:[{role:'assistant',status:'complete',content:'ok'}]}]]);const calls=[];
  const call=async(method,params={})=>{calls.push({method,params});switch(method){
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
    case 'context.compact':return{abort:false};
    case 'permission.list':return[];
    case 'permission.reply':return{resolved:true};
    default:throw new Error(`unexpected ${method}`);
  }};
  const adapter=new RemoteCommandAdapter({call,identity:{hostId:'host_1',deviceName:'Laptop'},providerConfig:{baseUrl:'https://api.example.test/v1',model:'model-a',backgroundModel:'model-b',apiKey:'super-secret'}});
  return{adapter,calls};
}
const actor={deviceID:'dev_1'};

test('remote command adapter keeps provider secret local and binds device workspace/session state',async()=>{
  const {adapter,calls}=fixture();
  const host=await adapter.execute(actor,'host.get');assert.equal(host.provider.configured,true);assert.equal(JSON.stringify(host).includes('super-secret'),false);
  const workspaces=await adapter.execute(actor,'workspace.list');assert.deepEqual(workspaces.map((w)=>w.workspaceId),['p1']);
  await adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});
  const created=await adapter.execute(actor,'session.new',{});assert.equal(created.projectId,'p1');
  await adapter.execute(actor,'session.submit',{prompt:'Implement it'});
  const send=calls.findLast((entry)=>entry.method==='session.send');assert.equal(send.params.sessionId,'s2');assert.equal(send.params.provider.apiKey,'super-secret');
  assert.equal(JSON.stringify(await adapter.execute(actor,'session.snapshot')).includes('super-secret'),false);
});

test('remote model selection is constrained to host-configured models and unsupported authority fails explicitly',async()=>{
  const {adapter}=fixture();await adapter.execute(actor,'workspace.attach',{workspaceId:'p1'});await adapter.execute(actor,'session.resume',{sessionID:'s1'});
  const models=await adapter.execute(actor,'model.list');assert.deepEqual(models.map((m)=>m.modelID),['model-a','model-b']);
  assert.deepEqual(await adapter.execute(actor,'model.select',{providerID:'openai-compatible',modelID:'model-b'}),{providerID:'openai-compatible',modelID:'model-b'});
  await assert.rejects(()=>adapter.execute(actor,'model.select',{providerID:'openai-compatible',modelID:'model-c'}),/not configured/);
  await assert.rejects(()=>adapter.execute(actor,'session.undo'),/authoritative mutation journal/);
  await assert.rejects(()=>adapter.execute(actor,'question.reply',{requestID:'q1',answers:[['yes']]}),/not implemented/);
});

test('remote permission reply uses the C1 permission authority rather than a remote-side grant table',async()=>{
  const {adapter,calls}=fixture();await adapter.execute(actor,'permission.reply',{request:{id:'perm_1'},reply:'always'});
  assert.deepEqual(calls.findLast((entry)=>entry.method==='permission.reply'),{method:'permission.reply',params:{requestId:'perm_1',reply:'always'}});
});
