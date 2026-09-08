const els = Object.fromEntries([
  ['projectList','#project-list'],['newChat','#new-chat'],['addProject','#add-project'],['title','#conversation-title'],['projectStatus','#project-status'],['runtimeStatus','#runtime-status'],['providerPill','#provider-pill'],['modeToggle','#mode-toggle'],['orchestratorToggle','#orchestrator-toggle'],['backgroundToggle','#background-toggle'],['tstPill','#tst-pill'],['messages','#messages'],['composer','#composer'],['prompt','#prompt'],['send','#send-button'],['stop','#stop-button'],['settingsButton','#settings-button'],['settingsDialog','#settings-dialog'],['settingsForm','#settings-form'],['settingsClose','#settings-close'],['settingsCancel','#settings-cancel'],['baseUrl','#provider-base-url'],['model','#provider-model'],['backgroundModel','#provider-background-model'],['apiKey','#provider-api-key'],['settingsNote','#settings-note'],['toast','#toast'],['newChatDialog','#new-chat-dialog'],['newChatForm','#new-chat-form'],['newChatProject','#new-chat-project'],['newChatClose','#new-chat-close'],['newChatCancel','#new-chat-cancel'],['addProjectDialog','#add-project-dialog'],['addProjectClose','#add-project-close'],['localProjectName','#local-project-name'],['addLocalProject','#add-local-project'],['githubUrl','#github-url'],['cloneUrlProject','#clone-url-project'],['githubSearch','#github-search'],['loadGithubRepos','#load-github-repos'],['githubRepoResults','#github-repo-results'],['addProjectNote','#add-project-note'],
].map(([key,selector]) => [key,document.querySelector(selector)]));

const state = { projects: [], sessions: [], active: null, draft: null, selectedProjectId: null, runningSessions: new Set(), provider: null, githubRepos: [], cognitive: { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false } }, sessionMode: 'build' };

async function init() {
  window.cuppet.onEvent(handleRuntimeEvent);
  try {
    const [health, provider, projects, sessions, cognitive] = await Promise.all([window.cuppet.health(), window.cuppet.settings.get(), window.cuppet.projects.list(), window.cuppet.sessions.list(), window.cuppet.cognitive.status()]);
    state.provider = provider; state.projects = projects; state.sessions = sessions; state.cognitive = cognitive;
    for (const session of sessions) if (session.lastStatus === 'streaming') state.runningSessions.add(session.id);
    els.runtimeStatus.textContent = health.ok ? 'Independent runtime ready · local SQLite' : 'Runtime unavailable';
    renderProvider(); renderSidebar(); renderProjectOptions(); renderCognitive();
    if (sessions[0]) await openSession(sessions[0].id); else startDraft(null);
  } catch (error) { els.runtimeStatus.textContent = 'Runtime unavailable'; toast(error.message || String(error)); }
}

function startDraft(projectId) {
  state.active = null; state.draft = { projectId: projectId || null, title: 'New chat', messages: [], mode: 'build' }; state.selectedProjectId = projectId || null; state.sessionMode = 'build';
  renderSidebar(); renderConversation(); renderCognitive(); els.prompt.focus();
}

async function openNewChatDialog() { renderProjectOptions(); els.newChatProject.value = state.selectedProjectId || ''; els.newChatDialog.showModal(); }

async function createPersistedSessionForDraft() {
  if (!state.draft) return state.active;
  const draft = state.draft;
  const session = await window.cuppet.sessions.create(draft.projectId);
  if (draft.mode === 'plan') await window.cuppet.cognitive.modeSet(session.id, 'plan');
  upsertSession(session); state.draft = null; state.active = { ...session, messages: [] }; state.selectedProjectId = session.projectId || null; state.sessionMode = draft.mode || 'build';
  renderSidebar(); renderCognitive(); return state.active;
}

async function openSession(id) {
  const [session, mode] = await Promise.all([window.cuppet.sessions.get(id), window.cuppet.cognitive.modeGet(id)]);
  state.active = session; state.draft = null; state.selectedProjectId = session.projectId || null; state.sessionMode = mode.mode || 'build';
  if (session.messages.some((message) => message.status === 'streaming')) state.runningSessions.add(session.id); else state.runningSessions.delete(session.id);
  if (session.projectId) void window.cuppet.projects.open(session.projectId).catch(() => {});
  renderSidebar(); renderConversation(); renderCognitive();
}

