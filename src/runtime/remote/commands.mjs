import { basename } from 'node:path';
import { PROTOCOL_VERSION } from './protocol.mjs';
import {
  normalizeProviderConfiguration,
  providerProjection,
  providerRequest,
  resolveAdvertisedSelection,
} from '../provider-policy.mjs';
import { modelMatchesProvider } from '../provider-catalog.mjs';
import { buildRuntimeDoctor, buildRuntimeStatus } from '../diagnostics.mjs';
import { executeCommand, parseSlashCommand } from '../commands.mjs';

export class RemoteCommandAdapter {
  #call; #identity; #provider=normalizeProviderConfiguration({}); #states=new Map();
  constructor({ call, identity, providerConfig={} }) { this.#call=call; this.#identity=identity; this.setProviderConfig(providerConfig); }
  setProviderConfig(config={}) { this.#provider=normalizeProviderConfiguration(config); }
  detachDevice(deviceId){ this.#states.delete(deviceId); }

  async execute(actor,type,payload={},envelope={}) {
    const state=this.#state(actor.deviceID);
    const params=record(payload);
    const explicitSession=stringOr(envelope.sessionId) ?? stringOr(params.sessionID) ?? stringOr(params.sessionId);
    switch(type){
      case 'host.get': return this.#hostGet(state);
      case 'status': return buildRuntimeStatus({ call:(method,value)=>this.#call(method,value), providerConfig:this.#provider, version:'0.9.0-alpha.1' });
      case 'doctor': return buildRuntimeDoctor({ call:(method,value)=>this.#call(method,value), providerConfig:this.#provider, version:'0.9.0-alpha.1' });
      case 'workspace.list': return this.#workspaceList(state);
      case 'workspace.attach': return this.#workspaceAttach(state,params.workspaceId ?? params.projectId);
      case 'session.list': return this.#call('session.list',state.projectId?{projectId:state.projectId}:{});
      case 'session.snapshot': return this.#sessionSnapshot(state,explicitSession);
      case 'session.messages': return this.#sessionMessages(state,explicitSession);
      case 'session.new': return this.#sessionNew(state,params);
      case 'session.resume': return this.#sessionResume(state,explicitSession);
      case 'session.submit': return this.#sessionSubmit(actor,state,explicitSession,params);
      case 'session.steer': return this.#sessionSteer(state,explicitSession,params);
      case 'session.abort': return this.#call('session.stop',{sessionId:this.#requireSession(state,explicitSession)});
      case 'session.compact': return this.#call('context.compact',{sessionId:this.#requireSession(state,explicitSession),provider:this.#selectedProvider(state)});
      case 'session.undo': return this.#call('session.undo',{sessionId:this.#requireSession(state,explicitSession)});
      case 'permission.list': return this.#call('permission.list',{...(explicitSession?{sessionId:explicitSession}:{})});
      case 'permission.reply': return this.#permissionReply(params);
      case 'question.list': return this.#call('question.list',{...(explicitSession?{sessionId:explicitSession}:{})});
      case 'question.reply': return this.#questionReply(params);
      case 'question.reject': return this.#questionReject(params);
      case 'model.list': return this.#modelList(state);
      case 'model.select': return this.#modelSelect(state,params);
      case 'provider.list': return this.#providerList(state);
      case 'provider.select': return this.#providerSelect(state,params);
      case 'agent.mode.get': return this.#modeGet(state,explicitSession);
      case 'agent.mode.set':
      case 'plan.set': return this.#modeSet(state,explicitSession,params);
      default: throw new Error(`unsupported remote command: ${type}`);
    }
  }

  async #hostGet(state){
    const workspaces=await this.#workspaceList(state);
    return { hostId:this.#identity.hostId,name:this.#identity.deviceName,platform:process.platform,version:'0.9.0-alpha.1',protocolVersion:PROTOCOL_VERSION,online:true,connectedAt:Date.now(),workspace:workspaces.find((item)=>item.workspaceId===state.projectId)??null,provider:this.#providerStatus(state) };
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
  async #sessionSubmit(actor,state,explicit,params){
    const sessionId=this.#requireSession(state,explicit); const prompt=String(params.prompt??params.text??'').trim(); if(!prompt)throw new Error('prompt is required');
    const parsed=parseSlashCommand(prompt);
    if(parsed.kind==='unknown')throw new Error(`Unknown Cuppet command: /${parsed.name}`);
    if(parsed.kind==='command'){
      const required=parsed.definition?.scope;
      if(required&&!actor.scopes?.includes?.(required))throw new Error(`missing scope '${required}' for /${parsed.name}`);
      return executeCommand(parsed,{
        sessionId,
        call:(method,value={})=>this.#call(method,value),
        providerRequest:()=>this.#selectedProvider(state),
        host:{
          status:()=>buildRuntimeStatus({call:(method,value)=>this.#call(method,value),providerConfig:this.#provider,version:'0.9.0-alpha.1'}),
          doctor:()=>buildRuntimeDoctor({call:(method,value)=>this.#call(method,value),providerConfig:this.#provider,version:'0.9.0-alpha.1'}),
        },
        provider:this.#slashProviderAuthority(state),
      });
    }
    if(params.delivery==='steer')return this.#sessionSteer(state,sessionId,{instruction:prompt});
    const result=await this.#call('session.send',{sessionId,text:prompt,attachments:boundedAttachments(params.attachments),provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return result;
  }
  async #sessionSteer(state,explicit,params){
    const sessionId=this.#requireSession(state,explicit); const instruction=String(params.instruction??params.prompt??'').trim(); if(!instruction)throw new Error('instruction is required');
    const result=await this.#call('session.steer',{sessionId,text:instruction,provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return {...result,steered:true};
  }
  async #permissionReply(params){
    const request=record(params.request); const requestId=stringOr(params.requestId)??stringOr(params.requestID)??stringOr(request.id); const reply=String(params.reply??'reject');
    if(!requestId)throw new Error('permission request id is required'); if(!['once','always','reject'].includes(reply))throw new Error('permission reply must be once, always, or reject');
    return this.#call('permission.reply',{requestId,reply});
  }
  async #questionReply(params){
    const request=record(params.request);const requestId=stringOr(params.requestId)??stringOr(params.requestID)??stringOr(request.id);if(!requestId)throw new Error('question request id is required');
    const answers=boundedAnswers(params.answers);return this.#call('question.reply',{requestId,answers});
  }
  async #questionReject(params){
    const request=record(params.request);const requestId=stringOr(params.requestId)??stringOr(params.requestID)??stringOr(request.id);if(!requestId)throw new Error('question request id is required');
    return this.#call('question.reject',{requestId});
  }

  #modelList(state){
    const projection=providerProjection(this.#provider);
    const selected=state.selection??this.#defaultSelection(state);
    return projection.models.filter((model)=>this.#modelVisibleForProvider(state,model)).map((model)=>({
      providerID:model.providerID,
      modelID:model.modelID,
      name:model.name,
      roles:model.roles,
      variants:[...model.variants],
      selected:Boolean(selected&&sameSelection(selected,model)),
      selectedVariant:selected&&sameSelection(selected,model)?selected.variant??null:null,
    }));
  }
  #modelSelect(state,params){
    const requestedProvider=String(params.providerID??state.providerID??this.#provider.primary?.providerID??'');
    const modelID=String(params.modelID??'');
    if(!requestedProvider||!modelID)throw new Error('providerID and modelID are required');
    const requested={providerID:requestedProvider,modelID,...(typeof params.variant==='string'&&params.variant.trim()?{variant:params.variant.trim()}:{})};
    let selected;
    try{selected=resolveAdvertisedSelection(this.#provider,requested);}catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(/not configured on this host/.test(message))throw new Error('model is not configured on this host');
      throw error;
    }
    if(state.providerID&&!this.#selectionMatchesProvider(state.providerID,selected))throw new Error('model is not available for the selected provider');
    state.selection=selected;
    return {...selected};
  }

  #providerList(state){
    const projection=providerProjection(this.#provider);
    return projection.catalog.map((provider)=>({
      id:provider.id,
      name:provider.id==='openai-compatible'?'OpenAI-compatible':provider.label,
      connected:projection.configured&&provider.modelCount>0,
      selected:(state.providerID??projection.catalog.find((item)=>this.#selectionMatchesProvider(item.id,projection.primary))?.id??null)===provider.id,
    }));
  }
  #providerSelect(state,params){
    const requested=String(params.providerID??params.id??'');
    const projection=providerProjection(this.#provider);
    const provider=projection.catalog.find((item)=>item.id===requested||item.integrationIds.includes(requested));
    if(!provider)throw new Error('unknown provider');
    if(!projection.models.some((model)=>modelMatchesProvider(model,provider)))throw new Error('provider has no configured coding model');
    state.providerID=provider.id;
    if(state.selection&&!modelMatchesProvider(state.selection,provider))state.selection=null;
    return {id:provider.id,selected:true};
  }
  async #modeGet(state,explicit){const sessionId=this.#requireSession(state,explicit);const result=await this.#call('session.mode.get',{sessionId});return{mode:result.mode};}
  async #modeSet(state,explicit,params){const sessionId=this.#requireSession(state,explicit);const raw=String(params.agent??params.mode??'');if(!['plan','build'].includes(raw))throw new Error('agent/mode must be plan or build');return this.#call('session.mode.set',{sessionId,mode:raw});}

  #slashProviderAuthority(state){
    return {
      models:async()=>({models:this.#modelList(state),provider:this.#providerStatus(state)}),
      providers:async()=>({catalog:this.#providerList(state),provider:this.#providerStatus(state)}),
      selectProvider:async(providerID)=>this.#providerSelect(state,{providerID}),
      effort:async()=>{
        const selected=state.selection??this.#defaultSelection(state);
        const model=this.#modelList(state).find((item)=>selected&&sameSelection(selected,item));
        return {providerID:selected?.providerID??null,modelID:selected?.modelID??null,variant:selected?.variant??null,variants:model?.variants??[]};
      },
      setEffort:async(variant)=>{
        const selected=state.selection??this.#defaultSelection(state);if(!selected)throw new Error('no model is selected');
        return this.#modelSelect(state,{providerID:selected.providerID,modelID:selected.modelID,variant:String(variant??'')});
      },
    };
  }
  #selectedProvider(state){
    const projection=providerProjection(this.#provider);
    if(!projection.configured)throw new Error('Host provider is not configured');
    const selected=state.selection??this.#defaultSelection(state);
    if(!selected)throw new Error('Host provider is not configured');
    return providerRequest(this.#provider,selected);
  }
  #defaultSelection(state){
    if(!state.providerID)return this.#provider.primary?{...this.#provider.primary}:null;
    const projection=providerProjection(this.#provider);
    const provider=projection.catalog.find((item)=>item.id===state.providerID);
    if(!provider)return null;
    if(this.#provider.primary&&modelMatchesProvider(this.#provider.primary,provider))return{...this.#provider.primary};
    const model=projection.models.find((item)=>modelMatchesProvider(item,provider));
    return model?{providerID:model.providerID,modelID:model.modelID}:null;
  }
  #modelVisibleForProvider(state,model){
    if(!state.providerID)return true;
    const provider=providerProjection(this.#provider).catalog.find((item)=>item.id===state.providerID);
    return provider?modelMatchesProvider(model,provider):false;
  }
  #selectionMatchesProvider(providerID,selection){
    if(!selection)return false;
    const provider=providerProjection(this.#provider).catalog.find((item)=>item.id===providerID||item.integrationIds.includes(providerID));
    return Boolean(provider&&modelMatchesProvider(selection,provider));
  }
  #providerStatus(state){
    const projection=providerProjection(this.#provider);
    const selected=state.selection??this.#defaultSelection(state);
    const provider=projection.catalog.find((item)=>selected&&modelMatchesProvider(selected,item));
    return {configured:projection.configured,ready:projection.configured,selectedProvider:provider?.id??null,selectedModel:selected?.modelID??null,selectedVariant:selected?.variant??null};
  }
  #requireSession(state,explicit){const id=explicit??state.sessionId;if(!id)throw new Error('no remote session is attached');state.sessionId=id;return id;}
  #state(deviceId){const key=String(deviceId??'unknown');let state=this.#states.get(key);if(!state){state={projectId:null,sessionId:null,providerID:null,selection:null};this.#states.set(key,state);}return state;}
}

function sameSelection(left,right){return String(left?.providerID??'').toLowerCase()===String(right?.providerID??'').toLowerCase()&&String(left?.modelID??'')===String(right?.modelID??'');}
function displayPath(path,name){if(typeof path!=='string'||!path)return name??'Project';return `…/${basename(path)}`;}
function record(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function stringOr(value){return typeof value==='string'&&value?value:undefined;}
function boundedAttachments(values){return Array.isArray(values)?values.slice(0,16).flatMap((item)=>record(item).path||record(item).name?[{...(stringOr(record(item).name)?{name:String(record(item).name).slice(0,240)}:{}),...(stringOr(record(item).path)?{path:String(record(item).path).slice(0,512)}:{}),...(stringOr(record(item).mime)?{mime:String(record(item).mime).slice(0,128)}:{}),...(Number.isFinite(record(item).size)?{size:Math.max(0,Math.trunc(record(item).size))}:{})}]:[]):[];}
function boundedAnswers(values){return Array.isArray(values)?values.slice(0,8).map((group)=>Array.isArray(group)?group.slice(0,12).flatMap((value)=>typeof value==='string'&&value.trim()?[value.trim().slice(0,512)]:[]):[]):[];}
async function waitUntilIdle(call,sessionId){for(let i=0;i<100;i++){const session=await call('session.get',{sessionId});const last=[...(session.messages??[])].reverse().find((message)=>message.role==='assistant');if(!last||last.status!=='streaming')return;await new Promise((resolve)=>setTimeout(resolve,10));}throw new Error('session did not stop before steer');}
