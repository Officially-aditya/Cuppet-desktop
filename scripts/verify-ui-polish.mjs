import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/renderer/', import.meta.url))
const mainPath = join(root, 'main.tsx')
const themePath = join(root, 'theme.css')
const polishPath = join(root, 'ui-polish.css')

const requiredPolishFiles = [
  'shell.css',
  'conversation.css',
  'composer.css',
  'overlays.css',
  'motion.css',
  'typography.css',
  'icons.css',
  'states.css',
]

const requiredTokens = [
  '--bg-canvas',
  '--surface-1',
  '--surface-2',
  '--surface-hover',
  '--surface-selected',
  '--border-subtle',
  '--border-default',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-disabled',
  '--status-success',
  '--status-info',
  '--status-warning',
  '--status-error',
  '--action-primary-bg',
  '--action-primary-text',
  '--focus-ring',
  '--radius-sm',
  '--radius-md',
  '--motion-micro',
  '--motion-popover',
  '--motion-structural',
  '--ease-standard',
  '--ease-geometry',
]

const requiredMounts = [
  '<App />',
  '<WorkspaceEnhancements />',
  '<ProjectTerminalMount />',
  '<CommandResultEnhancement />',
  '<ShellPanelControls />',
  '<ComposerPolish />',
]

const requiredStateHooks = [
  'button:active:not(:disabled)',
  'aria-selected',
  'focus-visible',
  ':disabled',
  'data-loading',
  'skeleton',
  '.activity-row.running',
  '.status-success',
  '.status-warning',
  '.status-error',
  '.empty-state',
  '.permission-inline',
  'prefers-reduced-motion',
]

const errors = []
const assert = (condition, message) => {
  if (!condition) errors.push(message)
}

const read = async (path) => readFile(path, 'utf8')
const main = await read(mainPath)
const theme = await read(themePath)
const polish = await read(polishPath)
const states = await read(join(root, 'states.css'))

assert((main.match(/import ['"]\.\/ui-polish\.css['"]/g) ?? []).length === 1,
  'main.tsx must import ui-polish.css exactly once')
assert(!requiredPolishFiles.some((file) => new RegExp(`import ['"]\\.\\/${file}['"]`).test(main)),
  'main.tsx must not import phase-specific polish CSS directly')
assert(main.includes("import './types';"), 'main.tsx must retain the renderer type side-effect import')
for (const mount of requiredMounts) assert(main.includes(mount), `main.tsx missing required mount: ${mount}`)

let expectedOrder = 0
for (const file of requiredPolishFiles) {
  const importLine = `@import './${file}';`
  const index = polish.indexOf(importLine)
  assert(index >= 0, `ui-polish.css missing ${file}`)
  assert(index >= expectedOrder, `ui-polish.css order is invalid around ${file}`)
  expectedOrder = index
}

for (const token of requiredTokens) {
  assert(new RegExp(`${token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`).test(theme),
    `theme.css missing required token ${token}`)
}

for (const hook of requiredStateHooks) assert(states.includes(hook), `states.css missing state hook: ${hook}`)

const cssFiles = []
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.css')) cssFiles.push(path)
  }
}
await walk(root)

for (const path of cssFiles) {
  const css = await read(path)
  const rel = relative(root, path)
  assert(!/transition\s*:\s*all\b/i.test(css), `${rel} contains transition: all`)
  assert(!/transition-property\s*:\s*all\b/i.test(css), `${rel} contains transition-property: all`)
}

// Catch polish-layer references to undeclared custom properties. Local declarations
// are included so feature-specific variables remain valid without a central registry.
const polishPaths = [themePath, ...requiredPolishFiles.map((file) => join(root, file))]
const polishCss = await Promise.all(polishPaths.map(read))
const declarations = new Set()
for (const css of polishCss) {
  for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) declarations.add(match[1])
}
for (const [index, css] of polishCss.entries()) {
  const rel = relative(root, polishPaths[index])
  for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
    assert(declarations.has(match[1]), `${rel} references undeclared custom property ${match[1]}`)
  }
}

if (errors.length) {
  console.error('UI polish verification failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`UI polish verified: ${requiredPolishFiles.length} phase layers, ${cssFiles.length} renderer CSS files audited`)
console.log('No transition: all declarations; required state hooks, mounts, tokens, and custom properties are present')