async function selectProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId); if (!project) return;
  state.selectedProjectId = projectId; await window.cuppet.projects.open(projectId).catch(() => {});
  const first = state.sessions.filter((s) => s.projectId === projectId).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0))[0];
  if (first) await openSession(first.id); else startDraft(projectId);
}

function renderSidebar() {
  const children = [];
  for (const project of state.projects) {
    const wrap = document.createElement('section'); wrap.className = 'project-group';
    const row = document.createElement('div'); row.className = `project-row${state.selectedProjectId===project.id?' active':''}`;
    const select = document.createElement('button'); select.type='button'; select.className='project-button'; select.addEventListener('click',()=>void selectProject(project.id));
    const name = document.createElement('span'); name.className='project-name'; name.textContent=project.name;
    const meta = document.createElement('span'); meta.className=`project-meta${project.missing?' missing':''}`; meta.textContent=project.missing?'Folder missing':[project.branch,project.dirty?'modified':null].filter(Boolean).join(' · ')||'Local folder';
    select.append(name,meta); row.append(select);
    if (project.missing) { const relocate=document.createElement('button'); relocate.type='button'; relocate.className='mini-button'; relocate.textContent='Relocate'; relocate.addEventListener('click',(event)=>{event.stopPropagation();void relocateProject(project.id);}); row.append(relocate); }
    if (state.selectedProjectId===project.id && !project.missing) { const remove=document.createElement('button'); remove.type='button'; remove.className='mini-button remove-button'; remove.textContent='Remove'; remove.title='Remove registration only; files stay on disk'; remove.addEventListener('click',(event)=>{event.stopPropagation();void removeProject(project.id);}); row.append(remove); }
    wrap.append(row);
    for (const session of state.sessions.filter((item)=>item.projectId===project.id)) wrap.append(sessionButton(session));
    children.push(wrap);
  }
  const general = state.sessions.filter((session)=>!session.projectId);
  if (general.length) { const group=document.createElement('section');group.className='project-group general-group';const label=document.createElement('div');label.className='general-label';label.textContent='General';group.append(label);for(const session of general)group.append(sessionButton(session));children.push(group); }
  if (!children.length) { const empty=document.createElement('div');empty.className='sidebar-empty';empty.textContent='No projects yet. Add a folder or clone a repository.';children.push(empty); }
  els.projectList.replaceChildren(...children);
}

function sessionButton(session) {
  const button=document.createElement('button');button.className=`session-item${state.active?.id===session.id?' active':''}`;button.type='button';button.addEventListener('click',()=>void openSession(session.id));
  const title=document.createElement('div');title.className='session-title';title.textContent=session.title||'New chat';const meta=document.createElement('div');meta.className='session-meta';meta.textContent=session.lastStatus==='streaming'?'Generating…':relativeTime(session.updatedAt);button.append(title,meta);return button;
}

function renderConversation() {
  const view = state.active || state.draft || { title:'New chat', projectId:null, messages:[] };
  els.title.textContent=view.title||'New chat';
  const project=state.projects.find((p)=>p.id===view.projectId);
  els.projectStatus.textContent=project?`${project.name}${project.missing?' · folder missing':''}${project.branch?` · ${project.branch}`:''}`:'General chat · no filesystem access';
  const messages=view.messages??[];
  if(!messages.length){const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML=`<h1>${project?'Start working in this project':'Start a conversation'}</h1><p>${project?'The chat will be persisted with this project on your first message.':'General chats are not attached to a filesystem project.'}</p>`;els.messages.replaceChildren(empty);}else{els.messages.replaceChildren(...messages.filter((m)=>m.role!=='system').map(renderMessage));requestAnimationFrame(()=>{els.messages.scrollTop=els.messages.scrollHeight;});}
  renderRunState(); renderCognitive();
}
function renderMessage(message){const wrap=document.createElement('article');wrap.className=`message ${message.role}`;wrap.dataset.messageId=message.id;const role=document.createElement('div');role.className='message-role';role.textContent=message.role==='assistant'?'Cuppet':'You';const content=document.createElement('div');content.className='message-content';content.textContent=message.content;wrap.append(role,content);if(message.status&&message.status!=='complete'){const status=document.createElement('div');status.className=`message-status${message.status==='error'?' error':''}`;status.textContent=statusLabel(message.status);wrap.append(status);}return wrap;}

