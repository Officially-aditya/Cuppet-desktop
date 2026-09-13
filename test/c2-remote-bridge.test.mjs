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

async function authenticate(transport,bridge,deviceId='dev_1',secret='secret'){
  bridge.start();transport.connect();await settle();
  transport.receive({version:1,type:'device.hello',deviceId,ts:Date.now(),payload:{deviceId,secret}});await settle();
}

test('bridge requires host authentication, reports the active device, checks scopes and replays exact command results once', async () => {
  const transport=new FakeTransport();let calls=0;const deviceChanges=[];
  const adapter={detachDevice(){},async execute(_actor,type){calls++;return{type,calls};}};
  const bridge=new RemoteBridge({hostId:'host_1',transport,commandAdapter:adapter,authenticateDevice:async(id,secret)=>id==='dev_1'&&secret==='secret'?{scopes:['session.read'],name:'viewer'}:undefined,buildAttachSnapshot:async()=>({snapshot:{ready:true}}),onDeviceChange:(devices)=>deviceChanges.push(devices)});
  bridge.start();transport.connect();await settle();
  const attach=transport.sent.find((frame)=>frame.type==='host.attach');assert.equal(attach.seq,0);assert.equal(typeof attach.payload.connectionId,'string');

  transport.receive(command('before','session.list'));await settle();assert.equal(calls,0);assert.ok(transport.sent.some((frame)=>frame.replyTo==='before'&&frame.ok===false));
  transport.receive({version:1,type:'device.hello',deviceId:'dev_1',ts:Date.now(),payload:{deviceId:'dev_1',secret:'secret'}});await settle();
  assert.ok(transport.sent.some((frame)=>frame.type==='client.accept'&&frame.deviceId==='dev_1'));
  assert.deepEqual(bridge.activeDevices,[{deviceId:'dev_1',name:'viewer',scopes:['session.read']}]);
  assert.deepEqual(deviceChanges.at(-1),bridge.activeDevices);

  transport.receive(command('read','session.list'));await settle();assert.equal(calls,1);
  const first=transport.sent.find((frame)=>frame.replyTo==='read'&&frame.ok===true);assert.deepEqual(first.result,{type:'session.list',calls:1});
  transport.receive(command('read','session.list'));await settle();assert.equal(calls,1);
  const readReplies=transport.sent.filter((frame)=>frame.replyTo==='read'&&frame.ok===true);assert.equal(readReplies.length,2);assert.deepEqual(readReplies[1].result,first.result);
  transport.receive(command('write','session.abort'));await settle();assert.equal(calls,1);assert.match(String(transport.sent.find((frame)=>frame.replyTo==='write')?.error),/missing scope/);
  bridge.stop();
  assert.deepEqual(bridge.activeDevices,[]);
  assert.deepEqual(deviceChanges.at(-1),[]);
});

test('concurrent duplicate waits for and replays the original result instead of claiming success early', async () => {
  const transport=new FakeTransport();let calls=0;let release;
  const gate=new Promise((resolve)=>{release=resolve;});
  const adapter={detachDevice(){},async execute(){calls++;await gate;return{accepted:true,calls};}};
  const bridge=new RemoteBridge({hostId:'host_dedupe',transport,commandAdapter:adapter,authenticateDevice:async()=>({scopes:['session.read'],name:'phone'})});
  await authenticate(transport,bridge);

  transport.receive(command('same','session.list'));
  transport.receive(command('same','session.list'));
  await new Promise((resolve)=>setTimeout(resolve,5));
  assert.equal(calls,1);
  assert.equal(transport.sent.filter((frame)=>frame.replyTo==='same').length,0,'duplicate must not receive speculative success before the original resolves');
  release();await settle();
  const replies=transport.sent.filter((frame)=>frame.replyTo==='same');
  assert.equal(replies.length,2);
  assert.deepEqual(replies[0],replies[1]);
  assert.deepEqual(replies[0].result,{accepted:true,calls:1});
  bridge.stop();
});

