from pathlib import Path


def replace(path, old, new):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


replace(
    "src/renderer/main.tsx",
    "import './workspace-enhancements.css';",
    "import './workspace-enhancements.css';\nimport './tst-memory-sidebar.css';",
)

replace(
    "src/renderer/react/App.tsx",
    "import { ChatPane, type ComposerMode, type DeliveryMode } from './ChatPane';",
    "import { ChatPane, type ComposerMode, type DeliveryMode } from './ChatPane';\nimport { TstMemorySidebar } from './TstMemorySidebar';",
)
replace(
    "src/renderer/react/App.tsx",
    "      <ChatPane\n        session={active}\n        draft={draft}\n        project={activeProject}\n        mode={mode}\n        activeMode={activeComposerMode}\n        running={activeRunning}\n        commands={commands}\n        activity={[]}\n        onSend={send}\n        onStop={stop}\n        onModeChange={changeMode}\n      />",
    "      <ChatPane\n        session={active}\n        draft={draft}\n        project={activeProject}\n        mode={mode}\n        activeMode={activeComposerMode}\n        running={activeRunning}\n        commands={commands}\n        activity={[]}\n        onSend={send}\n        onStop={stop}\n        onModeChange={changeMode}\n      />\n      {active?.projectId && <TstMemorySidebar sessionId={active.id} projectName={activeProject?.name} running={activeRunning} />}",
)

replace(
    "src/preload/preload.cjs",
    "    memoryQuery: (sessionId, query) => ipcRenderer.invoke('cuppet:memory:query', sessionId, query),",
    "    memoryQuery: (sessionId, query) => ipcRenderer.invoke('cuppet:memory:query', sessionId, query),\n    memoryGraph: (sessionId) => ipcRenderer.invoke('cuppet:memory:graph', sessionId),",
)

replace(
    "src/main/main.mjs",
    "  ipcMain.handle('cuppet:memory:query', (_event, sessionId, query) => request('memory.query', { sessionId, query }));",
    "  ipcMain.handle('cuppet:memory:query', (_event, sessionId, query) => request('memory.query', { sessionId, query }));\n  ipcMain.handle('cuppet:memory:graph', (_event, sessionId) => request('memory.graph', { sessionId: boundedId(sessionId) }));",
)

replace(
    "src/runtime/service.mjs",
    "import { RunStateProjection } from './run-state-projection.mjs';",
    "import { RunStateProjection } from './run-state-projection.mjs';\nimport { listSessionEditedFiles } from './session-edited-files.mjs';",
)
replace(
    "src/runtime/service.mjs",
    "      case 'memory.query': return this.#queryMemory(params);",
    "      case 'memory.query': return this.#queryMemory(params);\n      case 'memory.graph': return this.#memoryGraph(params);",
)
replace(
    "src/runtime/service.mjs",
    "  async #queryMemory(params) {\n    if (!this.#tst.configured) return { available: false, records: [], reason: 'TST is not configured' };\n    try { return { available: true, records: await this.#tst.queryMemory(params.sessionId, String(params.query ?? ''), params.limit ?? 20) }; }\n    catch (error) { return { available: false, records: [], reason: cleanError(error) }; }\n  }",
    "  async #queryMemory(params) {\n    if (!this.#tst.configured) return { available: false, records: [], reason: 'TST is not configured' };\n    try { return { available: true, records: await this.#tst.queryMemory(params.sessionId, String(params.query ?? ''), params.limit ?? 20) }; }\n    catch (error) { return { available: false, records: [], reason: cleanError(error) }; }\n  }\n  async #memoryGraph(params) {\n    const session = this.requireSession(params.sessionId);\n    const editedFiles = await listSessionEditedFiles(this.#dataDir, session.id);\n    if (!session.projectId) return { available: false, reason: 'TST memory graph requires a project-bound chat', files: [], editedFiles };\n    if (!this.#tst.configured) return { available: false, reason: 'TST is not configured', files: [], editedFiles };\n    try {\n      const workspace = await this.#tst.graphWorkspace(220);\n      return { available: true, ...workspace, editedFiles };\n    } catch (error) {\n      return { available: false, reason: cleanError(error), files: [], editedFiles };\n    }\n  }",
)

# User messages get the same native clipboard affordance as final assistant messages.
replace(
    "src/renderer/react/ChatPane.tsx",
    "  const canCopy = assistant && !live && message.status !== 'streaming' && Boolean(content.trim());",
    "  const canCopy = !live && message.status !== 'streaming' && Boolean(content.trim());",
)
replace(
    "src/renderer/react/ChatPane.tsx",
    "      const rendered = responseRef.current?.innerText?.trim();\n      const value = rendered || content.trim();",
    "      const rendered = assistant ? responseRef.current?.innerText?.trim() : '';\n      const value = rendered || content.trim();",
)
replace(
    "src/renderer/react/ChatPane.tsx",
    "aria-label={copied ? 'Copied' : 'Copy final response'}",
    "aria-label={copied ? 'Copied' : assistant ? 'Copy final response' : 'Copy message'}",
)

