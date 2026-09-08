import { randomBytes } from 'node:crypto';

const RECONNECT_BASE_MS=1000;
const RECONNECT_MAX_MS=30000;
const HEARTBEAT_MS=20000;
const OFFLINE_BUFFER_LIMIT=256;
export const CLOSE_HOST_OFFLINE=4001;

export class WebSocketTransport {
  #url; #socket; #heartbeat; #reconnectTimer; #closed=false; #started=false; #connected=false; #lastClose; #buffered=[]; #messages=new Set(); #statuses=new Set();
  constructor(url,{WebSocketImpl=globalThis.WebSocket}={}) { if (typeof WebSocketImpl!=='function') throw new Error('WebSocket is unavailable'); this.#url=url; this.WebSocketImpl=WebSocketImpl; }
  get connected(){ return this.#connected; }
  onMessage(listener){ this.#messages.add(listener); return ()=>this.#messages.delete(listener); }
  onStatusChange(listener){ this.#statuses.add(listener); return ()=>this.#statuses.delete(listener); }
  start(){ if(this.#started||this.#closed)return; this.#started=true; this.#dial(); }
  async waitUntilConnected(timeoutMs=12000){
    if(this.#connected)return; this.start();
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{ off(); const detail=this.#lastClose?.reason || (this.#lastClose?.code?`relay closed with code ${this.#lastClose.code}`:'relay did not answer'); reject(new Error(`Remote relay connection failed: ${detail}.`)); },timeoutMs);
      const off=this.onStatusChange((connected)=>{ if(!connected)return; clearTimeout(timeout); off(); resolve(); });
    });
  }
  send(data){
    if(this.#socket&&this.#connected&&this.#socket.readyState===this.WebSocketImpl.OPEN){ this.#socket.send(data); return; }
    this.#buffered.push(data); if(this.#buffered.length>OFFLINE_BUFFER_LIMIT)this.#buffered.shift();
  }
  close(){ this.#closed=true; if(this.#heartbeat)clearInterval(this.#heartbeat); if(this.#reconnectTimer)clearTimeout(this.#reconnectTimer); try{this.#socket?.close();}catch{} this.#setStatus(false); }
  #setStatus(value){ if(this.#connected===value)return; this.#connected=value; for(const listener of this.#statuses)listener(value); }
  #flush(){ const frames=this.#buffered.splice(0); for(const frame of frames){ if(this.#socket?.readyState===this.WebSocketImpl.OPEN)this.#socket.send(frame); else this.#buffered.push(frame); } }
  #dial(attempt=0){
    if(this.#closed)return; let socket;
    try{ socket=new this.WebSocketImpl(this.#url); }catch{ this.#schedule(attempt); return; }
    socket.addEventListener('open',()=>{ this.#socket=socket; this.#lastClose=undefined; this.#setStatus(true); if(this.#heartbeat)clearInterval(this.#heartbeat); this.#heartbeat=setInterval(()=>{ try{ if(socket.readyState===this.WebSocketImpl.OPEN)socket.send(JSON.stringify({v:1,type:'ping'})); }catch{} },HEARTBEAT_MS); this.#heartbeat.unref?.(); this.#flush(); });
    socket.addEventListener('message',(event)=>{ const data=typeof event.data==='string'?event.data:String(event.data??''); for(const listener of this.#messages)listener(data); });
    socket.addEventListener('close',(event)=>{ if(this.#heartbeat)clearInterval(this.#heartbeat); this.#heartbeat=undefined; this.#lastClose={code:event.code,reason:event.reason}; this.#setStatus(false); this.#schedule(attempt+1); });
    socket.addEventListener('error',()=>{ try{socket.close();}catch{} });
  }
  #schedule(attempt){ if(this.#closed)return; const backoff=Math.min(RECONNECT_MAX_MS,RECONNECT_BASE_MS*2**Math.min(attempt,5)); const jitter=randomBytes(2).readUInt16BE(0)/65535; this.#reconnectTimer=setTimeout(()=>this.#dial(attempt+1),backoff*(0.7+0.3*jitter)); this.#reconnectTimer.unref?.(); }
}
