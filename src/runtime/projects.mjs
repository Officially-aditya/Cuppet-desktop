import { access, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 512 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export class ProjectError extends Error {
  constructor(code, message) { super(message); this.name = 'ProjectError'; this.code = code; }
}

export class ProjectManager {
  #db; #run; #realpath; #lstat; #access; #mkdir; #rm;
  constructor({ db, runCommand = runCommandDefault, realpathImpl = realpath, lstatImpl = lstat, accessImpl = access, mkdirImpl = mkdir, rmImpl = rm }) {
    this.#db=db; this.#run=runCommand; this.#realpath=realpathImpl; this.#lstat=lstatImpl; this.#access=accessImpl; this.#mkdir=mkdirImpl; this.#rm=rmImpl;
  }
  async list() { const projects=this.#db.listProjects(); return Promise.all(projects.map((project)=>this.status(project))); }
  async get(id) { const project=this.#db.getProject(id); if(!project) throw new ProjectError('PROJECT_NOT_FOUND',`Unknown project: ${id}`); return this.status(project); }
  async addLocal({ id, path, name }) {
    const normalized=await this.inspectLocalPath(path);
    const duplicate=this.#db.getProjectByPath(normalized.canonicalPath);
    if(duplicate) throw new ProjectError('PROJECT_DUPLICATE',`This folder is already registered as ${duplicate.name}.`);
    return this.status(this.#db.createProject({id,name:cleanName(name)||basename(normalized.canonicalPath),canonicalPath:normalized.canonicalPath,repositoryId:normalized.repositoryId,remoteUrl:normalized.remoteUrl}));
  }
  async relocate(id,path) {
    const current=this.#db.getProject(id); if(!current) throw new ProjectError('PROJECT_NOT_FOUND',`Unknown project: ${id}`);
    const normalized=await this.inspectLocalPath(path);
    const duplicate=this.#db.getProjectByPath(normalized.canonicalPath);
    if(duplicate && duplicate.id!==id) throw new ProjectError('PROJECT_DUPLICATE',`This folder is already registered as ${duplicate.name}.`);
    return this.status(this.#db.relocateProject(id,normalized.canonicalPath,{repositoryId:normalized.repositoryId,remoteUrl:normalized.remoteUrl}));
  }
  async remove(id){ if(!this.#db.getProject(id)) throw new ProjectError('PROJECT_NOT_FOUND',`Unknown project: ${id}`); return {removed:this.#db.removeProject(id),id}; }
  async open(id){ const project=this.#db.touchProject(id); if(!project) throw new ProjectError('PROJECT_NOT_FOUND',`Unknown project: ${id}`); return this.status(project); }
  async inspectLocalPath(path) {
    if(typeof path!=='string'||!path.trim()) throw new ProjectError('PROJECT_PATH_REQUIRED','Choose a project folder.');
    let selected; try { selected=await this.#realpath(resolve(path)); const stats=await this.#lstat(selected); if(!stats.isDirectory()) throw new Error('not a directory'); } catch { throw new ProjectError('PROJECT_PATH_MISSING','The selected project folder does not exist.'); }
    let root=selected;
    const top=await this.#git(['-C',selected,'rev-parse','--show-toplevel'],{allowFailure:true});
    if(top.ok && top.stdout.trim()) { try { root=await this.#realpath(top.stdout.trim()); } catch { root=selected; } }
    const remote=await this.#git(['-C',root,'remote','get-url','origin'],{allowFailure:true});
    const remoteUrl=remote.ok&&remote.stdout.trim()?remote.stdout.trim():null;
    return {canonicalPath:root,remoteUrl,repositoryId:repositoryIdentityFromRemote(remoteUrl)};
  }
  async status(project) {
    let missing=false; try { await this.#access(project.canonicalPath); } catch { missing=true; }
    if(missing) return {...project,missing:true,branch:null,dirty:null};
    const [branch,status]=await Promise.all([
      this.#git(['-C',project.canonicalPath,'symbolic-ref','--quiet','--short','HEAD'],{allowFailure:true}),
      this.#git(['-C',project.canonicalPath,'status','--porcelain=v1','--untracked-files=normal'],{allowFailure:true}),
    ]);
    let branchName=branch.ok?branch.stdout.trim():'';
    if(!branchName){ const detached=await this.#git(['-C',project.canonicalPath,'rev-parse','--short','HEAD'],{allowFailure:true}); branchName=detached.ok?`detached:${detached.stdout.trim()}`:null; }
    return {...project,missing:false,branch:branchName||null,dirty:status.ok?Boolean(status.stdout.trim()):null};
  }
  async listGithubRepositories({query='' }={}) {
    const result=await this.#gh(['api','--method','GET','user/repos','-f','per_page=100','-f','affiliation=owner,collaborator,organization_member','--paginate','--slurp'],{allowFailure:true,timeoutMs:25_000});
    if(!result.ok) throw githubError(result);
    let decoded; try { decoded=JSON.parse(result.stdout); } catch { throw new ProjectError('GITHUB_PICKER_FAILED','GitHub CLI returned invalid repository data.'); }
    const rows=(Array.isArray(decoded)&&decoded.every(Array.isArray)?decoded.flat():decoded);
    if(!Array.isArray(rows)) throw new ProjectError('GITHUB_PICKER_FAILED','GitHub CLI returned an unexpected repository list.');
    const needle=String(query).trim().toLowerCase();
    return rows.map(repoShape).filter(Boolean).filter((repo)=>!needle||`${repo.nameWithOwner} ${repo.description??''}`.toLowerCase().includes(needle)).slice(0,250);
  }
  async cloneUrl({ id, url, destinationParent, name }) {
    const parsed=normalizeGithubRepositoryUrl(url);
    const target=await this.#cloneTarget(destinationParent,parsed.repository);
    const result=await this.#git(['clone','--',parsed.cloneUrl,target],{allowFailure:true,timeoutMs:120_000});
    if(!result.ok){ await this.#cleanupCloneTarget(target); throw cloneError(result); }
    return this.addLocal({id,path:target,name:name||parsed.repository});
  }
  async cloneGithubRepository({ id, nameWithOwner, destinationParent, name }) {
    const identity=normalizeRepositoryIdentity(nameWithOwner);
    const target=await this.#cloneTarget(destinationParent,identity.split('/')[1]);
    const result=await this.#gh(['repo','clone',identity,target],{allowFailure:true,timeoutMs:120_000});
    if(!result.ok){ await this.#cleanupCloneTarget(target); throw githubError(result,true); }
    return this.addLocal({id,path:target,name:name||identity.split('/')[1]});
  }
  async #cloneTarget(parent,repoName){ if(typeof parent!=='string'||!parent.trim()) throw new ProjectError('CLONE_DESTINATION_REQUIRED','Choose a destination folder.'); let canonicalParent; try{ canonicalParent=await this.#realpath(resolve(parent)); }catch{ throw new ProjectError('CLONE_DESTINATION_MISSING','The clone destination does not exist.'); } const target=join(canonicalParent,repoName.replace(/\.git$/i,'')); try{ await this.#lstat(target); throw new ProjectError('CLONE_DESTINATION_EXISTS',`A folder named ${basename(target)} already exists in the destination.`);}catch(error){ if(error instanceof ProjectError) throw error; } return target; }
  async #cleanupCloneTarget(target){ try{await this.#rm(target,{recursive:true,force:true});}catch{} }
  #git(args,options={}){ return this.#run('git',args,{...options,env:{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}}); }
  #gh(args,options={}){ return this.#run('gh',args,options); }
}

export function normalizeGithubRepositoryUrl(value){
  const raw=String(value??'').trim(); if(!raw) throw new ProjectError('GITHUB_URL_REQUIRED','Enter a GitHub repository URL.');
  const scp=raw.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i); if(scp) return githubShape(scp[1],scp[2],raw);
  let url; try{url=new URL(raw);}catch{throw new ProjectError('GITHUB_URL_INVALID','Use an HTTPS or SSH GitHub repository URL.');}
  if(url.hostname.toLowerCase()!=='github.com') throw new ProjectError('GITHUB_URL_INVALID','Only github.com repository URLs are accepted in this flow.');
  if(url.password || (url.protocol==='https:' && url.username) || (url.protocol==='ssh:' && url.username && url.username!=='git')) throw new ProjectError('GITHUB_URL_CREDENTIALS','Do not put credentials or tokens in a repository URL.');
  if(!['https:','ssh:'].includes(url.protocol)) throw new ProjectError('GITHUB_URL_INVALID','Use an HTTPS or SSH GitHub repository URL.');
  const parts=url.pathname.replace(/^\/+|\/+$/g,'').split('/'); if(parts.length!==2) throw new ProjectError('GITHUB_URL_INVALID','The URL must point to one GitHub repository.');
  return githubShape(parts[0],parts[1].replace(/\.git$/i,''),raw);
}
function githubShape(owner,repository,cloneUrl){ if(!owner||!repository) throw new ProjectError('GITHUB_URL_INVALID','The URL must include an owner and repository.'); return {owner,repository,identity:`${owner}/${repository}`,cloneUrl}; }
export function repositoryIdentityFromRemote(value){ if(!value) return null; try{return normalizeGithubRepositoryUrl(value).identity;}catch{return null;} }
function normalizeRepositoryIdentity(value){ const match=String(value??'').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/); if(!match) throw new ProjectError('GITHUB_REPOSITORY_INVALID','Choose a valid GitHub repository.'); return `${match[1]}/${match[2]}`; }
function cleanName(value){ return typeof value==='string'?value.trim().slice(0,120):''; }
function repoShape(value){ if(!value||typeof value!=='object'||typeof value.full_name!=='string') return null; return {id:String(value.id??value.full_name),nameWithOwner:value.full_name,url:typeof value.html_url==='string'?value.html_url:null,sshUrl:typeof value.ssh_url==='string'?value.ssh_url:null,isPrivate:Boolean(value.private),defaultBranch:typeof value.default_branch==='string'?value.default_branch:null,description:typeof value.description==='string'?value.description:null}; }
function sanitized(message){ return String(message??'').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'https://[credentials]@').replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+/g,'[redacted]').slice(0,900); }
function cloneError(result){ const detail=sanitized(result.stderr||result.stdout); if(/authentication|permission denied|repository not found|could not read Username/i.test(detail)) return new ProjectError('GIT_AUTH_FAILED',`Git could not authenticate to this repository. Check your existing Git credential helper or SSH access.${detail?` ${detail}`:''}`); if(result.missing) return new ProjectError('GIT_MISSING','Git is not installed or not available on PATH.'); return new ProjectError('GIT_CLONE_FAILED',`Git clone failed.${detail?` ${detail}`:''}`); }
function githubError(result,cloning=false){ const detail=sanitized(result.stderr||result.stdout); if(result.missing) return new ProjectError('GITHUB_CLI_MISSING','GitHub CLI (gh) is not installed. You can still paste a GitHub URL or add a local folder.'); if(/not logged|authentication|auth login|HTTP 401|HTTP 403/i.test(detail)) return new ProjectError('GITHUB_AUTH_REQUIRED','GitHub CLI is not authenticated. Run gh auth login, then retry the repository picker.'); return new ProjectError(cloning?'GITHUB_CLONE_FAILED':'GITHUB_PICKER_FAILED',`${cloning?'GitHub clone':'Repository picker'} failed.${detail?` ${detail}`:''}`); }

export function runCommandDefault(command,args,{env={},timeoutMs=COMMAND_TIMEOUT_MS,allowFailure=false}={}){
  return new Promise((resolvePromise,reject)=>{ let child; try{ child=spawn(command,args,{shell:false,windowsHide:true,env:{...process.env,...env}}); }catch(error){ if(allowFailure) return resolvePromise({ok:false,code:null,stdout:'',stderr:String(error),missing:error?.code==='ENOENT'}); return reject(error); } let stdout='',stderr='',settled=false; const finish=(result)=>{if(settled)return;settled=true;clearTimeout(timer);resolvePromise(result);}; child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8'); child.stdout?.on('data',(chunk)=>{stdout=(stdout+chunk).slice(-MAX_OUTPUT);}); child.stderr?.on('data',(chunk)=>{stderr=(stderr+chunk).slice(-MAX_OUTPUT);}); child.once('error',(error)=>finish({ok:false,code:null,stdout,stderr:String(error),missing:error?.code==='ENOENT'})); child.once('close',(code)=>{const result={ok:code===0,code,stdout,stderr,missing:false}; if(!result.ok&&!allowFailure) reject(new Error(stderr||`${command} exited ${code}`)); else finish(result);}); const timer=setTimeout(()=>{child.kill('SIGTERM');finish({ok:false,code:null,stdout,stderr:`${stderr}\nCommand timed out`,missing:false});},Math.max(100,timeoutMs)); });
}
