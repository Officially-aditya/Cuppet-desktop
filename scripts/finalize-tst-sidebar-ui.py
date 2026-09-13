from pathlib import Path


def replace(path, old, new):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new, 1))


# Consume one runtime-owned graph+mutation snapshot instead of racing two IPC reads.
replace(
    "src/renderer/react/TstMemorySidebar.tsx",
    "      const api = window.cuppet as any;\n      const [graph, editedFiles] = await Promise.all([\n        api.cognitive.memoryGraph(sessionId).catch((error: unknown) => ({ available: false, reason: cleanError(error) })),\n        api.sessions.editedFiles(sessionId).catch(() => []),\n      ]);\n      setSnapshot({\n        ...(graph && typeof graph === 'object' ? graph : {}),\n        editedFiles: Array.isArray(editedFiles) ? editedFiles : [],\n      });",
    "      const api = window.cuppet as any;\n      const graph = await api.cognitive.memoryGraph(sessionId).catch((error: unknown) => ({ available: false, reason: cleanError(error), files: [], editedFiles: [] }));\n      setSnapshot(graph && typeof graph === 'object' ? graph : { available: false, reason: 'TST graph returned an invalid snapshot', files: [], editedFiles: [] });",
)

path = Path("src/renderer/react/ChatPane.tsx")
text = path.read_text()

text = text.replace(
    "  const args = parseToolArguments(argumentsJson);\n  const failed = status === 'error';",
    "  const args = parseToolArguments(argumentsJson);\n  const normalizedTool = toolName.toLowerCase();\n  const failed = status === 'error';",
    1,
)
for old, new in [
    ("if (toolName === 'workspace_read' || toolName === 'tst_read' || /(^|[_-])read($|[_-])/.test(toolName))", "if (normalizedTool === 'workspace_read' || normalizedTool === 'tst_read' || /(^|[_-])read($|[_-])/.test(normalizedTool))"),
    ("if (toolName === 'tst_explore' || /search|grep|find|explore|locate/.test(toolName))", "if (normalizedTool === 'tst_explore' || /search|grep|find|explore|locate/.test(normalizedTool))"),
    ("if (toolName === 'tst_edit_batch')", "if (normalizedTool === 'tst_edit_batch')"),
    ("if (toolName === 'workspace_edit' || /(^|[_-])(edit|patch)($|[_-])/.test(toolName))", "if (normalizedTool === 'workspace_edit' || /(^|[_-])(edit|patch)($|[_-])/.test(normalizedTool))"),
    ("if (toolName === 'workspace_write' || /(^|[_-])(write|create)($|[_-])/.test(toolName))", "if (normalizedTool === 'workspace_write' || /(^|[_-])(write|create)($|[_-])/.test(normalizedTool))"),
    ("if (toolName === 'tst_validate' || /test|verify|validate|lint|check/.test(toolName))", "if (normalizedTool === 'tst_validate' || /test|verify|validate|lint|check/.test(normalizedTool))"),
    ("if (toolName === 'cuppet_memory_search')", "if (normalizedTool === 'cuppet_memory_search')"),
    ("if (toolName === 'cuppet_plan')", "if (normalizedTool === 'cuppet_plan')"),
    ("if (toolName === 'bash' || /shell|terminal|command|exec/.test(toolName))", "if (normalizedTool === 'bash' || /shell|terminal|command|exec/.test(normalizedTool))"),
    ("if (toolName === 'question')", "if (normalizedTool === 'question')"),
]:
    if old not in text:
        raise SystemExit(f"missing tool label anchor: {old}")
    text = text.replace(old, new, 1)

text = text.replace(
    "  if (targets.length > 1) return `${targets.length} files`;\n  const base = targetName(targets[0]);",
    "  if (targets.length > 1) {\n    const names = targets.slice(0, 3).map(targetName);\n    if (targets.length <= 3) return names.join(', ');\n    return `${targets.length} files · ${names.slice(0, 2).join(', ')} +${targets.length - 2}`;\n  }\n  const base = targetName(targets[0]);",
    1,
)

text = text.replace(
    "  add(args.path);\n  add(args.file);\n  add(args.filename);",
    "  add(args.path);\n  add(args.file);\n  add(args.filename);\n  add(args.file_path);\n  add(args.filePath);\n  add(args.filepath);\n  add(args.target);",
    1,
)
text = text.replace(
    "  if (Array.isArray(args.files)) for (const value of args.files) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);",
    "  if (Array.isArray(args.files)) for (const value of args.files) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);\n  if (Array.isArray(args.targets)) for (const value of args.targets) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);",
    1,
)

text = text.replace(
    "  const query = typeof args.query === 'string' ? args.query.trim() : '';\n  if (query) return compactActivityText(query);\n  return '';",
    "  const query = [args.query, args.pattern, args.search, args.needle].find((value) => typeof value === 'string' && value.trim());\n  if (typeof query === 'string') return compactActivityText(query);\n  return '';",
    1,
)

text = text.replace(
    "  const value = [args.command, args.cmd, args.script].find((item) => typeof item === 'string' && item.trim());\n  if (typeof value !== 'string') return '';\n  const normalized = value.replace(/[\\r\\n\\t]+/g, ' ').trim();",
    "  const value = [args.command, args.cmd, args.script].find((item) => (typeof item === 'string' && item.trim()) || (Array.isArray(item) && item.length));\n  if (value === undefined) return '';\n  const raw = Array.isArray(value) ? value.map(String).join(' ') : String(value);\n  const normalized = raw.replace(/[\\r\\n\\t]+/g, ' ').trim();",
    1,
)

path.write_text(text)
