import { randomUUID } from 'node:crypto';
import { encodeFrame, eventFrame, parseCommandFrame, publicEventFor, scopeForCommand, PROTOCOL_VERSION, MINIMUM_CLIENT_VERSION } from './protocol.mjs';

const DEDUPE_CAPACITY=512;
const OFFLINE_EVENT_LIMIT=256;

export class RemoteBridge {
  #hostId; #transport; #commands; #authenticateDevice; #claimPairingInvite; #buildAttachSnapshot; #onDeviceChange; #seq=0; #connectionId=randomUUID(); #seen=new Map(); #offline=[]; #devices=new Map(); #timers=new Map(); #started=false; #off=[];
  constructor({hostId,transport,commandAdapter,authenticateDevice,claimPairingInvite,buildAttachSnapshot,onDeviceChange}){
    this.#hostId=hostId;this.#transport=transport;this.#commands=commandAdapter;this.#authenticateDevice=authenticateDevice;this.#claimPairingInvite=claimPairingInvite;this.#buildAttachSnapshot=buildAttachSnapshot;this.#onDeviceChange=onDeviceChange;
  }
  get connected(){return Boolean(this.#transport.connected);}
  get sequence(){return this.#seq;}
  get activeDevices(){return [...this.#devices.entries()].map(([deviceId,device])=>({deviceId,name:device.name??'device',scopes:[...device.scopes]}));}
  start(){
    if(this.#started)return;this.#started=true;this.#transport.start?.();
    this.#off.push(this.#transport.onMessage((data)=>void this.#handleIncoming(data).catch((error)=>this.#publish('bridge.error',{message:cleanError(error)}))));
    this.#off.push(this.#transport.onStatusChange((connected)=>{if(!connected){this.#clearDevices();return;}void this.#onConnected();}));
    if(this.#transport.connected)void this.#onConnected();
  }
  stop(){if(!this.#started)return;this.#started=false;for(const off of this.#off.splice(0)){try{off?.();}catch{}}this.#clearDevices();this.#offline.length=0;try{this.#transport.close();}catch{}}
  onRuntimeEvent(event){const mapped=publicEventFor(event);if(mapped)this.#publish(mapped.type,mapped.payload,mapped.sessionId);}
  publish(type,payload,sessionId){this.#publish(type,payload,sessionId);}
  revokeDevice(deviceId,message='remote credential revoked'){
    const id=String(deviceId??'');
    if(!id||!this.#devices.has(id))return false;
    this.#clearDevice(id);
    this.#rejectSession(id,message);
    return true;
  }

  async #onConnected(){
    try{
      const snapshot=this.#buildAttachSnapshot?await this.#buildAttachSnapshot():{};
      this.#send({version:PROTOCOL_VERSION,seq:0,hostId:this.#hostId,ts:Date.now(),type:'host.attach',payload:{...snapshot,connectionId:this.#connectionId,protocolVersion:PROTOCOL_VERSION,minimumClientVersion:MINIMUM_CLIENT_VERSION}});
    }catch(error){this.#publish('bridge.error',{message:`attach snapshot failed: ${cleanError(error)}`});}
    for(const frame of this.#offline.splice(0))this.#send(frame);
  }
  #publish(type,payload,sessionId){const frame=eventFrame(this.#hostId,++this.#seq,type,payload,sessionId);if(!this.#transport.connected){this.#offline.push(frame);if(this.#offline.length>OFFLINE_EVENT_LIMIT)this.#offline.shift();return;}this.#send(frame);}
  #send(frame){try{this.#transport.send(encodeFrame(frame));}catch{}}

  async #handleIncoming(data){
    let raw;try{raw=JSON.parse(data);}catch{return this.#publish('bridge.error',{message:'malformed frame'});}
    const kind=typeof raw.type==='string'?raw.type:'';if(kind==='ping')return;
    const deviceId=typeof raw.deviceId==='string'&&raw.deviceId?raw.deviceId:String(raw.payload?.deviceId??'');
    if(kind==='device.hello')return this.#hello(raw,deviceId);
    if(kind==='device.pair')return this.#pair(raw,deviceId);
    const device=deviceId?this.#devices.get(deviceId):undefined;
    if(!device){if(deviceId)this.#rejectDevice(deviceId,'not authenticated');const id=typeof raw.id==='string'?raw.id:'';if(id)this.#resultError(id,'not authenticated',deviceId);return;}
    const authorized=await this.#reauthorize(deviceId,device);
    if(!authorized){
      const id=typeof raw.id==='string'?raw.id:'';
      this.#clearDevice(deviceId);
      this.#rejectSession(deviceId,'remote authorization is no longer valid');
      if(id)this.#resultError(id,'remote authorization is no longer valid',deviceId);
      return;
    }
    let envelope;try{envelope=parseCommandFrame(data);}catch(error){return this.#resultError(typeof raw.id==='string'?raw.id:'unknown',`malformed command: ${cleanError(error)}`,deviceId);}
    const required=scopeForCommand(envelope.type);
    if(!required||!authorized.scopes.includes(required))return this.#resultError(envelope.id,`missing scope '${required??'none'}' for ${envelope.type}`,deviceId);

    const dedupeKey=`${deviceId}:${envelope.id}`;
    const existing=this.#seen.get(dedupeKey);
    if(existing)return this.#send(await existing);

    const response=this.#executeCommand(deviceId,authorized,envelope);
    this.#remember(dedupeKey,response);
    this.#send(await response);
  }
  async #executeCommand(deviceId,authorized,envelope){
    try{
      const actor={kind:'remote',deviceID:deviceId,deviceName:authorized.name,scopes:[...authorized.scopes]};
      const result=await this.#commands.execute(actor,envelope.type,envelope.payload??{},envelope);
      return {version:PROTOCOL_VERSION,replyTo:envelope.id,ok:true,...(result!==undefined?{result}:{}),deviceId};
    }catch(error){return this.#errorFrame(envelope.id,cleanError(error),deviceId,errorCode(error));}
  }
  async #reauthorize(deviceId,device){
    if(typeof device.reauthorize!=='function')return device;
    const refreshed=await device.reauthorize().catch(()=>undefined);
    if(!refreshed)return undefined;
    const scopes=Array.isArray(refreshed.scopes)?refreshed.scopes.filter((scope)=>typeof scope==='string'):[];
    const expiresAt=Number.isFinite(refreshed.expiresAt)?refreshed.expiresAt:undefined;
    const next={...device,scopes,name:typeof refreshed.name==='string'?refreshed.name:device.name,...(expiresAt!==undefined?{expiresAt}:{}),reauthorize:device.reauthorize};
    if(expiresAt===undefined)delete next.expiresAt;
    this.#devices.set(deviceId,next);
    if(device.expiresAt!==next.expiresAt)this.#scheduleExpiry(deviceId,next.expiresAt);
    return next;
  }
  async #pair(raw,deviceId){
    const fail=(message)=>this.#send({version:PROTOCOL_VERSION,replyTo:'device-pair',ok:false,error:message,...(deviceId?{deviceId}:{})});
    if(!this.#claimPairingInvite)return fail('pairing unavailable');
    const code=typeof raw.payload?.code==='string'?raw.payload.code.trim().toUpperCase():'';const name=typeof raw.payload?.name==='string'?raw.payload.name:'';
    const claimed=code?await this.#claimPairingInvite(code,name).catch(()=>undefined):undefined;if(!claimed)return fail('invalid or expired pairing code');
    this.#send({version:PROTOCOL_VERSION,seq:0,hostId:this.#hostId,ts:Date.now(),type:'device.paired',payload:{deviceId:claimed.deviceId},...(deviceId?{deviceId}:{})});
    this.#send({version:PROTOCOL_VERSION,replyTo:'device-pair',ok:true,result:{deviceId:claimed.deviceId,secret:claimed.secret,scopes:[...claimed.scopes]},...(deviceId?{deviceId}:{})});
  }
  async #hello(raw,deviceId){
    const secret=String(raw.payload?.secret??'');if(!this.#authenticateDevice||!deviceId||!secret){this.#clearDevice(deviceId);return this.#rejectDevice(deviceId,'authentication unavailable');}
    const device=await this.#authenticateDevice(deviceId,secret).catch(()=>undefined);if(!device){this.#clearDevice(deviceId);return this.#rejectDevice(deviceId,'unknown device credentials');}
    this.#clearDevice(deviceId);
    const expiresAt=Number.isFinite(device.expiresAt)?device.expiresAt:undefined;
    this.#devices.set(deviceId,{scopes:[...device.scopes],name:device.name??'device',...(expiresAt!==undefined?{expiresAt}:{}),...(typeof device.reauthorize==='function'?{reauthorize:device.reauthorize}:{})});
    this.#scheduleExpiry(deviceId,expiresAt);this.#notifyDeviceChange();
    this.#send({version:PROTOCOL_VERSION,seq:0,hostId:this.#hostId,ts:Date.now(),type:'client.accept',payload:{},deviceId});
    this.#send({version:PROTOCOL_VERSION,replyTo:'device-hello',ok:true,result:{deviceId,name:device.name??'',scopes:[...device.scopes]},deviceId});
  }
  #rejectDevice(deviceId,message){if(deviceId)this.#rejectSession(deviceId,message);this.#send({version:PROTOCOL_VERSION,replyTo:'device-hello',ok:false,error:message,...(deviceId?{deviceId}:{})});}
  #rejectSession(deviceId,message){if(deviceId)this.#send({version:PROTOCOL_VERSION,seq:0,hostId:this.#hostId,ts:Date.now(),type:'client.reject',payload:{reason:String(message).slice(0,240)},deviceId});}
  #scheduleExpiry(deviceId,expiresAt){
    const previous=this.#timers.get(deviceId);if(previous)clearTimeout(previous);this.#timers.delete(deviceId);
    if(expiresAt===undefined||!Number.isFinite(expiresAt))return;
    const timer=setTimeout(()=>{const current=this.#devices.get(deviceId);if(!current||current.expiresAt!==expiresAt)return;this.#clearDevice(deviceId);this.#rejectSession(deviceId,'remote credential expired');},Math.max(0,expiresAt*1000-Date.now()));timer.unref?.();this.#timers.set(deviceId,timer);
  }
  #clearDevice(deviceId){const existed=this.#devices.has(deviceId);const timer=this.#timers.get(deviceId);if(timer)clearTimeout(timer);this.#timers.delete(deviceId);this.#devices.delete(deviceId);this.#commands.detachDevice?.(deviceId);if(existed)this.#notifyDeviceChange();}
  #clearDevices(){for(const id of [...this.#devices.keys()])this.#clearDevice(id);for(const timer of this.#timers.values())clearTimeout(timer);this.#timers.clear();}
  #notifyDeviceChange(){try{this.#onDeviceChange?.(this.activeDevices);}catch{}}
  #remember(id,response){this.#seen.set(id,response);if(this.#seen.size>DEDUPE_CAPACITY)this.#seen.delete(this.#seen.keys().next().value);}
  #errorFrame(replyTo,message,deviceId,code){return{version:PROTOCOL_VERSION,replyTo,ok:false,error:String(message).slice(0,1000),...(code?{code}:{}),...(deviceId?{deviceId}:{})};}
  #resultError(replyTo,message,deviceId,code){this.#send(this.#errorFrame(replyTo,message,deviceId,code));}
}
function errorCode(error){const code=typeof error?.code==='string'?error.code.trim().slice(0,120):'';return code||undefined;}
function cleanError(error){return (error instanceof Error?error.message:String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [redacted]').slice(0,1000);}