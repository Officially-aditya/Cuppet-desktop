#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from '../runtime/service.mjs';
import { RemoteManager } from '../runtime/remote/manager.mjs';
import { ensureHostIdentity, setRemoteTokenPublicKey } from '../runtime/remote/identity.mjs';
import { registerHost } from '../runtime/remote/enroll.mjs';
import { runRelayServer, DEFAULT_RELAY_BIND, DEFAULT_RELAY_PORT } from '../runtime/remote/relay.mjs';

const DEFAULT_API_BASE='https://connect.cuppet.in';
const args=process.argv.slice(2);const command=args[0]??'help';const flags=parseFlags(args.slice(1));
try{
  if(command==='remote-control')await remoteControl(flags);
  else if(command==='relay')await relay(flags);
  else if(command==='remote-enroll')await enroll(flags);
  else{usage();if(command!=='help'&&command!=='--help'&&command!=='-h')process.exitCode=1;}
}catch(error){console.error(`Cuppet: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}

async function remoteControl(flags){
  const dataDir=String(flags['data-dir']??process.env.CUPPET_DATA_DIR??join(homedir(),'.cuppet-desktop'));const databasePath=join(dataDir,'conversations.sqlite3');let remote;
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
  const port=integer(flags.port,DEFAULT_RELAY_PORT);const bind=String(flags.bind??DEFAULT_RELAY_BIND);const authFile=String(flags['auth-file']??join(process.cwd(),'cuppet-relay-auth.json'));const adminToken=typeof flags['admin-token']==='string'?flags['admin-token']:undefined;const origins=listFlag(flags.origin);
  const controller=new AbortController();const server=await runRelayServer({port,bind,authFile,adminToken,origins,signal:controller.signal});console.log(`Cuppet relay listening on ${bind}:${server.port}`);console.log(`Auth file: ${authFile}`);if(bind!==DEFAULT_RELAY_BIND)console.log('WARNING: terminate TLS before exposing plaintext HTTP/WS outside localhost.');await waitForSignal();controller.abort();
}
async function enroll(flags){
  const dataDir=String(flags['data-dir']??process.env.CUPPET_DATA_DIR??join(homedir(),'.cuppet-desktop'));const remoteDir=join(dataDir,'remote');let identity=await ensureHostIdentity(remoteDir);const token=String(flags.token??process.env.CUPPET_TOKEN??'');if(!token)throw new Error('remote-enroll requires --token or CUPPET_TOKEN');const apiBase=String(flags['api-base']??process.env.CUPPET_API_BASE??DEFAULT_API_BASE);
  const result=await registerHost({apiBase,token,identity,relaySecret:identity.relaySecret,displayName:typeof flags.name==='string'?flags.name:undefined});if(result.remoteTokenPublicKey)identity=await setRemoteTokenPublicKey(remoteDir,result.remoteTokenPublicKey);console.log(`Enrolled ${identity.deviceName} [${identity.hostId}]`);if(result.relayUrl)console.log(`Relay: ${result.relayUrl}${result.relayRegistered?' (registered)':''}`);
}
function providerFromEnv(flags){return{baseUrl:String(flags['base-url']??process.env.CUPPET_BASE_URL??'https://api.openai.com/v1'),model:String(flags.model??process.env.CUPPET_MODEL??''),backgroundModel:String(flags['background-model']??process.env.CUPPET_BACKGROUND_MODEL??''),apiKey:String(flags['api-key']??process.env.CUPPET_API_KEY??process.env.OPENAI_API_KEY??'')};}
function parseFlags(values){const result={};for(let i=0;i<values.length;i++){const raw=values[i];if(!raw?.startsWith('--'))continue;const [name,inline]=raw.slice(2).split('=',2);if(inline!==undefined){append(result,name,inline);continue;}const next=values[i+1];if(next&&!next.startsWith('--')){append(result,name,next);i++;}else append(result,name,true);}return result;}
function append(target,key,value){if(target[key]===undefined)target[key]=value;else if(Array.isArray(target[key]))target[key].push(value);else target[key]=[target[key],value];}
function listFlag(value){if(value===undefined)return[];return(Array.isArray(value)?value:[value]).map(String).slice(0,32);}
function integer(value,fallback){const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=0&&parsed<=65535?parsed:fallback;}
function waitForSignal(){return new Promise((resolve)=>{const done=()=>{process.off('SIGINT',done);process.off('SIGTERM',done);resolve();};process.once('SIGINT',done);process.once('SIGTERM',done);});}
function usage(){console.log(`Cuppet independent CLI\n\n  cuppet remote-control [--relay-url wss://…] [--api-base https://connect.cuppet.in]\n  cuppet relay [--port 8787] [--bind 127.0.0.1] [--auth-file path]\n  cuppet remote-enroll --token <session-token> [--api-base https://connect.cuppet.in]\n\nHeadless provider env: CUPPET_API_KEY, CUPPET_MODEL, CUPPET_BASE_URL.`);}
