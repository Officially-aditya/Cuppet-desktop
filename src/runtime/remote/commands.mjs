import { basename } from 'node:path';
import { PROTOCOL_VERSION } from './protocol.mjs';

export class RemoteCommandAdapter {
  #call; #identity; #provider={}; #states=new Map();
  constructor({ call, identity, providerConfig={} }) { this.#call=call; this.#identity=identity; this.setProviderConfig(providerConfig); }
  setProviderConfig(config={}) { this.#provider=sanitizeProviderConfig(config); }
  detachDevice(deviceId){ this.#states.delete(deviceId); }

  async execute(actor,type,payload={},envelope={}) {
    const state=this.#state(actor.deviceID);
    const params=record(payload);
    const explicitSession=stringOr(envelope.sessionId) ?? stringOr(params.sessionID) ?? stringOr(params.sessionId);
    switch(type){
      case 'host.get': return this.#hostGet(state);
      case 'workspace.list': return this.#workspaceList(state);
      case 'workspace.attach': return this.#workspaceAttach(state,params.workspaceId ?? params.projectId);
      case 'session.list': return this.#call('session.list',state.projectId?{projectId:state.projectId}:{});
      case 'session.snapshot': return this.#sessionSnapshot(state,explicitSession);
      case 'session.messages': return this.#sessionMessages(state,explicitSession);
      case 'session.new': return this.#sessionNew(state,params);
      case 'session.resume': return this.#sessionResume(state,explicitSession);
      case 'session.submit': return this.#sessionSubmit(state,explicitSession,params);
      case 'session.steer': return this.#sessionSteer(state,explicitSession,params);
      case 'session.abort': return this.#call('session.stop',{sessionId:this.#requireSession(state,explicitSession)});
      case 'session.compact': return this.#call('context.compact',{sessionId:this.#requireSession(state,explicitSession),provider:this.#selectedProvider(state)});
      case 'session.undo': throw new Error('Undo is unavailable until the independent runtime has an authoritative mutation journal.');
      case 'permission.list': return this.#call('permission.list',{...(explicitSession?{sessionId:explicitSession}:{})});
      case 'permission.reply': return this.#permissionReply(params);
      case 'question.list': return [];
      case 'question.reply':
      case 'question.reject': throw new Error('Interactive question requests are not implemented by the independent runtime.');
      case 'model.list': return this.#modelList(state);
      case 'model.select': return this.#modelSelect(state,params);
      case 'provider.list': return this.#providerList();
      case 'provider.select': return this.#providerSelect(params);
      case 'agent.mode.get': return this.#modeGet(state,explicitSession);
      case 'agent.mode.set':
      case 'plan.set': return this.#modeSet(state,explicitSession,params);
      default: throw new Error(`unsupported remote command: ${type}`);
    }
  }

  async #hostGet(state){
    const workspaces=await this.#workspaceList(state);
    return { hostId:this.#identity.hostId,name:this.#identity.deviceName,platform:process.platform,version:'0.6.0-alpha.1',protocolVersion:PROTOCOL_VERSION,online:true,connectedAt:Date.now(),workspace:workspaces.find((item)=>item.workspaceId===state.projectId)??null,provider:this.#providerStatus(state) };
  }
  async #workspaceList(state){
    const projects=await this.#call('project.list',{});
    const sessions=await this.#call('session.list',{});
    return projects.map((project)=>({workspaceId:project.id,name:project.name,pathDisplay:displayPath(project.canonicalPath,project.name),activeSessionId:state.projectId===project.id?state.sessionId??sessions.find((session)=>session.projectId===project.id)?.id??null:null,missing:project.missing===true}));
  }
  async #workspaceAttach(state,id){
    const projectId=String(id??''); if(!projectId)throw new Error('workspaceId is required');
    const project=await this.#call('project.get',{projectId}); if(!project)throw new Error('unknown workspace'); if(project.missing)throw new Error('workspace folder is missing');
    state.projectId=project.id; if(state.sessionId){const session=await this.#call('session.get',{sessionId:state.sessionId}).catch(()=>null);if(session?.projectId!==project.id)state.sessionId=null;}
    return {workspaceId:project.id,name:project.name,pathDisplay:displayPath(project.canonicalPath,project.name),activeSessionId:state.sessionId??null,attached:true};
  }
  async #sessionSnapshot(state,explicit){
    const sessionId=this.#requireSession(state,explicit); const session=await this.#call('session.get',{sessionId}); const mode=await this.#call('session.mode.get',{sessionId}); const auto=await this.#call('session.auto.get',{sessionId});
    return {session:{...session,messages:undefined,toolExecutions:undefined},mode:mode.mode,autoMode:auto.enabled,provider:this.#providerStatus(state)};
  }
  async #sessionMessages(state,explicit){const session=await this.#call('session.get',{sessionId:this.#requireSession(state,explicit)});return session.messages??[];}
  async #sessionNew(state,params){
    const projectId=stringOr(params.projectId)??state.projectId??null; const session=await this.#call('session.create',{projectId}); state.sessionId=session.id; state.projectId=session.projectId??projectId; return session;
  }
  async #sessionResume(state,explicit){const session=await this.#call('session.get',{sessionId:this.#requireSession(state,explicit)});state.sessionId=session.id;state.projectId=session.projectId??state.projectId;return session;}
  async #sessionSubmit(state,explicit,params){
    const sessionId=this.#requireSession(state,explicit); const prompt=String(params.prompt??params.text??'').trim(); if(!prompt)throw new Error('prompt is required');
    if(params.delivery==='steer')return this.#sessionSteer(state,sessionId,{instruction:prompt});
    const result=await this.#call('session.send',{sessionId,text:prompt,attachments:boundedAttachments(params.attachments),provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return result;
  }
  async #sessionSteer(state,explicit,params){
    const sessionId=this.#requireSession(state,explicit); const instruction=String(params.instruction??params.prompt??'').trim(); if(!instruction)throw new Error('instruction is required');
    await this.#call('session.stop',{sessionId}).catch(()=>undefined); await waitUntilIdle(this.#call,sessionId);
    const result=await this.#call('session.send',{sessionId,text:instruction,provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return {...result,steered:true};
  }
  async #permissionReply(params){
    const request=record(params.request); const requestId=stringOr(params.requestId)??stringOr(params.requestID)??stringOr(request.id); const reply=String(params.reply??'reject');
    if(!requestId)throw new Error('permission request id is required'); if(!['once','always','reject'].includes(reply))throw new Error('permission reply must be once, always, or reject');
    return this.#call('permission.reply',{requestId,reply});
  }
  #modelList(state){
    const models=[]; if(this.#provider.model)models.push({providerID:'openai-compatible',modelID:this.#provider.model,role:'primary',selected:(state.model??this.#provider.model)===this.#provider.model});
    if(this.#provider.backgroundModel&&this.#provider.backgroundModel!==this.#provider.model)models.push({providerID:'openai-compatible',modelID:this.#provider.backgroundModel,role:'secondary',selected:state.model===this.#provider.backgroundModel}); return models;
  }
  #modelSelect(state,params){
    if(String(params.providerID??'openai-compatible')!=='openai-compatible')throw new Error('unknown provider'); const modelID=String(params.modelID??''); const allowed=this.#modelList(state).map((model)=>model.modelID); if(!allowed.includes(modelID))throw new Error('model is not configured on this host'); state.model=modelID; return {providerID:'openai-compatible',modelID};
  }
  #providerList(){return [{id:'openai-compatible',name:'OpenAI-compatible',connected:Boolean(this.#provider.apiKey&&this.#provider.model),baseUrl:this.#provider.baseUrl??null}];}
  #providerSelect(params){if(String(params.providerID??params.id??'')!=='openai-compatible')throw new Error('unknown provider');return {id:'openai-compatible',selected:true};}
  async #modeGet(state,explicit){const sessionId=this.#requireSession(state,explicit);const result=await this.#call('session.mode.get',{sessionId});return {mode:result.mode};}
  async #modeSet(state,explicit,params){const sessionId=this.#requireSession(state,explicit);const raw=String(params.agent??params.mode??'');if(!['plan','build'].includes(raw))throw new Error('agent/mode must be plan or build');return this.#call('session.mode.set',{sessionId,mode:raw});}
  #selectedProvider(state){if(!this.#provider.apiKey||!this.#provider.model)throw new Error('Host provider is not configured');return {...this.#provider,model:state.model??this.#provider.model};}
  #providerStatus(state){return {configured:Boolean(this.#provider.apiKey&&this.#provider.model),ready:Boolean(this.#provider.apiKey&&this.#provider.model),selectedProvider:'openai-compatible',selectedModel:state.model??this.#provider.model??null};}
  #requireSession(state,explicit){const id=explicit??state.sessionId;if(!id)throw new Error('no remote session is attached');state.sessionId=id;return id;}
  #state(deviceId){const key=String(deviceId??'unknown');let state=this.#states.get(key);if(!state){state={projectId:null,sessionId:null,model:null};this.#states.set(key,state);}return state;}
}

