(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let hostId = params.get('host') || localStorage.getItem('cuppet.remote.host') || '';
  let creds = hostId ? readCreds(hostId) : null;
  let ws; let authed = false; let reconnectTimer; let reconnectAttempt = 0; let commandCounter = 0; let activeSession = null; let currentMode = 'build'; let liveAssistant; let remoteModels = [];
  const pendingCommands = new Map();

  const pairScreen = $('pair'); const appScreen = $('app');
  $('pair-code').value = params.get('code') || '';
  $('pair-name').value = localStorage.getItem('cuppet.remote.name') || `browser-${Math.floor(Math.random()*900+100)}`;
  $('pair-submit').addEventListener('click', () => void pairNow());
  $('refresh').addEventListener('click', () => void bootstrap());
  $('workspace').addEventListener('change', () => void attachWorkspace($('workspace').value));
  $('session').addEventListener('change', () => void resumeSession($('session').value));
  $('new-session').addEventListener('click', () => void newSession());
  $('plan').addEventListener('click', () => void togglePlan());
  $('undo').addEventListener('click', () => void undoSession());
  $('model').addEventListener('change', () => void selectModel());
  $('effort').addEventListener('change', () => void selectEffort());
  $('stop').addEventListener('click', () => void command('session.abort').catch(showError));
  $('send').addEventListener('click', () => void sendPrompt());
  $('prompt').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt(); } });

  if (!hostId || !creds) showPair(); else connect();
  navigator.serviceWorker?.register('/app/sw.js').catch(() => undefined);

  function wsBase() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`; }
  function readCreds(host) { try { return JSON.parse(localStorage.getItem(`cuppet.remote.device.${host}`) || 'null'); } catch { return null; } }
  function showPair(message = '') { pairScreen.classList.remove('hidden'); appScreen.classList.add('hidden'); $('pair-error').textContent = message; }
  function showApp() { pairScreen.classList.add('hidden'); appScreen.classList.remove('hidden'); }
  function setDot(mode) { $('dot').className = `dot ${mode}`; }
  function showError(error) { addBubble('system', `Error: ${error instanceof Error ? error.message : String(error)}`); }

  async function pairNow() {
    const code = $('pair-code').value.trim().toUpperCase(); const name = $('pair-name').value.trim() || 'browser';
    if (!hostId) { $('pair-error').textContent = 'The pairing URL is missing a host id.'; return; }
    if (!code) { $('pair-error').textContent = 'Enter the pairing code.'; return; }
    $('pair-error').textContent = 'Pairing…';
    const placeholder = `pair-${Math.random().toString(36).slice(2,10)}`;
    try {
      const result = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`${wsBase()}?role=device&hostId=${encodeURIComponent(hostId)}&deviceId=${placeholder}`); let settled = false;
        const timeout = setTimeout(() => { if (!settled) reject(new Error('Pairing timed out.')); try { socket.close(); } catch {} }, 10000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({version:1,type:'device.pair',ts:Date.now(),payload:{code,name}})));
        socket.addEventListener('message', (event) => { let frame; try { frame=JSON.parse(String(event.data)); } catch { return; } if (frame.replyTo !== 'device-pair') return; settled=true;clearTimeout(timeout);frame.ok?resolve(frame.result):reject(new Error(frame.error||'Pairing failed.'));try{socket.close();}catch{} });
        socket.addEventListener('close', () => { if (!settled) { clearTimeout(timeout); reject(new Error('Connection closed during pairing.')); } });
      });
      creds = {deviceId:result.deviceId,secret:result.secret}; localStorage.setItem(`cuppet.remote.device.${hostId}`,JSON.stringify(creds)); localStorage.setItem('cuppet.remote.host',hostId); localStorage.setItem('cuppet.remote.name',name); connect();
    } catch (error) { $('pair-error').textContent = error.message; }
  }

  function connect() {
    clearTimeout(reconnectTimer); if (!hostId || !creds) return showPair(); setDot('off');
    ws = new WebSocket(`${wsBase()}?role=device&hostId=${encodeURIComponent(hostId)}&deviceId=${encodeURIComponent(creds.deviceId)}`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({version:1,type:'device.hello',deviceId:creds.deviceId,ts:Date.now(),payload:{deviceId:creds.deviceId,secret:creds.secret}})));
    ws.addEventListener('message', (event) => { let frame; try {frame=JSON.parse(String(event.data));} catch {return;} void handleFrame(frame); });
    ws.addEventListener('close', (event) => { authed=false;setDot('err');if(event.code===4004){localStorage.removeItem(`cuppet.remote.device.${hostId}`);creds=null;return showPair('This device was rejected or revoked.');}const delay=Math.min(30000,1000*2**Math.min(++reconnectAttempt,5));reconnectTimer=setTimeout(connect,delay); });
  }

  async function handleFrame(frame) {
    if (frame.replyTo !== undefined) {
      if (frame.replyTo === 'device-hello') {
        if (!frame.ok) { localStorage.removeItem(`cuppet.remote.device.${hostId}`); creds=null; return showPair(frame.error || 'Credentials rejected.'); }
        authed=true;reconnectAttempt=0;setDot('on');showApp();await bootstrap();return;
      }
      const pending=pendingCommands.get(frame.replyTo);if(pending){clearTimeout(pending.timer);pendingCommands.delete(frame.replyTo);frame.ok?pending.resolve(frame.result):pending.reject(new Error(frame.error||'Command failed.'));}return;
    }
    switch(frame.type){
      case 'host.attach': applyAttach(frame.payload); break;
      case 'assistant.text.delta': ensureAssistant().textContent += String(frame.payload?.text ?? ''); scrollEnd(); break;
      case 'tool.started': addTool(`Tool: ${frame.payload?.name ?? 'tool'}`); break;
      case 'tool.completed': addTool(`${frame.payload?.success ? '✓' : '✕'} ${frame.payload?.name ?? 'tool'}${frame.payload?.paths?.length ? ` · ${frame.payload.paths.join(', ')}` : ''}`); break;
      case 'permission.requested': renderPermission(frame.payload?.request); break;
      case 'permission.resolved': document.querySelector(`[data-permission="${cssEscape(frame.payload?.requestID)}"]`)?.remove(); break;
      case 'question.requested': renderQuestion(frame.payload?.request); break;
      case 'question.resolved': document.querySelector(`[data-question="${cssEscape(frame.payload?.requestID)}"]`)?.remove(); break;
      case 'session.idle': liveAssistant=null; await refreshSession(); break;
      case 'session.updated': if (frame.payload?.sessionID) activeSession=frame.payload.sessionID; await refreshSessions(); break;
      case 'agent.error': addBubble('system', `Error: ${frame.payload?.message ?? 'runtime error'}`); break;
      default: break;
    }
  }

  function command(type,payload={}) {
    if (!authed || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Remote host is not connected.'));
    return new Promise((resolve,reject)=>{const id=`c${Date.now().toString(36)}-${++commandCounter}`;const timer=setTimeout(()=>{pendingCommands.delete(id);reject(new Error(`${type} timed out.`));},10000);pendingCommands.set(id,{resolve,reject,timer});ws.send(JSON.stringify({version:1,id,type,ts:Date.now(),...(activeSession?{sessionId:activeSession}:{}),payload}));});
  }

  async function bootstrap() {
    try {
      const host = await command('host.get'); $('host').textContent = `${host.name || 'Cuppet'} · ${host.hostId}`;
      await refreshWorkspaces(); await refreshSessions(); await refreshSession(); await refreshInteractive(); await refreshModels();
    } catch (error) { showError(error); }
  }
  function applyAttach(payload) {
    if (payload?.host) $('host').textContent = `${payload.host.name || 'Cuppet'} · ${payload.host.hostId}`;
    if (Array.isArray(payload?.workspaces)) renderWorkspaces(payload.workspaces);
    if (Array.isArray(payload?.permissions)) { for (const request of payload.permissions) renderPermission(request); }
  }
  async function refreshWorkspaces(){renderWorkspaces(await command('workspace.list').catch(()=>[]));}
  function renderWorkspaces(values){const select=$('workspace');const before=select.value;select.replaceChildren();for(const workspace of values){const option=document.createElement('option');option.value=workspace.workspaceId;option.textContent=workspace.name+(workspace.missing?' (missing)':'');select.append(option);}if(before&&[...select.options].some((o)=>o.value===before))select.value=before;else if(select.value)void attachWorkspace(select.value);}
  async function attachWorkspace(id){if(!id)return;await command('workspace.attach',{workspaceId:id});activeSession=null;await refreshSessions();await refreshSession();await refreshInteractive();}
  async function refreshSessions(){const list=await command('session.list').catch(()=>[]);const select=$('session');select.replaceChildren();for(const session of list){const option=document.createElement('option');option.value=session.id;option.textContent=session.title||session.id;select.append(option);}if(activeSession&&[...select.options].some((o)=>o.value===activeSession))select.value=activeSession;else if(select.value){activeSession=select.value;await command('session.resume',{sessionID:activeSession}).catch(()=>undefined);} }
  async function resumeSession(id){if(!id)return;await command('session.resume',{sessionID:id});activeSession=id;await refreshSession();await refreshInteractive();}
  async function newSession(){const result=await command('session.new');activeSession=result.id;await refreshSessions();await refreshSession();await refreshInteractive();}
  async function refreshSession(){if(!activeSession){$('transcript').replaceChildren();return;}try{const [snap,messages]=await Promise.all([command('session.snapshot'),command('session.messages')]);currentMode=snap.mode||'build';$('plan').textContent=currentMode==='plan'?'Plan':'Build';renderMessages(messages||[]);}catch{} }

  async function refreshModels(){
    remoteModels=await command('model.list').catch(()=>[]);
    const select=$('model');const before=select.value;select.replaceChildren();
    for(const model of remoteModels){const option=document.createElement('option');option.value=`${model.providerID}|${model.modelID}`;option.textContent=model.name||model.modelID;if(model.selected)option.selected=true;select.append(option);}
    if(before&&[...select.options].some((option)=>option.value===before)&&!remoteModels.some((model)=>model.selected))select.value=before;
    renderEfforts();
  }
  function renderEfforts(){
    const [providerID,modelID]=$('model').value.split('|');const model=remoteModels.find((item)=>item.providerID===providerID&&item.modelID===modelID);const select=$('effort');const current=model?.selectedVariant||'';
    select.replaceChildren(makeOption('','Default effort'),...(model?.variants||[]).map((value)=>makeOption(value,value)));
    select.disabled=!model?.variants?.length;if(current&&(model?.variants||[]).includes(current))select.value=current;
  }
  async function selectModel(){const [providerID,modelID]=$('model').value.split('|');if(!modelID)return;try{await command('model.select',{providerID,modelID});await refreshModels();}catch(showError);}
  async function selectEffort(){const [providerID,modelID]=$('model').value.split('|');if(!modelID)return;try{const payload={providerID,modelID,...($('effort').value?{variant:$('effort').value}:{})};await command('model.select',payload);await refreshModels();}catch(showError);}
  function makeOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option;}

  async function togglePlan(){if(!activeSession)return;const next=currentMode==='plan'?'build':'plan';await command('agent.mode.set',{mode:next});currentMode=next;$('plan').textContent=next==='plan'?'Plan':'Build';}
  async function undoSession(){if(!activeSession)return;try{const result=await command('session.undo');addBubble('system',result?.undone?`Undid ${result.path || 'latest Cuppet mutation'}.`:(result?.reason||'Nothing to undo.'));await refreshSession();}catch(showError);}
  async function sendPrompt(){let text=$('prompt').value.trim();if(!text)return;if(!activeSession)await newSession();$('prompt').value='';addBubble('user',text);liveAssistant=null;try{const result=await command('session.submit',{prompt:text});if(result?.sessionId&&result.sessionId!==activeSession){activeSession=result.sessionId;await refreshSessions();}}catch(showError);}

  async function refreshInteractive(){
    const [permissions,questions]=await Promise.all([command('permission.list').catch(()=>[]),command('question.list').catch(()=>[])]);
    $('pending').replaceChildren();for(const request of permissions)renderPermission(request);for(const request of questions)renderQuestion(request);
  }
  async function refreshPermissions(){const values=await command('permission.list').catch(()=>[]);for(const node of [...$('pending').querySelectorAll('[data-permission]')])node.remove();for(const request of values)renderPermission(request);}
  function renderPermission(request){if(!request?.id||document.querySelector(`[data-permission="${cssEscape(request.id)}"]`))return;const row=document.createElement('div');row.className='permission';row.dataset.permission=request.id;const text=document.createElement('div');text.textContent=`${request.action || 'action'} · ${(request.resources||[]).join(', ')}`;const actions=document.createElement('div');actions.className='actions';for(const [label,reply] of [['Allow','once'],['Always exact','always'],['Reject','reject']]){const button=document.createElement('button');button.textContent=label;button.addEventListener('click',async()=>{try{await command('permission.reply',{requestID:request.id,reply});row.remove();}catch(showError);});actions.append(button);}row.append(text,actions);$('pending').append(row);}
  function renderQuestion(request){
    if(!request?.id||document.querySelector(`[data-question="${cssEscape(request.id)}"]`))return;
    const row=document.createElement('div');row.className='permission question';row.dataset.question=request.id;
    const title=document.createElement('strong');title.textContent='Cuppet needs your input';row.append(title);
    const groups=[];
    for(const [index,question] of (request.questions||[]).entries()){
      const group=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=question.header||`Question ${index+1}`;const prompt=document.createElement('p');prompt.textContent=question.question||'';group.append(legend,prompt);
      const options=Array.isArray(question.options)?question.options:[];
      if(options.length){for(const option of options){const label=document.createElement('label');const input=document.createElement('input');input.type=question.multiple?'checkbox':'radio';input.name=`remote-question-${request.id}-${index}`;input.value=String(option.label||'').slice(0,512);const text=document.createElement('span');text.textContent=option.description?`${option.label} — ${option.description}`:option.label;label.append(input,text);group.append(label);}}
      else{const input=document.createElement('textarea');input.rows=2;input.maxLength=512;input.placeholder='Type your answer…';group.append(input);}
      groups.push({group,question});row.append(group);
    }
    const note=document.createElement('div');note.className='error';const actions=document.createElement('div');actions.className='actions';const answer=document.createElement('button');answer.textContent='Answer';const reject=document.createElement('button');reject.textContent='Reject';
    answer.addEventListener('click',async()=>{const answers=groups.map(({group,question},index)=>{const options=Array.isArray(question.options)?question.options:[];if(options.length)return[...group.querySelectorAll(`input[name="remote-question-${cssEscape(request.id)}-${index}"]:checked`)].map((input)=>input.value).slice(0,12);const value=group.querySelector('textarea')?.value.trim()||'';return value?[value.slice(0,512)]:[];});if(answers.some((group)=>!group.length)){note.textContent='Answer every question first.';return;}setQuestionBusy(row,true);try{await command('question.reply',{requestID:request.id,answers});row.remove();}catch(error){note.textContent=error.message||String(error);setQuestionBusy(row,false);}});
    reject.addEventListener('click',async()=>{setQuestionBusy(row,true);try{await command('question.reject',{requestID:request.id});row.remove();}catch(error){note.textContent=error.message||String(error);setQuestionBusy(row,false);}});
    actions.append(answer,reject);row.append(note,actions);$('pending').append(row);
  }
  function setQuestionBusy(row,busy){for(const input of row.querySelectorAll('input,textarea,button'))input.disabled=busy;}
  function renderMessages(messages){$('transcript').replaceChildren();liveAssistant=null;for(const message of messages){if(message.role==='system')continue;addBubble(message.role==='user'?'user':'assistant',message.content||'');}}
  function addBubble(kind,text){const node=document.createElement('div');node.className=`bubble ${kind}`;node.textContent=text;$('transcript').append(node);scrollEnd();return node;}
  function ensureAssistant(){if(!liveAssistant||!liveAssistant.isConnected)liveAssistant=addBubble('assistant','');return liveAssistant;}
  function addTool(text){const node=document.createElement('div');node.className='tool';node.textContent=text;$('transcript').append(node);scrollEnd();}
  function scrollEnd(){const transcript=$('transcript');transcript.scrollTop=transcript.scrollHeight;}
  function cssEscape(value){return String(value ?? '').replace(/[^A-Za-z0-9_-]/g,'_');}
})();
