import { randomUUID } from 'node:crypto';
import { ConversationDatabase } from './database.mjs';
import { OpenAICompatibleChatProvider } from './provider.mjs';
import { ProjectManager } from './projects.mjs';

export class RuntimeService {
  #db; #emit; #providerFactory; #runs=new Map(); #projects;
  constructor({databasePath,emit=()=>{},providerFactory=(config)=>new OpenAICompatibleChatProvider(config),projectManagerFactory=(db)=>new ProjectManager({db})}) { this.#db=new ConversationDatabase(databasePath); this.#emit=emit; this.#providerFactory=providerFactory; this.#projects=projectManagerFactory(this.#db); }
  close(){ for(const run of this.#runs.values()) run.controller.abort(); this.#runs.clear(); this.#db.close(); }
  async handle(method,params={}){
    switch(method){
      case 'health': return {ok:true,runtime:'independent',activeRuns:this.#runs.size};
      case 'project.list': return this.#projects.list();
      case 'project.get': return this.#projects.get(params.projectId);
      case 'project.open': return this.#projects.open(params.projectId);
      case 'project.add-local': return this.#addProject(()=>this.#projects.addLocal({id:`project_${randomUUID()}`,...params}));
      case 'project.clone-url': return this.#addProject(()=>this.#projects.cloneUrl({id:`project_${randomUUID()}`,...params}));
      case 'project.github-list': return this.#projects.listGithubRepositories(params);
      case 'project.github-clone': return this.#addProject(()=>this.#projects.cloneGithubRepository({id:`project_${randomUUID()}`,...params}));
      case 'project.relocate': return this.#updateProject(()=>this.#projects.relocate(params.projectId,params.path));
      case 'project.remove': { const result=await this.#projects.remove(params.projectId); this.#emit({type:'project.removed',projectId:params.projectId}); return result; }
      case 'session.list': return this.#db.listSessions(params.projectId===undefined?{}:{projectId:params.projectId});
      case 'session.create': return this.createSession(params.projectId??null);
      case 'session.get': return this.requireSession(params.sessionId);
      case 'session.send': return this.send(params);
      case 'session.stop': return this.stop(params.sessionId);
      default: throw new Error(`unknown runtime method: ${method}`);
    }
  }
  async #addProject(factory){ const project=await factory(); this.#emit({type:'project.created',project}); return project; }
  async #updateProject(factory){ const project=await factory(); this.#emit({type:'project.updated',project}); return project; }
  createSession(projectId=null){ if(projectId) this.#db.getProject(projectId) ?? (()=>{throw new Error(`unknown project: ${projectId}`)})(); const session=this.#db.createSession({id:`session_${randomUUID()}`,projectId}); this.#emit({type:'session.created',session}); return session; }
  requireSession(sessionId){ if(typeof sessionId!=='string'||!sessionId) throw new Error('sessionId is required'); const session=this.#db.getSession(sessionId); if(!session) throw new Error(`unknown session: ${sessionId}`); return session; }
  async send(params){ const sessionId=params.sessionId; const text=typeof params.text==='string'?params.text.trim():''; if(!text) throw new Error('message text is required'); if(this.#runs.has(sessionId)) throw new Error('this session is already generating'); const existing=this.requireSession(sessionId); let project=null; if(existing.projectId){ project=await this.#projects.get(existing.projectId); if(project.missing) throw new Error(`Project folder is missing for ${project.name}. Relocate the project before continuing.`); }
    const user=this.#db.appendMessage({id:`msg_${randomUUID()}`,sessionId,role:'user',content:text,status:'complete'}); this.#emit({type:'message.created',message:user}); if(existing.title==='New chat'){const renamed=this.#db.renameSession(sessionId,titleFromMessage(text));this.#emit({type:'session.updated',session:renamed});}
    const assistant=this.#db.appendMessage({id:`msg_${randomUUID()}`,sessionId,role:'assistant',content:'',status:'streaming'}); this.#emit({type:'message.created',message:assistant}); const controller=new AbortController(); this.#runs.set(sessionId,{controller,assistantId:assistant.id,projectId:existing.projectId??null}); this.#emit({type:'run.started',sessionId,messageId:assistant.id,projectId:existing.projectId??null}); void this.#generate({sessionId,assistantId:assistant.id,provider:params.provider,signal:controller.signal}); return {accepted:true,sessionId,messageId:assistant.id,projectId:existing.projectId??null}; }
  stop(sessionId){ if(typeof sessionId!=='string'||!sessionId) throw new Error('sessionId is required'); const run=this.#runs.get(sessionId); if(!run)return {stopped:false,sessionId}; run.controller.abort(); return {stopped:true,sessionId,messageId:run.assistantId,projectId:run.projectId}; }
  async #generate({sessionId,assistantId,provider,signal}){ try{const completionMessages=this.#db.getSession(sessionId).messages.filter((m)=>m.id!==assistantId&&m.status!=='streaming').map(({role,content})=>({role,content})); const adapter=this.#providerFactory(provider??{}); await adapter.stream(completionMessages,{signal,onDelta:async(delta)=>{if(signal.aborted)return;const message=this.#db.appendMessageContent(assistantId,delta);this.#emit({type:'message.delta',sessionId,messageId:assistantId,delta,content:message.content});}}); if(signal.aborted)throw abortError(); const complete=this.#db.updateMessage(assistantId,{status:'complete'});this.#emit({type:'message.completed',message:complete});}catch(error){const stopped=signal.aborted||error?.name==='AbortError';const current=this.#db.getMessage(assistantId);const next=this.#db.updateMessage(assistantId,{status:stopped?'stopped':'error',content:stopped?current?.content??'':current?.content||`Generation failed: ${cleanError(error)}`});this.#emit({type:'message.completed',message:next});if(!stopped)this.#emit({type:'runtime.error',sessionId,message:cleanError(error)});}finally{const run=this.#runs.get(sessionId);this.#runs.delete(sessionId);const session=this.#db.getSessionSummary(sessionId);if(session)this.#emit({type:'session.updated',session});this.#emit({type:'run.finished',sessionId,messageId:assistantId,projectId:run?.projectId??session?.projectId??null});}}
}
function titleFromMessage(value){const oneLine=value.replace(/\s+/g,' ').trim();return oneLine.length<=56?oneLine:`${oneLine.slice(0,53).trimEnd()}…`;}
function cleanError(error){return(error instanceof Error?error.message:String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,'Bearer [redacted]').slice(0,500);}
function abortError(){const error=new Error('Generation stopped');error.name='AbortError';return error;}