replace(
    "src/renderer/react/ChatPane.tsx",
    "        <div key={item.id} className={`thread-activity-line ${item.status}`}>{friendlyActivityLabel({ id: item.id, kind: 'tool', status: item.status, label: item.label, details: item.details })}</div>",
    "        <ToolTraceRow key={item.id} item={item} />",
)

trace_anchor = "function traceForMessage(state: TranscriptState, messageId: string): TraceItem[] {"
trace_component = '''function ToolTraceRow({ item }: { item: TraceTool }) {
  const [open, setOpen] = useState(false);
  const detail = toolActivityDetail(item.tool, item.argumentsJson, item.details);
  return (
    <div className={`thread-tool-row ${item.status}`}>
      <button type="button" className="thread-tool-summary" aria-expanded={open} onClick={() => detail && setOpen((current) => !current)}>
        <span className="thread-tool-status" aria-hidden="true">{item.status === 'running' ? '●' : item.status === 'error' ? '!' : '✓'}</span>
        <span className="thread-tool-label">{item.label}</span>
        {detail ? <span className="thread-tool-chevron" aria-hidden="true">{open ? '−' : '+'}</span> : null}
      </button>
      {open && detail ? <div className="thread-tool-detail">{detail.split('\\n').map((line, index) => <div key={`${item.id}:detail:${index}`}>{line}</div>)}</div> : null}
    </div>
  );
}

'''
replace("src/renderer/react/ChatPane.tsx", trace_anchor, trace_component + trace_anchor)

path = Path("src/renderer/react/ChatPane.tsx")
text = path.read_text()
start = text.index("function toolActivityLabel(toolName = '', argumentsJson = '{}', status: TraceTool['status']) {")
end = text.index("\nfunction toolTargets(toolName: string, args: Record<string, unknown>) {", start)
replacement = '''function toolActivityLabel(toolName = '', argumentsJson = '{}', status: TraceTool['status']) {
  const args = parseToolArguments(argumentsJson);
  const failed = status === 'error';
  const complete = status === 'complete';
  const phrase = (active: string, done: string, error: string) => failed ? error : complete ? done : active;
  const targets = toolTargets(toolName, args);
  const target = describeTargets(targets, args);
  const focus = toolExploreFocus(args);
  const command = toolCommand(args);

  if (toolName === 'workspace_read' || toolName === 'tst_read' || /(^|[_-])read($|[_-])/.test(toolName)) return target
    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)
    : phrase('Reading file…', 'Read file', 'Couldn’t read file');
  if (toolName === 'tst_explore' || /search|grep|find|explore|locate/.test(toolName)) return focus
    ? phrase(`Searching ${focus}…`, `Searched ${focus}`, `Search failed for ${focus}`)
    : phrase('Searching workspace…', 'Searched workspace', 'Workspace search failed');
  if (toolName === 'tst_edit_batch') {
    if (String(args.action ?? '') === 'apply' && !target) return phrase('Applying edit batch…', 'Applied edit batch', 'Edit batch failed');
    return target ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`) : phrase('Editing files…', 'Edited files', 'Couldn’t edit files');
  }
  if (toolName === 'workspace_edit' || /(^|[_-])(edit|patch)($|[_-])/.test(toolName)) return target
    ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
    : phrase('Editing file…', 'Edited file', 'Couldn’t edit file');
  if (toolName === 'workspace_write' || /(^|[_-])(write|create)($|[_-])/.test(toolName)) return target
    ? phrase(`Writing ${target}…`, `Wrote ${target}`, `Couldn’t write ${target}`)
    : phrase('Writing file…', 'Wrote file', 'Couldn’t write file');
  if (toolName === 'tst_validate' || /test|verify|validate|lint|check/.test(toolName)) return target
    ? phrase(`Validating ${target}…`, `Validated ${target}`, `Validation failed for ${target}`)
    : phrase('Running validation…', `${humanToolLabel(toolName)} passed`, `${humanToolLabel(toolName)} failed`);
  if (toolName === 'cuppet_memory_search') return phrase('Searching memory…', 'Searched memory', 'Memory search failed');
  if (toolName === 'cuppet_plan') return phrase('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (toolName === 'bash' || /shell|terminal|command|exec/.test(toolName)) return command
    ? phrase(`Running ${command}…`, `Ran ${command}`, `Command failed: ${command}`)
    : phrase('Running command…', 'Ran command', 'Command failed');
  if (toolName === 'question') return phrase('Waiting for input…', 'Received input', 'Input request failed');

  const name = humanToolLabel(toolName);
  return phrase(`${name}…`, `${name} completed`, `${name} failed`);
}

function toolActivityDetail(toolName: string, argumentsJson: string, runtimeDetails?: string) {
  const args = parseToolArguments(argumentsJson);
  const lines: string[] = [];
  const targets = toolTargets(toolName, args);
  if (targets.length) lines.push(`Target${targets.length === 1 ? '' : 's'}: ${targets.slice(0, 6).join(', ')}${targets.length > 6 ? ` +${targets.length - 6} more` : ''}`);
  const range = toolLineRange(args);
  if (range) lines.push(`Range: ${range}`);
  const query = toolExploreFocus(args);
  if (query && !targets.length) lines.push(`Query: ${query}`);
  const command = toolCommand(args, false);
  if (command) lines.push(`Command: ${command}`);
  const action = typeof args.action === 'string' ? compactActivityText(args.action) : '';
  if (action && !lines.some((line) => line.includes(action))) lines.push(`Action: ${action}`);
  if (runtimeDetails) lines.push(`Result: ${compactActivityText(runtimeDetails)}`);
  if (!lines.length && toolName) lines.push(`Tool: ${humanToolLabel(toolName)}`);
  return lines.join('\\n');
}

function describeTargets(targets: string[], args: Record<string, unknown>) {
  if (!targets.length) return '';
  if (targets.length > 1) return `${targets.length} files`;
  const base = targetName(targets[0]);
  const range = toolLineRange(args);
  return range ? `${base} · ${range}` : base;
}

function toolLineRange(args: Record<string, unknown>) {
  const start = Number(args.start_line ?? args.startLine ?? args.line_start ?? args.offset);
  const end = Number(args.end_line ?? args.endLine ?? args.line_end);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) return `lines ${start}–${end}`;
  if (Number.isFinite(start) && start > 0) return `from line ${start}`;
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0 && (args.path || args.file)) return `up to ${limit} lines`;
  return '';
}

function toolCommand(args: Record<string, unknown>, compact = true) {
  const value = [args.command, args.cmd, args.script].find((item) => typeof item === 'string' && item.trim());
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\\r\\n\\t]+/g, ' ').trim();
  if (!compact) return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
  return normalized.length > 54 ? `${normalized.slice(0, 51)}…` : normalized;
}

function humanToolLabel(value: string) {
  const normalized = String(value || 'tool')
    .replace(/^cuppet[_-]/, '')
    .replace(/^tst[_-]/, 'TST ')
    .replace(/^workspace[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return normalized ? normalized.replace(/\\b\\w/g, (letter) => letter.toUpperCase()) : 'Tool';
}
'''
path.write_text(text[:start] + replacement + text[end:])

