import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeFrame, parseCommandFrame, MAX_FRAME_BYTES, PROTOCOL_VERSION, scopeForCommand } from '../src/runtime/remote/protocol.mjs';
import { authenticateDevice, claimPairingInvite, createPairingInvite, revokeDevice } from '../src/runtime/remote/pairing.mjs';
import { ensureHostIdentity } from '../src/runtime/remote/identity.mjs';
import { verifyRemoteToken } from '../src/runtime/remote/token.mjs';
import { runRemoteSetup } from '../src/runtime/remote/setup.mjs';

test('remote protocol is versioned, size-capped and fail-closed to known commands', () => {
  const parsed=parseCommandFrame(JSON.stringify({version:1,id:'c1',type:'session.list',ts:1,payload:{}}));
  assert.equal(parsed.type,'session.list');
  assert.equal(PROTOCOL_VERSION,1);
  assert.equal(scopeForCommand('permission.reply'),'permission.write');
  assert.throws(()=>parseCommandFrame(JSON.stringify({version:2,id:'x',type:'session.list',ts:1})),/version/);
  assert.throws(()=>parseCommandFrame(JSON.stringify({version:1,id:'x',type:'memory.clear',ts:1})),/unsupported/);
  assert.throws(()=>encodeFrame('x'.repeat(MAX_FRAME_BYTES+1)),/exceeds/);
});

test('pairing invites are atomic single-use credentials with viewer/trusted scopes and revocation', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-c2-pair-'));
  try {
    const trusted=await createPairingInvite(dir,{ttlMs:30_000});
    const [a,b]=await Promise.all([claimPairingInvite(dir,trusted.code,'A'),claimPairingInvite(dir,trusted.code,'B')]);
    const winner=a??b;assert.ok(winner);assert.equal(Boolean(a)&&Boolean(b),false);assert.ok(winner.scopes.includes('session.write'));
    assert.ok(await authenticateDevice(dir,winner.deviceId,winner.secret));
    assert.equal(await authenticateDevice(dir,winner.deviceId,'wrong'),undefined);
    assert.equal(await revokeDevice(dir,winner.deviceId),true);
    assert.equal(await authenticateDevice(dir,winner.deviceId,winner.secret),undefined);
    const viewerInvite=await createPairingInvite(dir,{role:'viewer'});const viewer=await claimPairingInvite(dir,viewerInvite.code,'viewer');assert.deepEqual(viewer.scopes,['session.read']);
    const expired=await createPairingInvite(dir,{ttlMs:-1});assert.equal(await claimPairingInvite(dir,expired.code,'late'),undefined);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('managed remote JWTs are locally verified and bound to host device expiry and mapped scopes', async () => {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const publicKeyBase64=publicKey.export({type:'spki',format:'der'}).toString('base64');
  const now=Math.floor(Date.now()/1000);const token=jwt(privateKey,{iss:'cuppet-backend',aud:'cuppet-relay',sub:'user_1',host:'host_1',device:'dev_1',scopes:['sessions:read','permissions:reply','models:write'],iat:now,exp:now+300});
  assert.deepEqual(verifyRemoteToken(token,publicKeyBase64,'host_1','dev_1',now),{scopes:['session.read','permission.write','model.write'],expiresAt:now+300});
  assert.equal(verifyRemoteToken(token,publicKeyBase64,'host_2','dev_1',now),undefined);
  assert.equal(verifyRemoteToken(`${token}x`,publicKeyBase64,'host_1','dev_1',now),undefined);
  const expired=jwt(privateKey,{iss:'cuppet-backend',aud:'cuppet-relay',sub:'u',host:'host_1',device:'dev_1',scopes:['sessions:read'],exp:now-1});
  assert.equal(verifyRemoteToken(expired,publicKeyBase64,'host_1','dev_1',now),undefined);
});

test('first-time setup never exposes polling or relay secrets in its app-link prompt', async () => {
  const dir=await mkdtemp(join(tmpdir(),'cuppet-c2-setup-'));
  try {
    const identity=await ensureHostIdentity(dir);const pollSecret='poll-secret-private';let statusCalls=0;let claimedBody;
    const enrollment=await runRemoteSetup({
      apiBase:'https://connect.example.test',identity,pollIntervalMs:0,timeoutMs:1000,
      onSetup:(value)=>{assert.match(value.url,/^cuppet:\/\/remote\/setup/);assert.equal(value.url.includes(pollSecret),false);assert.equal(value.url.includes(identity.relaySecret),false);},
      fetcher:async(input,init)=>{
        const url=String(input);
        if(url.endsWith('/remote/setup/sessions'))return new Response(JSON.stringify({setupId:'setup_1',setupCode:'ABC123',pollSecret,setupUrl:'cuppet://remote/setup?session=setup_1&code=ABC123',expiresAt:new Date(Date.now()+60_000).toISOString()}),{status:200});
        if(url.endsWith('/status')){assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${pollSecret}`);statusCalls++;return new Response(JSON.stringify({status:statusCalls===1?'pending':'approved'}),{status:200});}
        if(url.endsWith('/claim')){assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${pollSecret}`);claimedBody=JSON.parse(String(init?.body));return new Response(JSON.stringify({relayUrl:'wss://relay.example.test',relayRegistered:true}),{status:200});}
        throw new Error(`unexpected ${url}`);
      },
    });
    assert.deepEqual(claimedBody,{relaySecret:identity.relaySecret});assert.equal(enrollment.relayUrl,'wss://relay.example.test');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

function jwt(privateKey,payload){const enc=(value)=>Buffer.from(JSON.stringify(value)).toString('base64url');const header=enc({alg:'EdDSA',typ:'JWT'});const body=enc(payload);const signature=sign(null,Buffer.from(`${header}.${body}`),privateKey).toString('base64url');return `${header}.${body}.${signature}`;}