async function sendCurrentMessage() {
  const text=els.prompt.value.trim();if(!text)return;
  if(!state.provider?.apiKeyConfigured||!state.provider?.model){await openSettings();toast('Configure a provider and model before sending.');return;}
  try {
    if(!state.active) await createPersistedSessionForDraft(); if(!state.active)return;
    const project=state.projects.find((p)=>p.id===state.active.projectId);if(project?.missing){toast(`Relocate ${project.name} before continuing.`);return;}
    const sessionId=state.active.id;els.prompt.value='';resizePrompt();await window.cuppet.sessions.send(sessionId,text);state.runningSessions.add(sessionId);renderRunState();
  } catch(error){toast(error.message||String(error));}
}
async function stopCurrent(){if(!state.active||!state.runningSessions.has(state.active.id))return;try{await window.cuppet.sessions.stop(state.active.id);}catch(error){toast(error.message||String(error));}}

async function toggleMode(){
  const next=state.sessionMode==='plan'?'build':'plan';
  try{if(state.active)await window.cuppet.cognitive.modeSet(state.active.id,next);else if(state.draft)state.draft.mode=next;state.sessionMode=next;renderCognitive();toast(`${next==='plan'?'Plan':'Build'} mode enabled.`);}catch(error){toast(error.message||String(error));}
}
async function toggleOrchestrator(){try{const result=await window.cuppet.cognitive.orchestratorSet(!state.cognitive.orchestratorEnabled);state.cognitive.orchestratorEnabled=result.enabled;renderCognitive();toast(result.enabled?'Orchestrator enabled. Automatic context injection is off.':'Orchestrator disabled. Automatic Cuppet context is active.');}catch(error){toast(error.message||String(error));}}
async function toggleBackground(){try{if(state.cognitive.backgroundPaused){await window.cuppet.cognitive.backgroundResume();state.cognitive.backgroundPaused=false;}else{await window.cuppet.cognitive.backgroundPause();state.cognitive.backgroundPaused=true;}renderCognitive();}catch(error){toast(error.message||String(error));}}
function renderCognitive(){
  els.modeToggle.textContent=state.sessionMode==='plan'?'Plan':'Build';els.modeToggle.classList.toggle('active',state.sessionMode==='plan');
  els.orchestratorToggle.textContent=state.cognitive.orchestratorEnabled?'Orchestrator on':'Orchestrator off';els.orchestratorToggle.classList.toggle('active',state.cognitive.orchestratorEnabled);
  els.backgroundToggle.textContent=state.cognitive.backgroundPaused?'Background paused':'Background on';els.backgroundToggle.classList.toggle('active',!state.cognitive.backgroundPaused);
  const tst=state.cognitive.tst||{};els.tstPill.textContent=tst.connected?'TST connected':tst.configured?'TST ready':'TST off';
}

async function refreshData() { const [projects,sessions]=await Promise.all([window.cuppet.projects.list(),window.cuppet.sessions.list()]);state.projects=projects;state.sessions=sessions;renderSidebar();renderProjectOptions();if(state.active){const summary=sessions.find((s)=>s.id===state.active.id);if(summary)state.active={...state.active,...summary};}renderConversation(); }

function handleRuntimeEvent(event) {
  if(!event||typeof event.type!=='string')return;
  if(event.type==='run.started')state.runningSessions.add(event.sessionId);
  if(event.type==='run.finished')state.runningSessions.delete(event.sessionId);
  if(event.type==='runtime.error')toast(event.message||'Runtime error');
  if(event.type==='cognitive.updated'&&event.cognitive){state.cognitive=event.cognitive;renderCognitive();}
  if(event.type==='context.compiled'&&event.tst){state.cognitive.tst=event.tst;renderCognitive();}
  if(event.project) upsertProject(event.project);
  if(event.type==='project.removed'){state.projects=state.projects.filter((p)=>p.id!==event.projectId);if(state.selectedProjectId===event.projectId)state.selectedProjectId=null;void refreshData();}
  if(event.session)upsertSession(event.session);
  if(event.message&&state.active?.id===event.message.sessionId)upsertActiveMessage(event.message);
  if(event.type==='message.delta'&&state.active?.id===event.sessionId){const message=state.active.messages.find((item)=>item.id===event.messageId);if(message){message.content=event.content;message.status='streaming';const node=els.messages.querySelector(`[data-message-id="${cssEscape(event.messageId)}"] .message-content`);if(node)node.textContent=event.content;els.messages.scrollTop=els.messages.scrollHeight;}}
  renderSidebar();renderRunState();if(event.type==='message.created'||event.type==='message.completed')renderConversation();
}
function upsertProject(project){const index=state.projects.findIndex((p)=>p.id===project.id);if(index>=0)state.projects[index]={...state.projects[index],...project};else state.projects.unshift(project);state.projects.sort((a,b)=>(b.lastOpenedAt??0)-(a.lastOpenedAt??0));renderProjectOptions();}
function upsertSession(session){const index=state.sessions.findIndex((s)=>s.id===session.id);if(index>=0)state.sessions[index]={...state.sessions[index],...session};else state.sessions.unshift(session);state.sessions.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0));if(state.active?.id===session.id)state.active={...state.active,...session};}
function upsertActiveMessage(message){const index=state.active.messages.findIndex((m)=>m.id===message.id);if(index>=0)state.active.messages[index]=message;else state.active.messages.push(message);state.active.messages.sort((a,b)=>a.sequence-b.sequence);}
function renderRunState(){const running=Boolean(state.active?.id&&state.runningSessions.has(state.active.id));els.stop.classList.toggle('hidden',!running);els.send.disabled=running;els.prompt.disabled=running;els.modeToggle.disabled=running;}

