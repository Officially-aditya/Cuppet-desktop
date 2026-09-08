import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CuppetRelay, createSlidingWindowRateLimiter, isValidRelayHostId } from '../src/runtime/remote/relay.mjs';
import { WebSocketTransport } from '../src/runtime/remote/connection.mjs';
import { RemoteBridge } from '../src/runtime/remote/bridge.mjs';
import { authenticateDevice, claimPairingInvite, createPairingInvite } from '../src/runtime/remote/pairing.mjs';

class DeviceClient {
  frames=[]; socket; deviceId; secret;
  constructor(url,secret){this.deviceId=new URL(url).searchParams.get('deviceId');this.secret=secret;this.socket=new WebSocket(url);this.socket.addEventListener('message',(event)=>{try{this.frames.push(JSON.parse(String(event.data)));}catch{}});}
  async open(){await waitFor(()=>this.socket.readyState===WebSocket.OPEN||undefined,4000,'device open');if(this.secret)this.send({version:1,type:'device.hello',ts:Date.now(),payload:{deviceId:this.deviceId,secret:this.secret}});}
  send(value){this.socket.send(JSON.stringify(value));}
  next(predicate,label='frame'){return waitFor(()=>this.frames.find(predicate),5000,label);}
  close(){try{this.socket.close();}catch{}}
}

test('self-host relay routes only authenticated device commands and replays attach after accept', async () => {
  const relay=new CuppetRelay();await relay.listen(0);const dir=await mkdtemp(join(tmpdir(),'cuppet-c2-relay-'));let bridge;let device;
  try {
    const invite=await createPairingInvite(dir);const claimed=await claimPairingInvite(dir,invite.code,'phone');assert.ok(claimed);
    const hostUrl=`ws://127.0.0.1:${relay.port}/ws?role=host&hostId=host_e2e`;
    const transport=new WebSocketTransport(hostUrl);let executions=0;
    bridge=new RemoteBridge({hostId:'host_e2e',transport,commandAdapter:{detachDevice(){},async execute(_actor,type){executions++;return type==='session.list'?[{id:'s1'}]:null;}},authenticateDevice:(id,secret)=>authenticateDevice(dir,id,secret),buildAttachSnapshot:async()=>({snapshot:{ready:true}})});
    bridge.start();await transport.waitUntilConnected(1000);
    device=new DeviceClient(`ws://127.0.0.1:${relay.port}/ws?role=device&hostId=host_e2e&deviceId=${claimed.deviceId}`,claimed.secret);await device.open();
    await device.next((frame)=>frame.replyTo==='device-hello'&&frame.ok===true,'hello');
    const attach=await device.next((frame)=>frame.type==='host.attach','attach replay');assert.equal(attach.seq,0);assert.equal(attach.payload.snapshot.ready,true);
    device.send({version:1,id:'list-1',type:'session.list',ts:Date.now(),payload:{}});const result=await device.next((frame)=>frame.replyTo==='list-1','command result');assert.equal(result.ok,true);assert.deepEqual(result.result,[{id:'s1'}]);assert.equal(executions,1);
  } finally {device?.close();bridge?.stop();relay.close();await rm(dir,{recursive:true,force:true});}
});

test('relay refuses devices when the host room is offline and rate/host-id guards remain bounded', async () => {
  const relay=new CuppetRelay();await relay.listen(0);let close;
  try {
    const socket=new WebSocket(`ws://127.0.0.1:${relay.port}/ws?role=device&hostId=missing&deviceId=d1`);
    close=await new Promise((resolve)=>socket.addEventListener('close',(event)=>resolve({code:event.code,reason:event.reason}),{once:true}));
    assert.equal(close.code,4001);
    assert.equal(isValidRelayHostId('host.valid-1'),true);assert.equal(isValidRelayHostId('x'.repeat(129)),false);
    let now=0;const limiter=createSlidingWindowRateLimiter(2,100,()=>now);assert.equal(limiter(),false);assert.equal(limiter(),false);assert.equal(limiter(),true);now=100;assert.equal(limiter(),false);
  } finally {relay.close();}
});

async function waitFor(produce,timeout,label){const deadline=Date.now()+timeout;for(;;){const value=produce();if(value!==undefined&&value!==false)return value;if(Date.now()>deadline)throw new Error(`timeout waiting for ${label}`);await new Promise((resolve)=>setTimeout(resolve,15));}}