test('bridge preserves structured receipt error codes and replays the exact failure', async () => {
  const transport=new FakeTransport();let calls=0;
  const adapter={detachDevice(){},async execute(){calls++;const error=new Error('Command outcome is unknown after restart.');error.code='COMMAND_OUTCOME_UNKNOWN';throw error;}};
  const bridge=new RemoteBridge({hostId:'host_error',transport,commandAdapter:adapter,authenticateDevice:async()=>({scopes:['session.read'],name:'phone'})});
  await authenticate(transport,bridge);

  transport.receive(command('unknown','session.list'));await settle();
  transport.receive(command('unknown','session.list'));await settle();
  assert.equal(calls,1);
  const replies=transport.sent.filter((frame)=>frame.replyTo==='unknown');
  assert.equal(replies.length,2);
  assert.equal(replies[0].ok,false);
  assert.equal(replies[0].code,'COMMAND_OUTCOME_UNKNOWN');
  assert.deepEqual(replies[1],replies[0]);
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
  assert.equal(bridge.activeDevices[0]?.name,'phone');
  transport.receive(command('allowed','session.list',{},'dev_new'));await settle();assert.equal(calls,1);
  bridge.stop();
});

test('live device authorization is revalidated before every command', async () => {
  const transport=new FakeTransport();
  let valid=true;
  let calls=0;
  let detached=0;
  const device={
    scopes:['session.read'],
    name:'phone',
    reauthorize:async()=>valid?{scopes:['session.read'],name:'phone'}:undefined,
  };
  const bridge=new RemoteBridge({
    hostId:'host_live',
    transport,
    commandAdapter:{detachDevice(){detached++;},async execute(){calls++;return[];}},
    authenticateDevice:async(id,secret)=>id==='dev_1'&&secret==='secret'?device:undefined,
  });
  bridge.start();transport.connect();await settle();
  transport.receive({version:1,type:'device.hello',deviceId:'dev_1',ts:Date.now(),payload:{secret:'secret'}});await settle();
  transport.receive(command('before-revoke','session.list'));await settle();
  assert.equal(calls,1);
  assert.equal(bridge.activeDevices.length,1);

  valid=false;
  transport.receive(command('after-revoke','session.list'));await settle();
  assert.equal(calls,1,'revoked device must not reach command execution');
  assert.deepEqual(bridge.activeDevices,[]);
  assert.ok(detached>=1);
  assert.ok(transport.sent.some((frame)=>frame.type==='client.reject'&&frame.deviceId==='dev_1'));
  assert.match(String(transport.sent.find((frame)=>frame.replyTo==='after-revoke')?.error),/authorization is no longer valid/i);
  bridge.stop();
});

test('explicit revoke immediately ejects an authenticated live device', async () => {
  const transport=new FakeTransport();
  let calls=0;
  const bridge=new RemoteBridge({
    hostId:'host_revoke',
    transport,
    commandAdapter:{detachDevice(){},async execute(){calls++;return[];}},
    authenticateDevice:async(id,secret)=>id==='dev_1'&&secret==='secret'?{scopes:['session.read'],name:'phone'}:undefined,
  });
  bridge.start();transport.connect();await settle();
  transport.receive({version:1,type:'device.hello',deviceId:'dev_1',ts:Date.now(),payload:{secret:'secret'}});await settle();
  assert.equal(bridge.activeDevices.length,1);
  assert.equal(bridge.revokeDevice('dev_1'),true);
  assert.deepEqual(bridge.activeDevices,[]);
  assert.ok(transport.sent.some((frame)=>frame.type==='client.reject'&&frame.deviceId==='dev_1'&&/revoked/i.test(String(frame.payload?.reason))));

  transport.receive(command('after-explicit-revoke','session.list'));await settle();
  assert.equal(calls,0);
  assert.match(String(transport.sent.find((frame)=>frame.replyTo==='after-explicit-revoke')?.error),/not authenticated/i);
  bridge.stop();
});