async function openAddProject(){els.addProjectNote.textContent='';els.localProjectName.value='';els.githubUrl.value='';els.githubRepoResults.replaceChildren();state.githubRepos=[];els.addProjectDialog.showModal();}
async function addLocalProject(){const path=await window.cuppet.native.chooseFolder({title:'Choose project folder',buttonLabel:'Add project'});if(!path)return;try{const project=await window.cuppet.projects.addLocal({path,name:els.localProjectName.value});upsertProject(project);els.addProjectDialog.close();startDraft(project.id);toast(`Added ${project.name}.`);}catch(error){showProjectError(error);}}
async function cloneUrlProject(){const url=els.githubUrl.value.trim();if(!url){els.addProjectNote.textContent='Enter a GitHub repository URL.';return;}const destinationParent=await window.cuppet.native.chooseFolder({title:'Choose clone destination',buttonLabel:'Clone here'});if(!destinationParent)return;setProjectBusy(true,'Cloning repository…');try{const project=await window.cuppet.projects.cloneUrl({url,destinationParent});upsertProject(project);els.addProjectDialog.close();startDraft(project.id);toast(`Cloned ${project.name}.`);}catch(error){showProjectError(error);}finally{setProjectBusy(false);}}
async function loadGithubRepos(){setProjectBusy(true,'Loading repositories from existing GitHub CLI authentication…');try{state.githubRepos=await window.cuppet.projects.githubList(els.githubSearch.value);renderGithubRepos();els.addProjectNote.textContent=state.githubRepos.length?`${state.githubRepos.length} repositories available.`:'No matching repositories found.';}catch(error){showProjectError(error);}finally{setProjectBusy(false);}}
function renderGithubRepos(){els.githubRepoResults.replaceChildren(...state.githubRepos.map((repo)=>{const button=document.createElement('button');button.type='button';button.className='repo-result';button.addEventListener('click',()=>void cloneGithubRepo(repo));const title=document.createElement('strong');title.textContent=repo.nameWithOwner;const meta=document.createElement('span');meta.textContent=[repo.isPrivate?'Private':'Public',repo.defaultBranch].filter(Boolean).join(' · ');button.append(title,meta);return button;}));}
async function cloneGithubRepo(repo){const destinationParent=await window.cuppet.native.chooseFolder({title:`Clone ${repo.nameWithOwner}`,buttonLabel:'Clone here'});if(!destinationParent)return;setProjectBusy(true,`Cloning ${repo.nameWithOwner}…`);try{const project=await window.cuppet.projects.githubClone({nameWithOwner:repo.nameWithOwner,destinationParent});upsertProject(project);els.addProjectDialog.close();startDraft(project.id);toast(`Cloned ${project.name}.`);}catch(error){showProjectError(error);}finally{setProjectBusy(false);}}
async function removeProject(projectId){const project=state.projects.find((p)=>p.id===projectId);if(!project)return;if(!window.confirm(`Remove ${project.name} from Cuppet? The checkout will not be deleted.`))return;try{await window.cuppet.projects.remove(projectId);await refreshData();toast(`Removed ${project.name}. Files were left untouched.`);if(state.active?.projectId===projectId)startDraft(null);}catch(error){toast(error.message||String(error));}}
async function relocateProject(projectId){const path=await window.cuppet.native.chooseFolder({title:'Relocate project folder',buttonLabel:'Use folder'});if(!path)return;try{const project=await window.cuppet.projects.relocate(projectId,path);upsertProject(project);renderSidebar();renderConversation();toast(`Relocated ${project.name}.`);}catch(error){toast(error.message||String(error));}}
function showProjectError(error){els.addProjectNote.textContent=error.message||String(error);}
function setProjectBusy(busy,message=''){els.addProjectNote.textContent=message;els.addLocalProject.disabled=busy;els.cloneUrlProject.disabled=busy;els.loadGithubRepos.disabled=busy;}
function renderProjectOptions(){const current=els.newChatProject.value;els.newChatProject.replaceChildren(option('', 'General chat'),...state.projects.map((p)=>option(p.id,p.name+(p.missing?' (folder missing)':''))));if([...els.newChatProject.options].some((item)=>item.value===current))els.newChatProject.value=current;}
function option(value,label){const item=document.createElement('option');item.value=value;item.textContent=label;return item;}