replace(
    "src/renderer/react/ChatPane.tsx",
    "  if (toolName === 'tst_read' || toolName === 'workspace_read') {",
    "  add(args.path);\n  add(args.file);\n  add(args.filename);\n  if (Array.isArray(args.paths)) for (const value of args.paths) add(value);\n  if (Array.isArray(args.files)) for (const value of args.files) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);\n\n  if (toolName === 'tst_read' || toolName === 'workspace_read') {",
)

css_path = Path("src/renderer/message-controls.css")
css = css_path.read_text()
css = css.replace('.message.assistant{position:relative}', '.message.assistant,.message.user{position:relative}')
css = css.replace(
    '.message.assistant:hover .message-copy-button,.message.assistant:focus-within .message-copy-button',
    '.message.assistant:hover .message-copy-button,.message.assistant:focus-within .message-copy-button,.message.user:hover .message-copy-button,.message.user:focus-within .message-copy-button',
)
css += '''
.thread-tool-row{margin:2px 0;border-radius:7px}.thread-tool-summary{width:100%;min-height:26px;display:flex;align-items:center;gap:7px;padding:4px 6px;border:0;border-radius:7px;background:transparent;color:#7f8995;text-align:left;font:inherit;cursor:pointer}.thread-tool-summary:hover{background:rgba(255,255,255,.035);color:#aeb8c5}.thread-tool-row.error .thread-tool-summary{color:#c28d8d}.thread-tool-row.running .thread-tool-status{color:#7fc8e6}.thread-tool-status{width:12px;flex:0 0 12px;text-align:center;font-size:9px;color:#6f9b7d}.thread-tool-label{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.thread-tool-chevron{flex:0 0 auto;color:#535d68;font-size:12px}.thread-tool-detail{margin:1px 0 5px 25px;padding:6px 8px;border-left:1px solid #252c35;color:#66717e;font-size:9.5px;line-height:1.55;overflow-wrap:anywhere}
'''
css_path.write_text(css)
