import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBridge } from '../src/runtime/remote/bridge.mjs';

class FakeTransport {
  connected=false; sent=[]; messages=new Set(); statuses=new Set();
  start(){}
  send(data){this.sent.push(JSON.parse(data));}
  close(){this.connected=false;}
  onMessage(listener){this.messages.add(listener);return()=>this.messages.delete(listener);}
  onStatusChange(listener){this.statuses.add(listener);return()=>this.statuses.delete(listener);}
  connect(){this.connected=true;for(const listener of this.statuses)listener(true);}
  disconnect(){this.connected=false;for(const listener of this.statuses)listener(false);}
  receive(value){const data=JSON.stringify(value);for(const listener of this.messages)listener(data);}
}
const settle=()=>new Promise((resolve)=>setTimeout(resolve,15));

function command(id,type,payload={},deviceId='dev_1'){return{version:1,id,type,ts:Date.now(),payload,deviceId};}

test('bridge requires host authentication, checks scopes and executes replayed command ids once', async () => {
  const transport=new FakeTransport();let calls=0;
  const adapter={detachDevice(){},async execute(_actor,type){calls++;return{type,calls};}};
  const bridge=new RemoteBridge({hostId:'host_1',transport,commandAdapter:adapter,authenticateDevice:async(id,secret)=>id==='dev_1'&&secret==='secret'?{scopes:['session.read'],name:'viewer'}:undefined,buildAttachSnapshot:async()=>({snapshot:{ready:true}})});
  bridge.start();transport.connect();await settle();
  const attach=transport.sent.find((frame)=>frame.type==='host.attach');assert.equal(attach.seq,0);assert.equal(typeof attach.payload.connectionId,'string');

  transport.receive(command('before','session.list'));await settle();assert.equal(calls,0);assert.ok(transport.sent.some((frame)=>frame.replyTo==='before'&&frame.ok===false));
  transport.receive({version:1,type:'device.hello',deviceId:'dev_1',ts:Date.now(),payload:{deviceId:'dev_1',secret:'secret'}});await settle();
  assert.ok(transport.sent.some((frame)=>frame.type==='client.accept'&&frame.deviceId==='dev_1'));

  transport.receive(command('read','session.list'));await settle();assert.equal(calls,1);assert.ok(transport.sent.some((frame)=>frame.replyTo==='read'&&frame.ok===true));
  transport.receive(command('read','session.list'));await settle();assert.equal(calls,1);assert.ok(transport.sent.some((frame)=>frame.replyTo==='read'&&frame.result?.duplicate===true));
  transport.receive(command('write','session.abort'));await settle();assert.equal(calls,1);assert.match(String(transport.sent.find((frame)=>frame.replyTo==='write')?.error),/missing scope/);
  bridge.stop();
});

test('bridge buffers semantic runtime events while offline and preserves sequence after attach snapshot', async () => {
  const transport=new FakeTransport();
  const bridge=new RemoteBridge({hostId:'host_2',transport,commandAdapter:{detachDevice(){},async execute(){return null;}},authenticateDevice:async()=>undefined,buildAttachSnapshot:async()=>({snapshot:{}})});
  bridge.start();bridge.onRuntimeEvent({type:'message.delta',sessionId:'s1',delta:'hello'});bridge.onRuntimeEvent({type:'run.finished',sessionId:'s1'});
  assert.equal(transport.sent.length,0);transport.connect();await settle();
  assert.equal(transport.sent[0].type,'host.attach');assert.equal(transport.sent[0].seq,0);
  assert.deepEqual(transport.sent.slice(1).map((frame)=>[frame.seq,frame.type]),[[1,'assistant.text.delta'],[2,'session.idle']]);
  bridge.stop();
});

test('pairing can redeem a single-use invite without granting command authority until hello succeeds', async () => {
  const transport=new FakeTransport();let claimed=false;let calls=0;
  const bridge=new RemoteBridge({
    hostId:'host_pair',transport,commandAdapter:{detachDevice(){},async execute(){calls++;return[];}},
    claimPairingInvite:async(code)=>{if(code!=='GOOD'||claimed)return undefined;claimed=true;return{deviceId:'dev_new',secret:'new-secret',scopes:['session.read'],name:'phone'};},
    authenticateDevice:async(id,secret)=>id==='dev_new'&&secret==='new-secret'?{scopes:['session.read'],name:'phone'}:undefined,
  });
  bridge.start();transport.connect();await settle();
  transport.receive({version:1,type:'device.pair',deviceId:'pair_socket',ts:Date.now(),payload:{code:'GOOD',name:'phone'}});await settle();
  const pair=transport.sent.find((frame)=>frame.replyTo==='device-pair'&&frame.ok===true);assert.equal(pair.result.deviceId,'dev_new');
  transport.receive(command('blocked','session.list',{},'pair_socket'));await settle();assert.equal(calls,0);
  transport.receive({version:1,type:'device.hello',deviceId:'dev_new',ts:Date.now(),payload:{secret:'new-secret'}});await settle();
  transport.receive(command('allowed','session.list',{},'dev_new'));await settle();assert.equal(calls,1);
  bridge.stop();
});
