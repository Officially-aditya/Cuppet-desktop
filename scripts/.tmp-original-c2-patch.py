from pathlib import Path

p = Path('src/runtime/service.mjs')
s = p.read_text()

s = s.replace("import { ProjectWriter } from './project-writer.mjs';\n", "import { ProjectWriter } from './project-writer.mjs';\nimport { parseSlashCommand } from './commands.mjs';\n")

s = s.replace("      case 'memory.query': return this.#queryMemory(params);\n", "      case 'memory.query': return this.#queryMemory(params);\n      case 'memory.remember': return this.#rememberMemory(params);\n      case 'memory.forget': return this.#forgetMemory(params);\n      case 'memory.clear': return this.#clearMemory(params);\n")

s = s.replace("      case 'session.send': return this.send(params);\n      case 'session.stop': return this.stop(params.sessionId);\n", "      case 'session.send': return this.send(params);\n      case 'session.steer': return this.#steer(params);\n      case 'session.stop': return this.stop(params.sessionId);\n")

needle = "  async #queryMemory(params) {\n    if (!this.#tst.configured) return { available: false, records: [], reason: 'TST is not configured' };\n    try { return { available: true, records: await this.#tst.queryMemory(params.sessionId, String(params.query ?? ''), params.limit ?? 20) }; }\n    catch (error) { return { available: false, records: [], reason: cleanError(error) }; }\n  }\n"
addition = needle + "  async #rememberMemory(params) {\n    const session = this.requireSession(params.sessionId);\n    if (!this.#tst.configured) throw new Error('TST is not configured');\n    const key = String(params.key ?? '').trim().slice(0, 240);\n    const value = String(params.value ?? '').trim().slice(0, 4000);\n    if (!key || !value) throw new Error('memory remember requires key and value');\n    return this.#tst.rememberMemory(session.id, { key, value, scope: memoryScope(params.scope), pinned: params.pinned === true });\n  }\n  async #forgetMemory(params) {\n    const session = this.requireSession(params.sessionId);\n    if (!this.#tst.configured) throw new Error('TST is not configured');\n    const key = String(params.key ?? '').trim().slice(0, 240);\n    if (!key) throw new Error('memory forget requires key');\n    return this.#tst.forgetMemory(session.id, key);\n  }\n  async #clearMemory(params) {\n    const session = this.requireSession(params.sessionId);\n    if (!this.#tst.configured) throw new Error('TST is not configured');\n    return this.#tst.clearMemory(session.id, memoryScope(params.scope));\n  }\n"
if needle not in s:
    raise SystemExit('queryMemory insertion point not found')
s = s.replace(needle, addition)

needle = "  async send(params) {\n    const sourceSessionId = params.sessionId; const text = typeof params.text === 'string' ? params.text.trim() : '';\n    if (!text) throw new Error('message text is required');\n"
replacement = needle + "    const slash = parseSlashCommand(text);\n    if (slash.kind === 'command') throw new Error(`Slash command /${slash.name} must be executed through the command registry`);\n    if (slash.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${slash.name}`);\n"
if needle not in s:
    raise SystemExit('send insertion point not found')
s = s.replace(needle, replacement)

needle = "  stop(sessionId) {\n    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');\n    const run = this.#runs.get(sessionId); if (!run) return { stopped: false, sessionId };\n    run.controller.abort(); return { stopped: true, sessionId, messageId: run.assistantId, projectId: run.projectId };\n  }\n\n"
replacement = needle + "  async #steer(params) {\n    const sessionId = String(params.sessionId ?? '');\n    const text = typeof params.text === 'string' ? params.text.trim() : '';\n    if (!sessionId) throw new Error('sessionId is required');\n    if (!text) throw new Error('steer text is required');\n    this.requireSession(sessionId);\n    if (this.#runs.has(sessionId)) this.stop(sessionId);\n    for (let attempt = 0; attempt < 250; attempt++) {\n      if (!this.#runs.has(sessionId)) return this.send({ sessionId, text, provider: params.provider ?? {} });\n      await new Promise((resolve) => setTimeout(resolve, 20));\n    }\n    throw new Error('session did not stop before steer');\n  }\n\n"
if needle not in s:
    raise SystemExit('stop insertion point not found')
s = s.replace(needle, replacement)

s = s.replace("function safeStoreName(value) { return String(value ?? 'general').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'general'; }\n", "function safeStoreName(value) { return String(value ?? 'general').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'general'; }\nfunction memoryScope(value) { const scope = String(value ?? 'session').toLowerCase(); return ['session', 'project', 'global'].includes(scope) ? scope : 'session'; }\n")

p.write_text(s)
