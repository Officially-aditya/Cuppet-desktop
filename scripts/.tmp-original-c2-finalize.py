from pathlib import Path


def replace_once(path, old, new, label):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    path.write_text(text.replace(old, new, 1))


commands = Path('src/runtime/commands.mjs')
replace_once(
    commands,
    "Reviewed replacement for the old OpenCode plan-agent picker.",
    "Reviewed replacement for the legacy plan-agent picker.",
    'legacy runtime label',
)

main = Path('src/main/main.mjs')
replace_once(
    main,
    "  const runtimeCall = async (method, params = {}) => {\n    if (method === 'session.steer') return steerSession(request, params.sessionId, params.text);\n    return request(method, params);\n  };",
    "  const runtimeCall = (method, params = {}) => request(method, params);",
    'desktop runtime authority',
)
text = main.read_text()
start = text.find("async function steerSession(request, sessionId, text) {\n")
end = text.find("function validateProjectPayload(value) {\n", start)
if start < 0 or end < 0:
    raise SystemExit('desktop steer helper markers not found')
main.write_text(text[:start] + text[end:])

remote = Path('src/runtime/remote/commands.mjs')
replace_once(
    remote,
    "        call:async(method,value={})=>method==='session.steer'?this.#sessionSteer(state,sessionId,{instruction:value.text}):this.#call(method,value),",
    "        call:(method,value={})=>this.#call(method,value),",
    'remote slash runtime authority',
)
replace_once(
    remote,
    "  async #sessionSteer(state,explicit,params){\n    const sessionId=this.#requireSession(state,explicit); const instruction=String(params.instruction??params.prompt??'').trim(); if(!instruction)throw new Error('instruction is required');\n    await this.#call('session.stop',{sessionId}).catch(()=>undefined); await waitUntilIdle(this.#call,sessionId);\n    const result=await this.#call('session.send',{sessionId,text:instruction,provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return {...result,steered:true};\n  }",
    "  async #sessionSteer(state,explicit,params){\n    const sessionId=this.#requireSession(state,explicit); const instruction=String(params.instruction??params.prompt??'').trim(); if(!instruction)throw new Error('instruction is required');\n    const result=await this.#call('session.steer',{sessionId,text:instruction,provider:this.#selectedProvider(state)}); state.sessionId=result.sessionId; return {...result,steered:true};\n  }",
    'remote steer authority',
)

app = Path('src/renderer/app.js')
replace_once(
    app,
    "  if(!state.provider?.apiKeyConfigured||!state.provider?.configured||!state.provider?.primary?.modelID){await openSettings();toast('Configure a provider and primary coding model before sending.');return;}",
    "  if(!text.startsWith('/')&&(!state.provider?.apiKeyConfigured||!state.provider?.configured||!state.provider?.primary?.modelID)){await openSettings();toast('Configure a provider and primary coding model before sending.');return;}",
    'provider-free slash commands',
)
replace_once(
    app,
    "  state.active = null; state.draft = { projectId: projectId || null, title: 'New chat', messages: [], mode: 'build' }; state.selectedProjectId = projectId || null; state.sessionMode = 'build';",
    "  state.active = null; state.draft = { projectId: projectId || null, title: 'New chat', messages: [], mode: 'build' }; state.selectedProjectId = projectId || null; state.sessionMode = 'build'; delete document.body.dataset.cuppetSessionId;",
    'draft session projection',
)
replace_once(
    app,
    "  upsertSession(session); state.draft = null; state.active = { ...session, messages: [] }; state.selectedProjectId = session.projectId || null; state.sessionMode = draft.mode || 'build';",
    "  upsertSession(session); state.draft = null; state.active = { ...session, messages: [] }; state.selectedProjectId = session.projectId || null; state.sessionMode = draft.mode || 'build'; document.body.dataset.cuppetSessionId = session.id;",
    'persisted draft session projection',
)
replace_once(
    app,
    "  state.active = session; state.draft = null; state.selectedProjectId = session.projectId || null; state.sessionMode = mode.mode || 'build';",
    "  state.active = session; state.draft = null; state.selectedProjectId = session.projectId || null; state.sessionMode = mode.mode || 'build'; document.body.dataset.cuppetSessionId = session.id;",
    'opened session projection',
)
