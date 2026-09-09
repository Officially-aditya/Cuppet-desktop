from pathlib import Path


def keep_one(text, block):
    first = text.find(block)
    if first < 0:
        raise SystemExit(f'missing block: {block[:80]!r}')
    cursor = first + len(block)
    while True:
        found = text.find(block, cursor)
        if found < 0:
            return text
        text = text[:found] + text[found + len(block):]
        cursor = first + len(block)


def remove_between_second(text, start_marker, end_marker):
    first = text.find(start_marker)
    if first < 0:
        raise SystemExit(f'missing first marker: {start_marker!r}')
    second = text.find(start_marker, first + len(start_marker))
    if second < 0:
        return text
    end = text.find(end_marker, second)
    if end < 0:
        raise SystemExit(f'missing end marker after duplicate: {end_marker!r}')
    text = text[:second] + text[end:]
    if text.find(start_marker, first + len(start_marker)) >= 0:
        return remove_between_second(text, start_marker, end_marker)
    return text


service_path = Path('src/runtime/service.mjs')
service = service_path.read_text()
service = keep_one(service, "import { parseSlashCommand } from './commands.mjs';\n")
service = keep_one(service, "      case 'memory.remember': return this.#rememberMemory(params);\n      case 'memory.forget': return this.#forgetMemory(params);\n      case 'memory.clear': return this.#clearMemory(params);\n")
service = keep_one(service, "    const slash = parseSlashCommand(text);\n    if (slash.kind === 'command') throw new Error(`Slash command /${slash.name} must be executed through the command registry`);\n    if (slash.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${slash.name}`);\n")
service = remove_between_second(service, "  async #rememberMemory(params) {\n", "  async #flushBackground(sessionId) {\n")
service = remove_between_second(service, "  async #steer(params) {\n", "  async #generate(")
service = keep_one(service, "function memoryScope(value) { const scope = String(value ?? 'session').toLowerCase(); return ['session', 'project', 'global'].includes(scope) ? scope : 'session'; }\n")
service_path.write_text(service)

cli_path = Path('src/cli/main.mjs')
cli = cli_path.read_text()
cli = keep_one(cli, "import { executeCommand, listCommands, parseSlashCommand } from '../runtime/commands.mjs';\n")
cli = keep_one(cli, "  else if(command==='commands')showCommands();\n  else if(command==='command')await headlessCommand(flags);\n")
cli = keep_one(cli, "function showCommands(){console.log(JSON.stringify(listCommands(),null,2));}\n")
cli = keep_one(cli, "  const slash=parseSlashCommand(prompt);\n  if(slash.kind==='unknown')throw new Error(`Unknown Cuppet command: /${slash.name}`);\n  if(slash.kind==='command'){await headlessCommand(flags,slash);return;}\n")
cli = remove_between_second(cli, "async function headlessCommand(flags,prepared=null){\n", "function prepareHeadlessSession({databasePath,dataDir,flags}){\n")
cli = cli.replace("  cuppet command \\\"/status\\\" [--session id|-s id] [--json]\\n  cuppet commands\\n  cuppet command \\\"/status\\\" [--session id|-s id] [--json]\\n  cuppet commands\\n", "  cuppet command \\\"/status\\\" [--session id|-s id] [--json]\\n  cuppet commands\\n")
cli_path.write_text(cli)
