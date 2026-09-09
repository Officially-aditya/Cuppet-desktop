from pathlib import Path

p = Path('src/cli/main.mjs')
s = p.read_text()

s = s.replace("import { buildRuntimeDoctor, buildRuntimeStatus } from '../runtime/diagnostics.mjs';\n", "import { buildRuntimeDoctor, buildRuntimeStatus } from '../runtime/diagnostics.mjs';\nimport { executeCommand, listCommands, parseSlashCommand } from '../runtime/commands.mjs';\n")

s = s.replace("  else if(command==='models')showModels(flags);\n", "  else if(command==='models')showModels(flags);\n  else if(command==='commands')showCommands();\n  else if(command==='command')await headlessCommand(flags);\n")

s = s.replace("function showModels(flags){console.log(JSON.stringify(providerProjection(providerFromEnv(flags)),null,2));}\n", "function showModels(flags){console.log(JSON.stringify(providerProjection(providerFromEnv(flags)),null,2));}\nfunction showCommands(){console.log(JSON.stringify(listCommands(),null,2));}\n")

needle = "async function headlessPrompt(flags){\n  const prompt=String(flags.prompt??flags._?.[0]??'').trim();if(!prompt)throw new Error('prompt requires --prompt <text> or a positional message');\n"
replacement = needle + "  const slash=parseSlashCommand(prompt);\n  if(slash.kind==='unknown')throw new Error(`Unknown Cuppet command: /${slash.name}`);\n  if(slash.kind==='command'){await headlessCommand(flags,slash);return;}\n"
if needle not in s:
    raise SystemExit('headlessPrompt insertion point not found')
s = s.replace(needle, replacement)

marker = "\nfunction prepareHeadlessSession({databasePath,dataDir,flags}){\n"
addition = r'''
async function headlessCommand(flags,prepared=null){
  const raw=prepared?prepared.raw:String(flags.command??flags._?.join(' ')??'').trim();
  const parsed=prepared??parseSlashCommand(raw);
  if(parsed.kind==='unknown')throw new Error(`Unknown Cuppet command: /${parsed.name}`);
  if(parsed.kind!=='command')throw new Error('command requires a recognized slash command, for example: cuppet command "/status"');
  const dataDir=dataDirectory(flags);const databasePath=join(dataDir,'conversations.sqlite3');
  let sessionId=null;
  if(parsed.definition?.requiresSession)sessionId=resolveExistingSession(databasePath,flags,{latestByDefault:true});
  else if(stringFlag(flags.session)||flags.continue===true)sessionId=resolveExistingSession(databasePath,flags,{latestByDefault:false});
  const provider=providerFromEnv(flags);const service=new RuntimeService({databasePath,dataDir,interactive:false});
  try{
    const result=await executeCommand(parsed,{
      sessionId,
      call:(method,params)=>service.handle(method,params),
      providerRequest:provider,
      host:{
        status:()=>buildRuntimeStatus({call:(method,params)=>service.handle(method,params),providerConfig:provider,version:'0.8.0-alpha.1'}),
        doctor:()=>buildRuntimeDoctor({call:(method,params)=>service.handle(method,params),providerConfig:provider,version:'0.8.0-alpha.1'}),
        remoteStatus:async()=>{throw new Error('Remote lifecycle belongs to a long-running host; use `cuppet remote-control`.');},
        remoteStart:async()=>{throw new Error('Use `cuppet remote-control` to start a headless Remote host.');},
        remoteStop:async()=>{throw new Error('Stop the long-running `cuppet remote-control` process directly.');},
      },
      provider:headlessProviderAuthority(provider),
    });
    if(flags.json===true)console.log(JSON.stringify(result,null,2));
    else console.log(result.presentation??formatCommandResult(result));
  }finally{await service.close();}
}
function headlessProviderAuthority(provider){
  return{
    models:async()=>providerProjection(provider),
    providers:async()=>{const value=providerProjection(provider);return{configured:value.configured,selectedProvider:value.primary?.providerID??null,catalog:value.catalog};},
    selectProvider:async(providerID)=>{const current=providerProjection(provider).primary?.providerID??null;if(String(providerID)!==String(current))throw new Error('Use --provider-id/CUPPET_PROVIDER_ID so provider credentials remain explicit in headless mode.');return{selected:true,providerID:current};},
    effort:async()=>{const value=providerProjection(provider);const model=value.models.find((item)=>item.providerID===value.primary?.providerID&&item.modelID===value.primary?.modelID);return{providerID:value.primary?.providerID??null,modelID:value.primary?.modelID??null,variant:value.primary?.variant??null,variants:model?.variants??[]};},
    setEffort:async()=>{throw new Error('Use --effort or CUPPET_EFFORT for headless commands so selection remains explicit.');},
  };
}
function formatCommandResult(value){
  if(value?.result===undefined)return 'Command completed.';
  if(typeof value.result==='string')return value.result;
  return JSON.stringify(value.result,null,2);
}
'''
if marker not in s:
    raise SystemExit('prepareHeadlessSession marker not found')
s = s.replace(marker, addition + marker)

s = s.replace("function usage(){console.log(`Cuppet independent CLI\\n\\n  cuppet prompt <text> [--session id|-s id] [--continue|-c] [--fork] [--json]\\n", "function usage(){console.log(`Cuppet independent CLI\\n\\n  cuppet prompt <text> [--session id|-s id] [--continue|-c] [--fork] [--json]\\n  cuppet command \"/status\" [--session id|-s id] [--json]\\n  cuppet commands\\n")

p.write_text(s)