async function openSettings(){state.provider=await window.cuppet.settings.get();els.baseUrl.value=state.provider.baseUrl||'https://api.openai.com/v1';els.model.value=state.provider.model||'';els.backgroundModel.value=state.provider.backgroundModel||'';els.apiKey.value='';els.apiKey.placeholder=state.provider.apiKeyConfigured?'Saved securely · leave blank to keep it':'API key';els.settingsNote.textContent=state.provider.encryptionAvailable?'API keys are encrypted with the operating system credential store before persistence. Background model defaults to the primary model when blank.':'OS credential encryption is unavailable. Cuppet will refuse to persist an API key in plaintext.';els.settingsDialog.showModal();}
async function saveSettings(event){event.preventDefault();try{state.provider=await window.cuppet.settings.save({baseUrl:els.baseUrl.value,model:els.model.value,backgroundModel:els.backgroundModel.value,apiKey:els.apiKey.value});renderProvider();els.settingsDialog.close();toast('Provider settings saved.');}catch(error){els.settingsNote.textContent=error.message||String(error);}}
function renderProvider(){els.providerPill.textContent=state.provider?.apiKeyConfigured&&state.provider?.model?state.provider.model:'Provider not configured';}
function toast(message){els.toast.textContent=message;els.toast.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>els.toast.classList.add('hidden'),4500);}
function resizePrompt(){els.prompt.style.height='auto';els.prompt.style.height=`${Math.min(180,Math.max(54,els.prompt.scrollHeight))}px`;}
function relativeTime(timestamp){if(!timestamp)return'';const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));if(seconds<60)return'Just now';if(seconds<3600)return`${Math.floor(seconds/60)}m ago`;if(seconds<86400)return`${Math.floor(seconds/3600)}h ago`;return new Date(timestamp).toLocaleDateString();}
function statusLabel(status){if(status==='streaming')return'Generating…';if(status==='stopped')return'Stopped';if(status==='interrupted')return'Interrupted by restart';if(status==='error')return'Generation failed';return status;}
function cssEscape(value){return window.CSS?.escape?window.CSS.escape(value):value.replace(/[^a-zA-Z0-9_-]/g,'\\$&');}

els.newChat.addEventListener('click',()=>void openNewChatDialog());els.newChatForm.addEventListener('submit',(event)=>{event.preventDefault();els.newChatDialog.close();startDraft(els.newChatProject.value||null);});els.newChatClose.addEventListener('click',()=>els.newChatDialog.close());els.newChatCancel.addEventListener('click',()=>els.newChatDialog.close());
els.addProject.addEventListener('click',()=>void openAddProject());els.addProjectClose.addEventListener('click',()=>els.addProjectDialog.close());els.addLocalProject.addEventListener('click',()=>void addLocalProject());els.cloneUrlProject.addEventListener('click',()=>void cloneUrlProject());els.loadGithubRepos.addEventListener('click',()=>void loadGithubRepos());els.githubSearch.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();void loadGithubRepos();}});
els.composer.addEventListener('submit',(event)=>{event.preventDefault();void sendCurrentMessage();});els.prompt.addEventListener('input',resizePrompt);els.prompt.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void sendCurrentMessage();}});els.stop.addEventListener('click',()=>void stopCurrent());
els.modeToggle.addEventListener('click',()=>void toggleMode());els.orchestratorToggle.addEventListener('click',()=>void toggleOrchestrator());els.backgroundToggle.addEventListener('click',()=>void toggleBackground());
els.settingsButton.addEventListener('click',()=>void openSettings());els.settingsForm.addEventListener('submit',saveSettings);els.settingsClose.addEventListener('click',()=>els.settingsDialog.close());els.settingsCancel.addEventListener('click',()=>els.settingsDialog.close());
void init();