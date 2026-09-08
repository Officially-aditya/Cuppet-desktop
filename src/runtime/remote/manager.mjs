import { join } from 'node:path';
import { RemoteBridge } from './bridge.mjs';
import { RemoteCommandAdapter } from './commands.mjs';
import { WebSocketTransport } from './connection.mjs';
import { ensureHostIdentity, setRemoteTokenPublicKey } from './identity.mjs';
import { authenticateDevice, claimPairingInvite, createPairingInvite, listPairedDevices, relayWebSocketUrl, revokeDevice } from './pairing.mjs';
import { registerHost } from './enroll.mjs';
import { runRemoteSetup } from './setup.mjs';
import { verifyRemoteToken } from './token.mjs';

const DEFAULT_CUPPET_API_BASE='https://connect.cuppet.in';

export class RemoteManager {
  #remoteDir; #call; #emit; #identity; #bridge; #transport; #commands; #relayUrl; #provider={}; #startedAt; #starting;
  constructor({dataDir,call,emit=()=>{}}){this.#remoteDir=join(dataDir,'remote');this.#call=call;this.#emit=emit;}
  async ready(){this.#identity??=await ensureHostIdentity(this.#remoteDir);return this.#identity;}
  setProviderConfig(config={}){this.#provider={...config};this.#commands?.setProviderConfig(this.#provider);return this.status();}
  handleRuntimeEvent(event){this.#bridge?.onRuntimeEvent(event);}
  async status(){const identity=await this.ready();return {running:Boolean(this.#bridge),connected:Boolean(this.#transport?.connected),hostId:identity.hostId,name:identity.deviceName,relayUrl:this.#relayUrl??null,startedAt:this.#startedAt??null,pairedDevices:(await listPairedDevices(this.#remoteDir)).length,providerConfigured:Boolean(this.#provider.apiKey&&this.#provider.model),protocolVersion:1};}

  async start({relayUrl,apiBase,authToken,setup=false,provider,createInvite=true,signal}={}){
    if(this.#bridge)return {status:await this.status(),invite:createInvite?await this.createInvite({role:'trusted'}):null};
    if(this.#starting)return this.#starting;
    this.#starting=this.#start({relayUrl,apiBase,authToken,setup,provider,createInvite,signal}).finally(()=>{this.#starting=undefined;});
    return this.#starting;
  }
  async #start({relayUrl,apiBase,authToken,setup,provider,createInvite,signal}){
    let identity=await this.ready();if(provider)this.setProviderConfig(provider);let resolvedRelay=relayUrl;const connectBase=apiBase||DEFAULT_CUPPET_API_BASE;
    if(authToken){
      const enrollment=await registerHost({apiBase:connectBase,token:authToken,identity,relaySecret:identity.relaySecret});resolvedRelay??=enrollment.relayUrl;
      if(enrollment.remoteTokenPublicKey)identity=await setRemoteTokenPublicKey(this.#remoteDir,enrollment.remoteTokenPublicKey);
    }else if(setup&&!resolvedRelay){
      const enrollment=await runRemoteSetup({apiBase:connectBase,identity,signal,onSetup:(prompt)=>this.#emit({type:'remote.setup',setup:prompt})});resolvedRelay=enrollment.relayUrl;
      if(enrollment.remoteTokenPublicKey)identity=await setRemoteTokenPublicKey(this.#remoteDir,enrollment.remoteTokenPublicKey);
    }
    if(!resolvedRelay)throw new Error('A relay URL or managed Cuppet setup is required to start remote control.');
    this.#identity=identity;this.#relayUrl=resolvedRelay;
    const hostUrl=new URL(relayWebSocketUrl(resolvedRelay));hostUrl.searchParams.set('role','host');hostUrl.searchParams.set('hostId',identity.hostId);hostUrl.searchParams.set('secret',identity.relaySecret);
    const transport=new WebSocketTransport(hostUrl.toString());
    const commands=new RemoteCommandAdapter({call:this.#call,identity,providerConfig:this.#provider});
    const bridge=new RemoteBridge({
      hostId:identity.hostId,transport,commandAdapter:commands,
      authenticateDevice:async(deviceId,secret)=>{const local=await authenticateDevice(this.#remoteDir,deviceId,secret);if(local)return local;if(!identity.remoteTokenPublicKey)return undefined;return verifyRemoteToken(secret,identity.remoteTokenPublicKey,identity.hostId,deviceId);},
      claimPairingInvite:(code,name)=>claimPairingInvite(this.#remoteDir,code,name),
      buildAttachSnapshot:async()=>({host:await commands.execute({deviceID:'attach'},'host.get',{},{}),workspaces:await commands.execute({deviceID:'attach'},'workspace.list',{},{}),permissions:await this.#call('permission.list',{}),questions:[]}),
    });
    this.#transport=transport;this.#commands=commands;this.#bridge=bridge;this.#startedAt=Date.now();bridge.start();
    try{await transport.waitUntilConnected();}catch(error){bridge.stop();this.#bridge=undefined;this.#transport=undefined;this.#commands=undefined;this.#startedAt=undefined;throw error;}
    const invite=createInvite?await this.createInvite({role:'trusted'}):null;this.#emit({type:'remote.started',status:await this.status(),invite});return {status:await this.status(),invite};
  }
  async stop(){if(!this.#bridge)return {stopped:false,status:await this.status()};this.#bridge.stop();this.#bridge=undefined;this.#transport=undefined;this.#commands=undefined;this.#startedAt=undefined;this.#emit({type:'remote.stopped'});return {stopped:true,status:await this.status()};}
  async createInvite({role='trusted',ttlMs}={}){const identity=await this.ready();const invite=await createPairingInvite(this.#remoteDir,{role,...(Number.isFinite(ttlMs)?{ttlMs}:{}),...(this.#relayUrl?{relayUrl:this.#relayUrl}:{}),hostId:identity.hostId});this.#emit({type:'remote.invite',invite:{code:invite.code,expiresAt:invite.expiresAt,role:invite.role,url:invite.url??null}});return invite;}
  async devices(){return listPairedDevices(this.#remoteDir);}
  async revoke(deviceId){const revoked=await revokeDevice(this.#remoteDir,deviceId);return {deviceId,revoked};}
  async close(){await this.stop().catch(()=>undefined);}
}
