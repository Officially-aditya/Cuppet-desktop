from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {actual}: {old[:180]!r}")
    p.write_text(text.replace(old, new, count))


# ChatPane: expose one Build / Plan / Orchestrate control instead of the
# while-running Queue / Steer segmented buttons. Queue/steer remains a General
# Settings delivery preference and therefore keeps its runtime semantics.
replace(
    'src/renderer/react/ChatPane.tsx',
    "export type DeliveryMode = 'queue' | 'steer';\n",
    "export type DeliveryMode = 'queue' | 'steer';\nexport type ComposerMode = 'build' | 'plan' | 'orchestrate';\n",
)
replace(
    'src/renderer/react/ChatPane.tsx',
    "  mode: 'plan' | 'build';\n  running: boolean;\n  commands: CommandDefinition[];\n  activity: ActivityEntry[];\n  onSend: (text: string, deliveryMode: DeliveryMode, attachments: Attachment[]) => Promise<{ clear: boolean; commandResult?: CommandResult }>;\n  onStop: () => void | Promise<void>;\n  onToggleMode: () => void | Promise<void>;\n};\n\nexport function ChatPane({ session, draft, project, mode, running, commands, activity: _activity, onSend, onStop }: Props) {",
    "  mode: 'plan' | 'build';\n  activeMode: ComposerMode;\n  running: boolean;\n  commands: CommandDefinition[];\n  activity: ActivityEntry[];\n  onSend: (text: string, deliveryMode: DeliveryMode, attachments: Attachment[]) => Promise<{ clear: boolean; commandResult?: CommandResult }>;\n  onStop: () => void | Promise<void>;\n  onModeChange: (mode: ComposerMode) => void | Promise<void>;\n};\n\nexport function ChatPane({ session, draft, project, mode, activeMode, running, commands, activity: _activity, onSend, onStop, onModeChange }: Props) {",
)
replace(
    'src/renderer/react/ChatPane.tsx',
    "  const queuedCount = session?.id ? queuedBySession[session.id]?.length ?? 0 : 0;\n",
    "",
)
replace(
    'src/renderer/react/ChatPane.tsx',
    "            placeholder={running ? (deliveryMode === 'steer' ? 'Steer the active run…' : 'Queue a message…') : 'Message Cuppet…'}",
    "            placeholder=\"Message Cuppet…\"",
)
replace(
    'src/renderer/react/ChatPane.tsx',
    "            {running && (\n              <div className=\"delivery-controls react-delivery-controls\" aria-label=\"While running\">\n                <button type=\"button\" className={`delivery-mode-button${deliveryMode === 'queue' ? ' active' : ''}`} onClick={() => setDeliveryMode('queue')}>Queue{queuedCount ? ` · ${queuedCount}` : ''}</button>\n                <button type=\"button\" className={`delivery-mode-button${deliveryMode === 'steer' ? ' active' : ''}`} onClick={() => setDeliveryMode('steer')}>Steer</button>\n              </div>\n            )}",
    "            <select\n              className=\"composer-mode-select\"\n              aria-label=\"Mode\"\n              title=\"Mode\"\n              value={activeMode}\n              onChange={(event) => void onModeChange(event.currentTarget.value as ComposerMode)}\n            >\n              <option value=\"build\">Build</option>\n              <option value=\"plan\">Plan</option>\n              <option value=\"orchestrate\">Orchestrate</option>\n            </select>",
)

# App: project the existing session plan/build mode + global orchestrator into
# one composer mode selector. Orchestrate always executes from build mode;
# selecting Build or Plan turns orchestrator back off.
replace(
    'src/renderer/react/App.tsx',
    "import { ChatPane, type ActivityEntry, type DeliveryMode } from './ChatPane';",
    "import { ChatPane, type ActivityEntry, type ComposerMode, type DeliveryMode } from './ChatPane';",
)
replace(
    'src/renderer/react/App.tsx',
    "  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;\n  const activeRunning = Boolean(active?.id && running.has(active.id));",
    "  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;\n  const activeRunning = Boolean(active?.id && running.has(active.id));\n  const activeComposerMode: ComposerMode = cognitive.orchestratorEnabled ? 'orchestrate' : mode;",
)
replace(
    'src/renderer/react/App.tsx',
    "  const changeMode = useCallback(async () => {\n    const next = mode === 'plan' ? 'build' : 'plan';\n    try {\n      if (active) await window.cuppet.cognitive.modeSet(active.id, next);\n      else setDraft((current) => current ? { ...current, mode: next } : current);\n      setMode(next);\n    } catch (error) { showToast(error); }\n  }, [active, mode, showToast]);",
    "  const changeMode = useCallback(async (next: ComposerMode) => {\n    const sessionMode: 'plan' | 'build' = next === 'plan' ? 'plan' : 'build';\n    const orchestratorEnabled = next === 'orchestrate';\n    try {\n      if (active) await window.cuppet.cognitive.modeSet(active.id, sessionMode);\n      else setDraft((current) => current ? { ...current, mode: sessionMode } : current);\n      setMode(sessionMode);\n      await window.cuppet.cognitive.orchestratorSet(orchestratorEnabled);\n      setCognitive((current) => ({ ...current, orchestratorEnabled }));\n    } catch (error) { showToast(error); }\n  }, [active, showToast]);",
)
replace(
    'src/renderer/react/App.tsx',
    "        mode={mode}\n        running={activeRunning}",
    "        mode={mode}\n        activeMode={activeComposerMode}\n        running={activeRunning}",
)
replace(
    'src/renderer/react/App.tsx',
    "        onStop={stop}\n        onToggleMode={changeMode}",
    "        onStop={stop}\n        onModeChange={changeMode}",
)

# Composer styling: a single compact native select reads like a mode button and
# retains keyboard/native menu behavior on macOS/Windows/Linux.
p = Path('src/renderer/execution.css')
text = p.read_text()
needle = '.delivery-controls+.composer-hint{margin-right:0}'
if text.count(needle) != 1:
    raise SystemExit('src/renderer/execution.css: delivery control anchor not found exactly once')
addition = needle + '.composer-mode-select{min-height:28px;border:1px solid #2b313a;border-radius:7px;background:#11161c;color:#cbd2dc;padding:5px 8px;font:10px/1.2 inherit;cursor:pointer;outline:0;color-scheme:dark}.composer-mode-select:hover{background:#171d24;color:#f0f3f6;border-color:#3b4551}.composer-mode-select:focus-visible{border-color:#526173;box-shadow:0 0 0 2px rgba(130,145,165,.14)}'
p.write_text(text.replace(needle, addition, 1))
