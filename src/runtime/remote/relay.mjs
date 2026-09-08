import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';

export const DEFAULT_RELAY_BIND='127.0.0.1';
export const DEFAULT_RELAY_PORT=8787;
export const MAX_RELAY_FRAME_BYTES=512*1024;
const REPLAY_LIMIT=200;
const RATE_WINDOW_MS=10_000;
const RATE_LIMIT=240;
const PAIR_ATTEMPT_LIMIT=3;
const HOST_ID_PATTERN=/^[\w.-]{1,128}$/;

export class CuppetRelay {
  #http; #rooms=new Map(); #options; #authWrite=Promise.resolve();
  constructor(options={}){this.#options=options;this.#http=createServer((request,response)=>void this.#handleHttp(request,response));this.#http.on('upgrade',(request,socket)=>void this.#handleUpgrade(request,socket));}
  get port(){const address=this.#http.address();return typeof address==='object'&&address?address.port:(this.#options.port??0);}
  listen(port=0,bind){return new Promise((resolvePromise,reject)=>{const onError=(error)=>{this.#http.off('listening',onListen);reject(error);};const onListen=()=>{this.#http.off('error',onError);resolvePromise();};this.#http.once('error',onError);this.#http.once('listening',onListen);this.#http.listen(port,resolveRelayBind(bind??this.#options.bind));});}
  close(){this.#http.close();for(const room of this.#rooms.values()){room.host?.destroy();for(const device of room.devices.values())device.socket.destroy();}this.#rooms.clear();}

  async #handleHttp(request,response){
    const url=new URL(request.url??'/','http://localhost');
    if(url.pathname==='/healthz'){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,rooms:this.#rooms.size}));return;}
    const manage=(request.method==='POST'&&url.pathname==='/hosts')||(request.method==='DELETE'&&url.pathname.startsWith('/hosts/'));
    if(manage){
      if(!this.#authorizeAdmin(request)){response.writeHead(401,{'content-type':'text/plain'}).end('unauthorized\n');return;}
      if(request.method==='POST'){
        let body='';request.on('data',(chunk)=>{body+=chunk;if(body.length>16384)request.destroy();});request.on('end',()=>void this.#upsertHost(body).then((ok)=>response.writeHead(ok?200:400).end(ok?'ok\n':'bad request\n')));return;
      }
      const hostId=decodeURIComponent(url.pathname.slice('/hosts/'.length));response.writeHead(200).end(`${await this.#removeHost(hostId)?'removed':'unknown'}\n`);return;
    }
    if(!this.#options.appDirectory||!url.pathname.startsWith('/app')){response.writeHead(404,{'content-type':'text/plain'}).end('cuppet relay\n');return;}
    const relativePath=url.pathname==='/app'?'index.html':url.pathname.slice('/app/'.length);
    const root=resolve(this.#options.appDirectory);const target=resolve(root,relativePath);
    if(relative(root,target).startsWith('..')){response.writeHead(404).end('not found');return;}
    try{const body=await readFile(target);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};response.writeHead(200,{'content-type':types[extname(target)]??'application/octet-stream','cache-control':'no-store'}).end(body);}catch{response.writeHead(404).end('not found');}
  }
  #authorizeAdmin(request){if(!this.#options.adminToken)return false;const provided=Buffer.from(String(request.headers.authorization??'').replace(/^Bearer\s+/i,''));const expected=Buffer.from(this.#options.adminToken);return provided.length===expected.length&&timingSafeEqual(provided,expected);}
  async #loadHosts(){if(!this.#options.authFile)return undefined;try{const parsed=JSON.parse(await readFile(this.#options.authFile,'utf8'));return parsed.hosts??{};}catch{return {};}}
  async #withHosts(operation){let release=()=>{};const previous=this.#authWrite;this.#authWrite=new Promise((resolvePromise)=>{release=resolvePromise;});await previous;try{return await operation((await this.#loadHosts())??{});}finally{release();}}
  async #writeHosts(hosts){if(!this.#options.authFile)throw new Error('relay auth file is not configured');await mkdir(dirname(this.#options.authFile),{recursive:true,mode:0o700});const temp=`${this.#options.authFile}.${randomBytes(12).toString('hex')}.tmp`;await writeFile(temp,`${JSON.stringify({hosts},null,2)}\n`,{mode:0o600});await rename(temp,this.#options.authFile);}
  async #upsertHost(body){if(!this.#options.authFile)return false;try{const parsed=JSON.parse(body);if(typeof parsed.hostId!=='string'||!isValidRelayHostId(parsed.hostId)||typeof parsed.secret!=='string'||parsed.secret.length<16)return false;await this.#withHosts(async(hosts)=>{hosts[parsed.hostId]=sha256(parsed.secret);await this.#writeHosts(hosts);});return true;}catch{return false;}}
  async #removeHost(hostId){if(!this.#options.authFile||!isValidRelayHostId(hostId))return false;return this.#withHosts(async(hosts)=>{if(!(hostId in hosts))return false;delete hosts[hostId];await this.#writeHosts(hosts);return true;}).catch(()=>false);}

  async #handleUpgrade(request,rawSocket){
    const socket=rawSocket;const url=new URL(request.url??'/','http://localhost');if(url.pathname!=='/ws'){socket.destroy();return;}
    const role=url.searchParams.get('role');const hostId=url.searchParams.get('hostId')??'';if(!isValidRelayHostId(hostId)){socket.destroy();return;}
    const origins=this.#options.allowedOrigins??[];if(origins.length&&request.headers.origin&&!origins.includes(request.headers.origin)){socket.destroy();return;}
    const key=request.headers['sec-websocket-key'];if(typeof key!=='string'){socket.destroy();return;}
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+`Sec-WebSocket-Accept: ${createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);socket.setNoDelay(true);
    const overBudget=createSlidingWindowRateLimiter();let deviceId;let room;let registration;
    if(role==='host'){
      const expected=await this.#loadHosts();if(expected!==undefined){const stored=expected[hostId];const provided=Buffer.from(sha256(url.searchParams.get('secret')??''));const storedBuffer=Buffer.from(typeof stored==='string'?stored:'');if(!stored||provided.length!==storedBuffer.length||!timingSafeEqual(provided,storedBuffer)){closeSocket(socket,4002,'host unauthorized');return;}}
      room=this.#room(hostId);registration=wrapSocket(socket);room.host?.destroy();for(const device of room.devices.values())device.socket.destroy();room.devices.clear();room.replay.length=0;room.host=registration;
    }else if(role==='device'){
      room=this.#rooms.get(hostId);deviceId=url.searchParams.get('deviceId')??'';const max=this.#options.maxDevicesPerRoom??8;if(!room?.host){closeSocket(socket,4001,'host offline');return;}if(!deviceId||deviceId.length>128||(!room.devices.has(deviceId)&&room.devices.size>=max)){closeSocket(socket,4003,'invalid device');return;}
      registration={socket:wrapSocket(socket),authenticated:false,pairingAttempts:0};room.devices.get(deviceId)?.socket.destroy();room.devices.set(deviceId,registration);
    }else{socket.destroy();return;}
    let buffered=Buffer.alloc(0);
    socket.on('data',(chunk)=>{buffered=Buffer.concat([buffered,chunk]);for(;;){let decoded;try{decoded=decodeFrame(buffered);}catch{socket.destroy();return;}if(!decoded)break;buffered=buffered.subarray(decoded.consumed);if(overBudget()){socket.destroy();return;}if(decoded.opcode===0x8){socket.destroy();return;}if(decoded.opcode===0x9){writeFrame(socket,0xa,decoded.payload);continue;}if(decoded.opcode!==0x1)continue;let parsed;try{parsed=JSON.parse(decoded.payload.toString('utf8'));}catch{continue;}this.#dispatch(role,hostId,deviceId??'',parsed,registration);}});
    socket.on('error',()=>socket.destroy());socket.on('close',()=>{if(role==='host'){if(room&&room.host===registration){for(const device of room.devices.values())device.socket.destroy();room.devices.clear();room.host=undefined;this.#prune(hostId,room);}return;}if(room&&deviceId&&room.devices.get(deviceId)===registration){room.devices.delete(deviceId);this.#prune(hostId,room);}});
  }
  #dispatch(role,hostId,deviceId,message,registration){
    const room=this.#rooms.get(hostId);if(!room)return;const type=String(message.type??'');
    if(role==='device'){
      const device=room.devices.get(deviceId);if(!room.host||!device||device!==registration||type==='ping')return;
      if(!device.authenticated&&type==='device.pair'){device.pairingAttempts++;if(device.pairingAttempts>PAIR_ATTEMPT_LIMIT){device.socket.send(JSON.stringify({version:1,replyTo:'device-pair',ok:false,error:'too many pairing attempts',deviceId}));device.socket.destroy();room.devices.delete(deviceId);this.#prune(hostId,room);return;}}
      if(!device.authenticated&&!['device.pair','device.hello'].includes(type))return;room.host.send(JSON.stringify({...message,deviceId}));return;
    }
    if(room.host!==registration)return;
    if(type==='client.accept'||type==='client.reject'){
      const target=String(message.deviceId??'');const device=room.devices.get(target);if(!device)return;
      if(type==='client.reject'){device.authenticated=false;device.socket.send(JSON.stringify(message));device.socket.close(4004,'device rejected');room.devices.delete(target);this.#prune(hostId,room);return;}
      device.authenticated=true;device.socket.send(JSON.stringify(message));for(const frame of room.replay)device.socket.send(JSON.stringify(frame));return;
    }
    if(message.replyTo!==undefined){const target=String(message.deviceId??'');const device=target?room.devices.get(target):undefined;if(device)device.socket.send(JSON.stringify(message));return;}
    if(type==='device.paired'){const target=String(message.deviceId??'');room.devices.get(target)?.socket.send(JSON.stringify(message));return;}
    for(const device of room.devices.values())if(device.authenticated)device.socket.send(JSON.stringify(message));
    if(isReplayable(type)&&typeof message.seq==='number'){room.replay.push(message);if(room.replay.length>REPLAY_LIMIT)room.replay.shift();}
  }
  #room(hostId){let room=this.#rooms.get(hostId);if(!room){room={host:undefined,devices:new Map(),replay:[]};this.#rooms.set(hostId,room);}return room;}
  #prune(hostId,room){if(!room.host&&room.devices.size===0&&this.#rooms.get(hostId)===room)this.#rooms.delete(hostId);}
}

export function isValidRelayHostId(value){return HOST_ID_PATTERN.test(String(value??''));}
export function resolveRelayBind(bind){return String(bind??'').trim()||DEFAULT_RELAY_BIND;}
export function createSlidingWindowRateLimiter(limit=RATE_LIMIT,windowMs=RATE_WINDOW_MS,now=Date.now){let start=now();let count=0;return()=>{const current=now();if(current-start>=windowMs){start=current;count=0;}count++;return count>limit;};}
export function generateSecret(){return randomBytes(32).toString('base64url');}
export async function ensureRelayAuthFile(path){try{await readFile(path);return false;}catch{}await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,`${JSON.stringify({hosts:{}},null,2)}\n`,{mode:0o600});return true;}
export async function runRelayServer({port=DEFAULT_RELAY_PORT,bind=DEFAULT_RELAY_BIND,authFile,adminToken,origins=[],appDirectory,signal}={}){if(authFile)await ensureRelayAuthFile(authFile);const relay=new CuppetRelay({port,bind,authFile,adminToken,allowedOrigins:origins,appDirectory});await relay.listen(port,bind);if(signal){if(signal.aborted){relay.close();return relay;}signal.addEventListener('abort',()=>relay.close(),{once:true});}return relay;}

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function isReplayable(type){return !['client.accept','client.reject','device.paired'].includes(type);}
function wrapSocket(socket){return{send(data){writeFrame(socket,0x1,Buffer.from(data,'utf8'));},close(code,reason){closeSocket(socket,code,reason);},destroy(){socket.destroy();}};}
function closeSocket(socket,code,reason){const bytes=Buffer.from(String(reason).slice(0,100),'utf8');const payload=Buffer.alloc(2+bytes.length);payload.writeUInt16BE(code,0);bytes.copy(payload,2);try{writeFrame(socket,0x8,payload);socket.end();}catch{socket.destroy();}}
function writeFrame(socket,opcode,payload){const length=payload.length;let header;if(length<126){header=Buffer.from([0x80|opcode,length]);}else if(length<65536){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(length,2);}else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(length),2);}socket.write(Buffer.concat([header,payload]));}
function decodeFrame(buffer){if(buffer.length<2)return undefined;const first=buffer[0],second=buffer[1];const opcode=first&0x0f;const masked=(second&0x80)!==0;let length=second&0x7f;let offset=2;if(length===126){if(buffer.length<4)return undefined;length=buffer.readUInt16BE(2);offset=4;}else if(length===127){if(buffer.length<10)return undefined;const big=buffer.readBigUInt64BE(2);if(big>BigInt(MAX_RELAY_FRAME_BYTES))throw new Error('frame too large');length=Number(big);offset=10;}if(length>MAX_RELAY_FRAME_BYTES)throw new Error('frame too large');const maskLength=masked?4:0;if(buffer.length<offset+maskLength+length)return undefined;let payload=buffer.subarray(offset+maskLength,offset+maskLength+length);if(masked){const mask=buffer.subarray(offset,offset+4);const out=Buffer.alloc(length);for(let i=0;i<length;i++)out[i]=payload[i]^mask[i%4];payload=out;}return{opcode,payload,consumed:offset+maskLength+length};}
