import { readFile } from 'node:fs/promises'

const manifestPath = new URL('../migration/cuppet-source-baseline.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

const allowed = new Set(['preserve', 'preserve-equivalent', 'replace-reviewed', 'drop-reviewed'])
const errors = []
const assert = (condition, message) => { if (!condition) errors.push(message) }
const unique = (items, key, label) => {
  const seen = new Set()
  for (const item of items) {
    const value = item[key]
    if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}
const requireDisposition = (items, label) => {
  assert(Array.isArray(items) && items.length > 0, `${label} must be non-empty`)
  for (const item of items ?? []) {
    assert(allowed.has(item.disposition), `${label} ${item.id ?? item.name ?? item.method ?? item.slash ?? '?'} has invalid disposition`)
  }
}
const requireIds = (items, key, expected, label) => {
  const found = new Set(items.map((item) => item[key]))
  for (const id of expected) assert(found.has(id), `${label} missing ${id}`)
}

assert(manifest.schemaVersion === 1, 'schemaVersion must be 1')
assert(manifest.phase === '0', 'phase must be 0')
assert(/^[0-9a-f]{40}$/.test(manifest.sourceBaseline?.ref ?? ''), 'source baseline must be a full 40-char commit SHA')
assert(manifest.sourceBaseline?.repository === 'Officially-aditya/Cuppet-code', 'unexpected source repository')
assert(/^[0-9a-f]{40}$/.test(manifest.sourceBaseline?.upstreamOpenCode?.ref ?? ''), 'OpenCode pin must be a full commit SHA')

for (const category of [
  'contextModes', 'featureFlags', 'modelFacingTools', 'slashCommands', 'paletteOnlyCommands',
  'cliEntrypoints', 'controlMethods', 'pluginHooks', 'controllerOverrides', 'workerRoles', 'openCodePatchStack',
]) requireDisposition(manifest[category], category)

unique(manifest.contextModes, 'id', 'context mode')
unique(manifest.featureFlags, 'name', 'feature flag')
unique(manifest.modelFacingTools, 'id', 'tool')
unique(manifest.slashCommands, 'slash', 'slash command')
unique(manifest.paletteOnlyCommands, 'id', 'palette command')
unique(manifest.controlMethods, 'id', 'control method')
unique(manifest.pluginHooks, 'id', 'plugin hook')
unique(manifest.controllerOverrides, 'method', 'controller override')
unique(manifest.workerRoles, 'id', 'worker role')
unique(manifest.openCodePatchStack, 'id', 'OpenCode patch')

requireIds(manifest.contextModes, 'id', [
  'ordinary-foreground', 'plan', 'graph-only-capsule', 'stm-only', 'structured-stm-events',
  'compiled-source-capsule', 'task-conditioned-context', 'orchestrator',
], 'context modes')
requireIds(manifest.featureFlags, 'name', [
  'CUPPET_STM_ONLY_COMPACTION', 'CUPPET_EXPERIMENTAL_STM_ONLY_COMPACTION', 'CUPPET_STM_COMPACTION_AB',
  'CUPPET_STM_EVENT_CONTEXT', 'CUPPET_GRAPH_CAPSULE_ONLY', 'CUPPET_CONTEXT_COMPILER_AB',
  'CUPPET_TASK_CONTEXT_AB', 'CUPPET_TASK_CONTEXT', 'CUPPET_ORCHESTRATOR',
  'CUPPET_GRAPH_NATIVE_PROFILE', 'CUPPET_GRAPH_FIRST_GATE', 'CUPPET_GRAPH_ONLY_SEARCH',
  'CUPPET_PE3_EMBED_MODEL', 'CUPPET_PE3_MODEL_CACHE', 'CUPPET_PE3_MODEL_DIR', 'CUPPET_PE3_ALLOW_MODEL_DOWNLOAD',
], 'feature flags')
requireIds(manifest.slashCommands, 'slash', [
  'status', 'doctor', 'remote', 'remote-stop', 'memory', 'auto', 'background', 'orchestrator',
  'platform', 'effort', 'steer', 'abort', 'plan', 'compact', 'undo', 'models',
], 'slash commands')
requireIds(manifest.pluginHooks, 'id', [
  'server.experimental.chat.messages.transform', 'server.tool.execute.before', 'setup.agent.transform',
  'setup.command.transform', 'setup.catalog.transform', 'tui.keymap.registerLayer',
], 'plugin hooks')
requireIds(manifest.controllerOverrides, 'method', [
  'initialize', 'close', 'newSession', 'resume', 'adoptSession', 'submit', 'status',
], 'controller overrides')
requireIds(manifest.workerRoles, 'id', [
  'foreground-coding', 'plan', 'orchestrator-master', 'orchestrator-execution-worker', 'memory-canonicalizer',
], 'worker roles')

assert(manifest.openCodePatchStack.length === 19, 'OpenCode patch stack must contain 19 reviewed patches')
assert(manifest.controlMethods.length >= 45, 'control-method inventory unexpectedly small')
assert(manifest.trackedSources.length >= 15, 'tracked source fingerprint inventory unexpectedly small')
assert(manifest.testMigration.length >= 10, 'test migration map unexpectedly small')
assert(manifest.phase0Gate?.status === 'complete', 'phase0 gate must be complete')

if (errors.length) {
  console.error('Phase 0 verification failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Phase 0 verified at Cuppet-code ${manifest.sourceBaseline.ref}`)
console.log(`${manifest.contextModes.length} context modes; ${manifest.featureFlags.length} behavior/config flags; ${manifest.slashCommands.length} slash commands`)
console.log(`${manifest.controlMethods.length} control methods; ${manifest.pluginHooks.length} plugin hooks; ${manifest.controllerOverrides.length} PE3 overrides`)
console.log(`${manifest.workerRoles.length} worker/agent roles; ${manifest.openCodePatchStack.length} OpenCode patches reviewed`)
