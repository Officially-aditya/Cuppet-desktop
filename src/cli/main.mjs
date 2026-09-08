#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RuntimeService } from '../runtime/service.mjs';
import { ConversationDatabase } from '../runtime/database.mjs';
import { LosslessPlanStore } from '../runtime/lossless-plan.mjs';
import { RemoteManager } from '../runtime/remote/manager.mjs';
import { ensureHostIdentity, setRemoteTokenPublicKey } from '../runtime/remote/identity.mjs';
import { registerHost } from '../runtime/remote/enroll.mjs';
import { runRelayServer, DEFAULT_RELAY_BIND, DEFAULT_RELAY_PORT } from '../runtime/remote/relay.mjs';
import { normalizeProviderConfiguration, providerProjection } from '../runtime/provider-policy.mjs';
import { buildRuntimeDoctor, buildRuntimeStatus } from '../runtime/diagnostics.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_BASE='https://connect.cuppet.in';
const rawArgs=process.argv.slice(2);
const legacyPrompt=rawArgs[0]?.startsWith('-');
const command=legacyPrompt?'prompt':rawArgs[0]??'help';
const flags=parseFlags(legacyPrompt?rawArgs:rawArgs.slice(1));
try{
  if(command==='remote-control')await remoteControl(flags);
  else if(command==='relay')await relay(flags);
  else if(command==='remote-enroll')await enroll(flags);
  else if(command==='models')showModels(flags);
  else if(command==='status')await showStatus(flags);
  else if(command==='doctor')await showDoctor(flags);
  else if(command==='sessions')showSessions(flags);
  else if(command==='undo')await headlessUndo(flags);
  else if(command==='prompt')await headlessPrompt(flags);
  else{usage();if(command!=='help'&&command!=='--help'&&command!=='-h')process.exitCode=1;}
}catch(error){console.error(`Cuppet: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}

async function remoteControl(flags){
  const dataDir=dataDirectory(flags);const databasePath=join(dataDir,'conversations.sqlite3');let remote;
  const service=new RuntimeService({databasePath,dataDir,interactive:true,emit:(event)=>remote?.handleRuntimeEvent(event)});
  remote=new RemoteManager({dataDir,call:(method,params)=>service.handle(method,params),emit:(event)=>{
    if(event.type==='remote.setup')console.log(`Cuppet setup: ${event.setup.url}`);
    if(event.type==='remote.invite')console.log(`Pairing code: ${event.invite.code} (${event.invite.role}, expires ${new Date(event.invite.expiresAt).toISOString()})${event.invite.url?`\n${event.invite.url}`:''}`);
  }});
  const provider=providerFromEnv(flags);remote.setProviderConfig(provider);
  const relayUrl=String(flags['relay-url']??process.env.CUPPET_RELAY_URL??'')||undefined;const authToken=String(flags.token??process.env.CUPPET_TOKEN??'')||undefined;const apiBase=String(flags['api-base']??process.env.CUPPET_API_BASE??DEFAULT_API_BASE);
  const result=await remote.start({relayUrl,authToken,apiBase,setup:!authToken&&!relayUrl,provider,createInvite:flags['no-invite']!==true});
  console.log(`Remote host ${result.status.hostId} ${result.status.connected?'connected':'started'}${result.status.relayUrl?` via ${result.status.relayUrl}`:''}`);
  await waitForSignal();await remote.close();await service.close();
}
async function relay(flags){
  const port=integer(flags.port,DEFAULT_RELAY_PORT);const bind=String(flags.bind??DEFAULT_RELAY_BIND);const authFile=String(flags['auth-file']??join(process.cwd(),'cuppet-relay-auth.json'));const adminToken=typeof flags['admin-token']==='string'?flags['admin-token']:undefined;const origins=listFlag(flags.origin);const appDirectory=join(here,'..','remote-app');
  const controller=new AbortController();const server=await runRelayServer({port,bind,authFile,adminToken,origins,appDirectory,signal:controller.signal});console.log(`Cuppet relay listening on ${bind}:${server.port}`);console.log(`Remote app: http://${bind}:${server.port}/app`);console.log(`Auth file: ${authFile}`);if(bind!==DEFAULT_RELAY_BIND)console.log('WARNING: terminate TLS before exposing plaintext HTTP/WS outside localhost.');await waitForSignal();controller.abort();
}
async function enroll(flags){
  const dataDir=dataDirectory(flags);const remoteDir=join(dataDir,'remote');let identity=await ensureHostIdentity(remoteDir);const token=String(flags.token??process.env.CUPPET_TOKEN??'');if(!token)throw new Error('remote-enroll requires --token or CUPPET_TOKEN');const apiBase=String(flags['api-base']??process.env.CUPPET_API_BASE??DEFAULT_API_BASE);
  const result=await registerHost({apiBase,token,identity,relaySecret:identity.relaySecret,displayName:typeof flags.name==='string'?flags.name:undefined});if(result.remoteTokenPublicKey)identity=await setRemoteTokenPublicKey(remoteDir,result.remoteTokenPublicKey);console.log(`Enrolled ${identity.deviceName} [${identity.hostId}]`);if(result.relayUrl)console.log(`Relay: ${result.relayUrl}${result.relayRegistered?' (registered)':''}`);
}
function showModels(flags){console.log(JSON.stringify(providerProjection(providerFromEnv(flags)),null,2));}
async function showStatus(flags){
  const {service,provider}=runtimeForCli(flags);
  try{console.log(JSON.stringify(await buildRuntimeStatus({call:(method,params)=>service.handle(method,params),providerConfig:provider,version:'0.8.0-alpha.1'}),null,2));}
  finally{await service.close();}
}
async function showDoctor(flags){
  const {service,provider}=runtimeForCli(flags);
  try{const result=await buildRuntimeDoctor({call:(method,params)=>service.handle(method,params),providerConfig:provider,version:'0.8.0-alpha.1'});console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
  finally{await service.close();}
}
function showSessions(flags){
  const dataDir=dataDirectory(flags);const db=new ConversationDatabase(join(dataDir,'conversations.sqlite3'));
  try{console.log(JSON.stringify(db.listSessions(),null,2));}finally{db.close();}
}
async function headlessUndo(flags){
  const dataDir=dataDirectory(flags);const databasePath=join(dataDir,'conversations.sqlite3');const sessionId=resolveExistingSession(databasePath,flags,{latestByDefault:true});
  const service=new RuntimeService({databasePath,dataDir,interactive:false});
  try{const result=await service.handle('session.undo',{sessionId});if(flags.json===true)console.log(JSON.stringify(result,null,2));else console.log(result.undone?`Undid ${result.path||'latest Cuppet mutation'} in ${sessionId}.`:(result.reason||'Nothing to undo.'));}
  finally{await service.close();}
}
async function headlessPrompt(flags){
  const prompt=String(flags.prompt??flags._?.[0]??'').trim();if(!prompt)throw new Error('prompt requires --prompt <text> or a positional message');
  const dataDir=dataDirectory(flags);const databasePath=join(dataDir,'conversations.sqlite3');
  const selected=prepareHeadlessSession({databasePath,dataDir,flags});
  if(selected.pendingPlanFork)await selected.pendingPlanFork.plans.fork(selected.sourceSessionId,selected.sessionId,selected.pendingPlanFork.messageMap);
  const provider=providerFromEnv(flags);let targetSessionId=selected.sessionId;
  const service=new RuntimeService({databasePath,dataDir,interactive:false});
  try{
    const result=await service.handle('session.send',{sessionId:selected.sessionId,text:prompt,provider});targetSessionId=result.sessionId;
    const message=await waitForTerminalAssistant(service,targetSessionId);
    if(flags.json===true)console.log(JSON.stringify({sessionId:targetSessionId,sourceSessionId:selected.sourceSessionId??null,forked:selected.forked,message},null,2));
    else if(message.content)process.stdout.write(`${message.content}\n`);
    if(message.status==='error')process.exitCode=1;
  }finally{await service.close();}
}

function prepareHeadlessSession({databasePath,dataDir,flags}){
  const db=new ConversationDatabase(databasePath);let sourceSessionId=null;let sessionId;let forked=false;
  try{
    const explicit=stringFlag(flags.session);
    const latest=(flags.continue===true||flags.fork===true)?db.listSessions()[0]?.id:null;
    sourceSessionId=explicit||latest||null;
    if(sourceSessionId&&!db.getSessionSummary(sourceSessionId))throw new Error(`unknown session: ${sourceSessionId}`);
    if(flags.fork===true){
      if(!sourceSessionId)throw new Error('--fork requires --session <id> or an existing session for --continue');
      sessionId=`session_${randomUUID()}`;
      const copied=db.forkSession({sourceSessionId,id:sessionId});
      forked=true;
      const plans=new LosslessPlanStore(join(dataDir,'lossless-plans'));
      return {sessionId,sourceSessionId,forked,pendingPlanFork:{plans,messageMap:copied.messageMap}};
    }
    if(sourceSessionId)return{sessionId:sourceSessionId,sourceSessionId,forked:false};
    sessionId=`session_${randomUUID()}`;db.createSession({id:sessionId});return{sessionId,sourceSessionId:null,forked:false};
  }finally{db.close();}
}
function resolveExistingSession(databasePath,flags,{latestByDefault=false}={}){
  const db=new ConversationDatabase(databasePath);
  try{const explicit=stringFlag(flags.session);const sessionId=explicit||((flags.continue===true||latestByDefault)?db.listSessions()[0]?.id:null);if(!sessionId)throw new Error('No existing session. Pass --session <id>.');if(!db.getSessionSummary(sessionId))throw new Error(`unknown session: ${sessionId}`);return sessionId;}finally{db.close();}
}

async function waitForTerminalAssistant(service,sessionId){
  const deadline=Date.now()+10*60_000;
  for(;;){
    const session=await service.handle('session.get',{sessionId});
    const message=[...(session.messages??[])].reverse().find((item)=>item.role==='assistant');
    if(message&&message.status!=='streaming')return message;
    if(Date.now()>=deadline)throw new Error('prompt execution timed out');
    await new Promise((resolve)=>setTimeout(resolve,25));
  }
}

function runtimeForCli(flags){const dataDir=dataDirectory(flags);const provider=providerFromEnv(flags);return{provider,service:new RuntimeService({databasePath:join(dataDir,'conversations.sqlite3'),dataDir,interactive:false})};}
function dataDirectory(flags){return String(flags['data-dir']??process.env.CUPPET_DATA_DIR??join(homedir(),'.cuppet-desktop'));}
function providerFromEnv(flags){
  const providerID=String(flags['provider-id']??process.env.CUPPET_PROVIDER_ID??'openai-compatible');
  const model=String(flags.model??process.env.CUPPET_MODEL??'');
  const backgroundModel=String(flags['background-model']??process.env.CUPPET_BACKGROUND_MODEL??'');
  const effort=String(flags.effort??process.env.CUPPET_EFFORT??'');
  const backgroundEffort=String(flags['background-effort']??process.env.CUPPET_BACKGROUND_EFFORT??'');
  const models=parseJson(flags['model-catalog']??process.env.CUPPET_MODEL_CATALOG_JSON,[],'model catalog');
  const variantBridge=parseJson(flags['variant-bridge']??process.env.CUPPET_VARIANT_BRIDGE_JSON,{schema:1,models:[]},'variant bridge');
  return normalizeProviderConfiguration({
    providerID,
    baseUrl:String(flags['base-url']??process.env.CUPPET_BASE_URL??'https://api.openai.com/v1'),
    model,
    backgroundModel,
    apiKey:String(flags['api-key']??process.env.CUPPET_API_KEY??process.env.OPENAI_API_KEY??''),
    ...(effort?{primary:{providerID,modelID:model,variant:effort}}:{}),
    ...(backgroundEffort?{secondary:{providerID,modelID:backgroundModel||model,variant:backgroundEffort}}:{}),
    ...(Array.isArray(models)?{models}:{}),
    variantBridge,
  });
}
function parseJson(value,fallback,label){if(value===undefined||value===null||value==='')return fallback;try{return JSON.parse(String(value));}catch{throw new Error(`invalid ${label} JSON`);}}
function parseFlags(values){
  const result={_:[]};for(let i=0;i<values.length;i++){const raw=values[i];
    if(raw==='-c'){result.continue=true;continue;}if(raw==='-s'){const next=values[++i];if(!next||next.startsWith('-'))throw new Error('-s requires a session id');result.session=next;continue;}if(raw==='-p'){const next=values[++i];if(!next)throw new Error('-p requires prompt text');result.prompt=next;continue;}
    if(!raw?.startsWith('--')){result._.push(raw);continue;}const [name,inline]=raw.slice(2).split('=',2);if(inline!==undefined){append(result,name,inline);continue;}const next=values[i+1];if(next&&!next.startsWith('--')){append(result,name,next);i++;}else append(result,name,true);
  }return result;
}
function append(target,key,value){if(target[key]===undefined)target[key]=value;else if(Array.isArray(target[key]))target[key].push(value);else target[key]=[target[key],value];}
function stringFlag(value){return typeof value==='string'&&value?value:null;}
function listFlag(value){if(value===undefined)return[];return(Array.isArray(value)?value:[value]).map(String).slice(0,32);}
function integer(value,fallback){const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=0&&parsed<=65535?parsed:fallback;}
function waitForSignal(){return new Promise((resolve)=>{const done=()=>{process.off('SIGINT',done);process.off('SIGTERM',done);resolve();};process.once('SIGINT',done);process.once('SIGTERM',done);});}
function usage(){console.log(`Cuppet independent CLI\n\n  cuppet prompt <text> [--session id|-s id] [--continue|-c] [--fork] [--json]\n  cuppet --prompt <text> [-s id|-c] [--fork]\n  cuppet sessions\n  cuppet undo [--session id|-s id] [--json]\n  cuppet status\n  cuppet doctor\n  cuppet models [--provider-id id] [--model id] [--effort variant]\n  cuppet remote-control [--relay-url wss://…] [--api-base ${DEFAULT_API_BASE}]\n  cuppet relay [--port 8787] [--bind 127.0.0.1] [--auth-file path]\n  cuppet remote-enroll --token <session-token> [--api-base ${DEFAULT_API_BASE}]\n\nHeadless provider env: CUPPET_PROVIDER_ID, CUPPET_API_KEY, CUPPET_MODEL, CUPPET_BACKGROUND_MODEL, CUPPET_EFFORT, CUPPET_BACKGROUND_EFFORT, CUPPET_BASE_URL.\nOptional non-secret metadata: CUPPET_MODEL_CATALOG_JSON, CUPPET_VARIANT_BRIDGE_JSON.`);}