function sanitizeProviderConfig(config){return {baseUrl:typeof config.baseUrl==='string'?config.baseUrl:undefined,model:typeof config.model==='string'?config.model:undefined,backgroundModel:typeof config.backgroundModel==='string'?config.backgroundModel:undefined,apiKey:typeof config.apiKey==='string'?config.apiKey:undefined,contextWindow:Number.isFinite(config.contextWindow)?config.contextWindow:undefined};}
function displayPath(path,name){if(typeof path!=='string'||!path)return name??'Project';return `…/${basename(path)}`;}
function record(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function stringOr(value){return typeof value==='string'&&value?value:undefined;}
function boundedAttachments(values){return Array.isArray(values)?values.slice(0,16).flatMap((item)=>record(item).path||record(item).name?[{...(stringOr(record(item).name)?{name:String(record(item).name).slice(0,240)}:{}),...(stringOr(record(item).path)?{path:String(record(item).path).slice(0,512)}:{}),...(stringOr(record(item).mime)?{mime:String(record(item).mime).slice(0,128)}:{}),...(Number.isFinite(record(item).size)?{size:Math.max(0,Math.trunc(record(item).size))}:{})}]:[]):[];}
async function waitUntilIdle(call,sessionId){for(let i=0;i<100;i++){const session=await call('session.get',{sessionId});const last=[...(session.messages??[])].reverse().find((message)=>message.role==='assistant');if(!last||last.status!=='streaming')return;await new Promise((resolve)=>setTimeout(resolve,10));}throw new Error('session did not stop before steer');}
