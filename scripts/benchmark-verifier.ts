import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = parseArgs(process.argv.slice(2))
await verify(args.task, args.workspace)
process.stdout.write(`VERIFIER-OK ${args.task}\n`)

async function verify(task: string, workspace: string): Promise<void> {
  if (task === 'task-tracker-cross-file') return verifyTaskTracker(workspace)
  if (task === 'quiz-game-greenfield') return verifyWebProject(workspace, 'quiz-game', {
    required: ['quiz', 'question', 'answer', 'score', 'next', 'restart'],
    scripts: ['questions', 'score', 'addEventListener'],
    minimumRecords: 5,
  })
  if (task.startsWith('persistent-build-stage-')) return verifyMiniCrm(workspace, task)
  if (task.startsWith('switch-a-')) return verifyNotes(workspace, 'discontinuity-auth', ['token', 'refresh', 'logout'])
  if (task.startsWith('switch-b-')) return verifyNotes(workspace, 'discontinuity-billing', ['invoice', 'retry', 'idempot'])
  if (task === 'switch-c') return verifyNotes(workspace, 'discontinuity-release', ['version', 'rollback', 'smoke'])
  if (task === 'long-tool-use-dashboard') return verifyWebProject(workspace, 'operations-dashboard', {
    required: ['dashboard', 'search', 'filter', 'status', 'priority', 'details'],
    scripts: ['records', 'addEventListener', 'filter', 'empty'],
    minimumRecords: 8,
  })
  throw new Error(`no deterministic verifier registered for ${task}`)
}

async function verifyTaskTracker(workspace: string): Promise<void> {
  const root = join(workspace, 'games', 'task-tracker')
  const files = await textFiles(root)
  const source = files.map((entry) => entry.text).join('\n')
  assert.equal(/dueDate|due-date/.test(source), false, 'legacy dueDate/due-date tokens remain')
  assert.match(source, /deadline/)
  assert.match(source, /priority/)
  const packageValue = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  for (const script of ['task-tracker:test', 'task-tracker:typecheck', 'task-tracker:run']) assert.equal(typeof packageValue.scripts?.[script], 'string', `${script} is missing`)

  const core = await import(pathToFileURL(join(root, 'src', 'core', 'task.ts')).href) as {
    validate: (input: Record<string, unknown>) => { valid: boolean }
  }
  const past = core.validate({ id: 'past', title: 'Past', deadline: '2000-01-01T00:00:00.000Z', priority: 'normal' })
  const future = core.validate({ id: 'future', title: 'Future', deadline: '2099-01-01T00:00:00.000Z', priority: 'normal' })
  assert.equal(past.valid, false, 'past deadline was accepted')
  assert.equal(future.valid, true, 'future deadline was rejected')

  const factory = await import(pathToFileURL(join(root, 'src', 'core', 'taskFactory.ts')).href) as {
    buildTask: (input: Record<string, unknown>) => { priority?: string; deadline?: string }
  }
  const built = factory.buildTask({ id: 'default', title: 'Default', deadline: '2099-02-03T00:00:00.000Z' })
  assert.equal(built.priority, 'normal', 'new tasks do not default to normal priority')
  assert.equal(built.deadline, '2099-02-03T00:00:00.000Z')

  const store = await import(pathToFileURL(join(root, 'src', 'store', 'taskStore.ts')).href) as {
    clearTasks: () => void
    addTask: (input: Record<string, unknown>) => { deadline?: string }
    setStatus: (id: string, status: string) => unknown
  }
  const index = await import(pathToFileURL(join(root, 'src', 'store', 'taskIndex.ts')).href) as {
    queryTaskIds: (filter: Record<string, string>) => string[]
  }
  store.clearTasks()
  const direct = store.addTask({ id: 'direct', title: 'Direct', deadline: '2099-02-03T00:00:00.000Z', priority: 'high', status: 'todo', tags: ['release'] })
  assert.equal(direct.deadline, '2099-02-03T00:00:00.000Z', 'direct store creation dropped deadline')
  assert.deepEqual(index.queryTaskIds({ status: 'todo', priority: 'high', tag: 'release' }), ['direct'])
  store.setStatus('direct', 'done')
  assert.deepEqual(index.queryTaskIds({ status: 'done', priority: 'high', tag: 'release' }), ['direct'], 'index did not refresh after status update')
}

async function verifyWebProject(
  workspace: string,
  project: string,
  expected: { required: string[]; scripts: string[]; minimumRecords: number },
): Promise<void> {
  const root = join(workspace, 'projects', project)
  const files = await textFiles(root)
  const byName = new Map(files.map((entry) => [entry.path, entry.text]))
  for (const name of ['index.html', 'styles.css', 'app.js', 'README.md']) assert.equal(byName.has(name), true, `${project}/${name} is missing`)
  const html = byName.get('index.html') ?? ''
  const css = byName.get('styles.css') ?? ''
  const script = byName.get('app.js') ?? ''
  const all = `${html}\n${css}\n${script}`.toLowerCase()
  for (const signal of expected.required) assert.match(all, new RegExp(escapeRegExp(signal.toLowerCase())), `${project} is missing ${signal}`)
  for (const signal of expected.scripts) assert.match(script.toLowerCase(), new RegExp(escapeRegExp(signal.toLowerCase())), `${project}/app.js is missing ${signal}`)
  assert.ok(countRecordSignals(script) >= expected.minimumRecords, `${project} has too few local records`)
  assert.equal(/https?:\/\//i.test(all), false, `${project} references a remote URL`)
  assert.match(css, /@media|:focus|outline/i, `${project} lacks responsive or focus styling`)
}

async function verifyMiniCrm(workspace: string, task: string): Promise<void> {
  const root = join(workspace, 'projects', 'mini-crm')
  const files = await textFiles(root)
  const byName = new Map(files.map((entry) => [entry.path, entry.text]))
  for (const name of ['index.html', 'styles.css', 'app.js', 'README.md']) assert.equal(byName.has(name), true, `mini-crm/${name} is missing`)
  const all = files.map((entry) => entry.text).join('\n').toLowerCase()
  assert.match(all, /contact/)
  if (task !== 'persistent-build-stage-1') {
    assert.match(all, /localstorage/)
    assert.match(all, /search|filter/)
    assert.match(all, /favorite|favourite/)
  }
  if (task === 'persistent-build-stage-3') assert.match(all, /:focus|outline|@media/)
}

async function verifyNotes(workspace: string, project: string, signals: string[]): Promise<void> {
  const path = join(workspace, 'projects', project, 'README.md')
  const text = (await readFile(path, 'utf8')).toLowerCase()
  for (const signal of signals) assert.match(text, new RegExp(escapeRegExp(signal)))
}

async function textFiles(root: string, prefix = ''): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(root, { withFileTypes: true })
  const result: Array<{ path: string; text: string }> = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await textFiles(path, relative))
    else if (entry.isFile() && /\.(?:html|css|js|ts|md|json)$/.test(entry.name)) result.push({ path: relative, text: await readFile(path, 'utf8') })
  }
  return result
}

function countRecordSignals(script: string): number {
  const matches = script.match(/(?:id|title|name|label|category|correct|status)\s*:/g)
  return matches?.length ?? 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseArgs(argv: string[]): { task: string; workspace: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('usage: --task ID --workspace PATH')
    values.set(key.slice(2), value)
    index += 1
  }
  const task = values.get('task')
  const workspace = values.get('workspace')
  if (!task || !workspace) throw new Error('usage: --task ID --workspace PATH')
  return { task, workspace }
}
