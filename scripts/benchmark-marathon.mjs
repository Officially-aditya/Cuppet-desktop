#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(process.cwd())
const options = parseArgs(process.argv.slice(2))
const manifestPath = resolve(root, options.manifest)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== 12) throw new Error(`Desktop marathon requires exactly 12 tasks; found ${manifest.tasks?.length ?? 'unknown'}`)
if (!manifest.sourceRepository?.url || !manifest.sourceRepository?.startingSha) throw new Error('Desktop marathon manifest must pin its source repository and starting SHA')

const repetitions = options.repeats ?? manifest.repetitions ?? 2
if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({
    benchmark: manifest.name,
    benchmarkVersion: manifest.benchmarkVersion,
    sourceRepository: manifest.sourceRepository,
    repetitions,
    tasks: manifest.tasks.map((task) => task.id),
    runtime: 'Cuppet Desktop RuntimeService',
    pe3: true,
    tst: true,
  }, null, 2)}\n`)
  process.exit(0)
}

await mkdir(join(root, '.benchmarks'), { recursive: true })
const runRoot = await mkdtemp(join(root, '.benchmarks', 'marathon-'))
process.env.CUPPET_DATA_DIR = join(runRoot, 'usage-ledger')
process.env.CUPPET_PE3 = '1'

const sourceRoot = await resolveBenchmarkSource(manifest.sourceRepository)
const runtime = await loadDesktopRuntime()
const tstBinary = process.env.CUPPET_TST_BIN?.trim() || runtime.resolveManagedTstBinary()
if (!tstBinary || !existsSync(tstBinary)) {
  throw new Error(`Managed TST binary is required. Stage Desktop TST first or set CUPPET_TST_BIN. Resolved path: ${tstBinary ?? 'none'}`)
}

const results = []
try {
  for (let repeat = 1; repeat <= repetitions; repeat += 1) {
    const workspace = join(runRoot, 'workspaces', `repeat-${repeat}`)
    await prepareWorkspace(workspace, sourceRoot, manifest.sourceRepository.startingSha)
    const repeatResults = await runSequence({ repeat, workspace, manifest, runtime, tstBinary })
    results.push(...repeatResults)
    if (!options.keepWorkspaces) await rm(workspace, { recursive: true, force: true })
  }

  const report = buildReport(manifest, repetitions, results, runRoot, sourceRoot)
  const outputDir = resolve(root, options.output)
  await mkdir(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const jsonPath = join(outputDir, `marathon-${stamp}.json`)
  const markdownPath = join(outputDir, `marathon-${stamp}.md`)
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, renderMarkdown(report), 'utf8')
  process.stdout.write(`${JSON.stringify({ status: report.status, jsonPath, markdownPath, summary: report.summary }, null, 2)}\n`)
  if (report.status !== 'completed') process.exitCode = 1
} finally {
  await runtime.closeProviderUsageLedger().catch(() => undefined)
  if (!options.keepRunRoot) await rm(runRoot, { recursive: true, force: true }).catch(() => undefined)
}

async function runSequence({ repeat, workspace, manifest, runtime, tstBinary }) {
  const runtimeBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const dataDir = await mkdtemp(join(runtimeBase, 'cuppet-bench-runtime-'))
  let service
  let activeFailure
  const counters = { toolCalls: 0, compactions: 0, permissions: 0, rejectedPermissions: 0, events: 0 }
  const routes = []
  const emit = (event) => {
    counters.events += 1
    if (event?.type === 'tool.started') counters.toolCalls += 1
    if (event?.type === 'context.compacted') counters.compactions += 1
    if (event?.type === 'run.finished' && event?.error) activeFailure ??= String(event.error)
    if (event?.type === 'pe3.routed') routes.push({
      action: event.action,
      sourceSessionId: event.sourceSessionId,
      targetSessionId: event.targetSessionId,
      reason: event.reason ?? null,
    })
    if (event?.type === 'permission.requested') {
      counters.permissions += 1
      const allowed = new Set(['read', 'edit', 'write', 'bash']).has(String(event.request?.action ?? ''))
      if (!allowed) counters.rejectedPermissions += 1
      queueMicrotask(() => void service?.handle('permission.reply', {
        requestId: event.request?.id,
        reply: allowed ? 'once' : 'reject',
      }).catch(() => undefined))
    }
    if (event?.type === 'question.requested') {
      queueMicrotask(() => void service?.handle('question.reject', { requestId: event.request?.id }).catch(() => undefined))
    }
  }

  const tst = new runtime.RuntimeTstManager({ dataDir: join(dataDir, 'tst'), binaryPath: tstBinary, idleMs: 0 })
  service = new runtime.RuntimeService({ databasePath: join(dataDir, 'conversations.sqlite3'), dataDir, emit, interactive: true, tst })
  const provider = buildProvider(manifest.model, runtime.normalizeProviderConfiguration)
  const rows = []
  try {
    await service.handle('background.pause')
    const project = await service.handle('project.add-local', { path: workspace, name: `Cuppet Marathon ${repeat}` })
    const projectId = project.id
    const projectRoot = project.canonicalPath
    const initial = await service.handle('session.create', { projectId })
    let activeSessionId = initial.id
    const tstHandle = await tst.forProject(projectId, projectRoot)
    await waitForIndex(tstHandle)

    const scoped = (method, params = {}, sessionId = activeSessionId) => tst.runWithProject(
      { sessionId, projectId, projectRoot },
      () => service.handle(method, params),
    )

    for (let index = 0; index < manifest.tasks.length; index += 1) {
      const task = manifest.tasks[index]
      const beforeUsage = await runtime.providerUsageSummary()
      const before = { ...counters }
      const routeOffset = routes.length
      const startedAt = new Date().toISOString()
      const started = performance.now()
      let failure
      let finalMessage = ''
      let targetSessionId = activeSessionId
      let pe3 = null
      activeFailure = undefined

      try {
        const accepted = await withTimeout(
          scoped('session.send', { sessionId: activeSessionId, text: task.prompt, provider }, activeSessionId),
          30_000,
          `${task.id}: session.send did not accept the turn`,
        )
        targetSessionId = accepted.sessionId
        activeSessionId = targetSessionId
        pe3 = accepted.pe3 ?? null
        const message = await waitForTerminalAssistant(scoped, targetSessionId, manifest.workspace.timeoutMs)
        finalMessage = String(message.content ?? '')
        if (message.status === 'error') failure = finalMessage || 'Desktop generation failed'
        else if (message.status === 'stopped') failure = 'Desktop generation stopped'
        failure ??= activeFailure
      } catch (error) {
        failure = cleanError(error)
        await scoped('session.stop', { sessionId: targetSessionId }, targetSessionId).catch(() => undefined)
      }

      const verification = await runVerifications(task, workspace)
      const afterUsage = await runtime.providerUsageSummary()
      const usage = usageDelta(afterUsage, beforeUsage)
      const success = !failure && verification.every((check) => check.passed)
      rows.push({
        repeat,
        taskIndex: index,
        taskId: task.id,
        title: task.title,
        success,
        startedAt,
        completedAt: new Date().toISOString(),
        sourceSessionId: pe3?.sourceSessionId ?? null,
        sessionId: targetSessionId,
        pe3: pe3 ? {
          action: pe3.action,
          reason: pe3.reason ?? null,
          affinity: pe3.affinity ?? null,
          refreshPaths: pe3.refreshPaths ?? [],
        } : null,
        routeEvents: routes.slice(routeOffset),
        usage,
        toolCalls: counters.toolCalls - before.toolCalls,
        compactions: counters.compactions - before.compactions,
        permissionRequests: counters.permissions - before.permissions,
        rejectedPermissions: counters.rejectedPermissions - before.rejectedPermissions,
        eventCount: counters.events - before.events,
        verification,
        acceptanceScore: verification.length ? verification.filter((check) => check.passed).length / verification.length : 0,
        changedFiles: await changedFiles(workspace),
        finalMessage,
        ...(failure ? { error: failure } : {}),
      })
    }
  } finally {
    await service.close().catch(() => undefined)
    await tst.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  return rows
}

async function resolveBenchmarkSource(source) {
  const requested = process.env.CUPPET_BENCHMARK_SOURCE_ROOT?.trim()
  const candidates = [requested ? resolve(requested) : null, resolve(root, '..', 'Cuppet-code')].filter(Boolean)
  for (const candidate of candidates) {
    if (await hasCommit(candidate, source.startingSha)) return candidate
  }

  const cacheRoot = resolve(root, '.benchmark-cache', 'Cuppet-code')
  await mkdir(dirname(cacheRoot), { recursive: true })
  if (!existsSync(join(cacheRoot, '.git'))) {
    await rm(cacheRoot, { recursive: true, force: true })
    const args = ['clone', '--filter=blob:none', '--no-checkout', '--quiet']
    if (source.ref) args.push('--branch', source.ref)
    args.push(source.url, cacheRoot)
    await execFile('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  }
  if (!await hasCommit(cacheRoot, source.startingSha)) {
    const ref = source.ref || 'HEAD'
    await execFile('git', ['fetch', '--quiet', 'origin', ref], { cwd: cacheRoot, maxBuffer: 4 * 1024 * 1024 })
  }
  if (!await hasCommit(cacheRoot, source.startingSha)) {
    throw new Error(`Frozen benchmark source commit ${source.startingSha} is unavailable in ${cacheRoot}`)
  }
  return cacheRoot
}

async function hasCommit(repository, sha) {
  if (!repository || !existsSync(join(repository, '.git'))) return false
  try {
    await execFile('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repository, maxBuffer: 64 * 1024 })
    return true
  } catch { return false }
}

async function prepareWorkspace(workspace, sourceRoot, startingSha) {
  await mkdir(workspace, { recursive: true })
  const archive = `${workspace}.tar`
  await execFile('git', ['archive', '--format=tar', '--output', archive, startingSha], { cwd: sourceRoot, maxBuffer: 4 * 1024 * 1024 })
  await execFile('tar', ['-xf', archive, '-C', workspace], { maxBuffer: 4 * 1024 * 1024 })
  await rm(archive, { force: true })

  const sourceNodeModules = join(root, 'node_modules')
  try {
    await access(sourceNodeModules)
    await symlink(sourceNodeModules, join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {}

  await git(workspace, ['init', '--quiet'])
  await git(workspace, ['config', 'user.email', 'benchmark@localhost'])
  await git(workspace, ['config', 'user.name', 'Benchmark Controller'])
  await mkdir(join(workspace, '.git', 'info'), { recursive: true })
  await writeFile(join(workspace, '.git', 'info', 'exclude'), 'node_modules\n.benchmarks\n', 'utf8')
  await git(workspace, ['add', '--all'])
  await git(workspace, ['commit', '--quiet', '-m', 'benchmark baseline'])
}

async function runVerifications(task, workspace) {
  const values = { controllerRoot: root, workspace }
  const results = []
  for (const spec of task.verification ?? []) {
    const args = spec.args.map((value) => expand(value, values))
    const command = process.platform === 'win32' && spec.command === 'npm' ? 'npm.cmd' : spec.command
    const execution = await runCommand(command, args, workspace, spec.timeoutMs)
    results.push({
      id: spec.id,
      command: spec.command,
      args,
      passed: execution.exitCode === 0 && !execution.timedOut,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      stdout: truncate(execution.stdout),
      stderr: truncate(execution.stderr),
    })
  }
  return results
}

function buildProvider(model, normalizeProviderConfiguration) {
  const providerID = process.env.CUPPET_DESKTOP_BENCH_PROVIDER?.trim() || model.provider
  if (providerID === 'codex') return { providerID: 'codex', model: model.model, primaryEffort: model.reasoningEffort }
  const apiKey = process.env.CUPPET_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ''
  if (!apiKey) throw new Error(`Benchmark provider '${providerID}' requires CUPPET_API_KEY or OPENAI_API_KEY. Set CUPPET_DESKTOP_BENCH_PROVIDER=codex only for an explicitly non-parity transport run.`)
  const context = Number(process.env.CUPPET_CONTEXT_WINDOW_TOKENS) || model.contextWindowTokens
  return normalizeProviderConfiguration({
    providerID,
    baseUrl: process.env.CUPPET_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey,
    model: model.model,
    backgroundModel: model.model,
    primary: { providerID, modelID: model.model, variant: model.reasoningEffort },
    secondary: { providerID, modelID: model.model, variant: model.reasoningEffort },
    models: [{
      providerID,
      modelID: model.model,
      name: model.model,
      context,
      outputLimit: model.outputLimit,
      capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
      variants: [{ id: model.reasoningEffort, body: providerID === 'openai' ? { reasoning: { effort: model.reasoningEffort } } : {} }],
    }],
  })
}

async function loadDesktopRuntime() {
  const load = (path) => import(pathToFileURL(join(root, path)).href)
  const [service, manager, supervisor, policy, usage] = await Promise.all([
    load('src/runtime/service.mjs'),
    load('src/runtime/runtime-tst-manager.mjs'),
    load('src/runtime/tst-supervisor.mjs'),
    load('src/runtime/provider-policy.mjs'),
    load('src/runtime/usage-ledger.mjs'),
  ])
  return {
    RuntimeService: service.RuntimeService,
    RuntimeTstManager: manager.RuntimeTstManager,
    resolveManagedTstBinary: supervisor.resolveManagedTstBinary,
    normalizeProviderConfiguration: policy.normalizeProviderConfiguration,
    providerUsageSummary: usage.providerUsageSummary,
    closeProviderUsageLedger: usage.closeProviderUsageLedger,
  }
}

async function waitForIndex(tstHandle) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = await tstHandle.call('status')
    if (status?.graph?.progress?.complete) return
    await delay(100)
  }
  throw new Error('TST graph index did not complete before the marathon started')
}

async function waitForTerminalAssistant(scoped, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = await scoped('session.get', { sessionId }, sessionId)
    const message = [...(session.messages ?? [])].reverse().find((item) => item.role === 'assistant')
    if (message && message.status !== 'streaming') return message
    await delay(40)
  }
  throw new Error(`${sessionId}: generation timed out`)
}

function usageDelta(after, before) {
  const inputTokens = delta(after?.inputTokens, before?.inputTokens)
  const cachedInputTokens = delta(after?.cachedInputTokens, before?.cachedInputTokens)
  const outputTokens = delta(after?.outputTokens, before?.outputTokens)
  const reasoningTokens = delta(after?.reasoningTokens, before?.reasoningTokens)
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  return {
    requests: delta(after?.requests, before?.requests),
    trackedRequests: delta(after?.trackedRequests, before?.trackedRequests),
    unreportedRequests: delta(after?.unreportedRequests, before?.unreportedRequests),
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalModelTokens: uncachedInputTokens + outputTokens + reasoningTokens,
  }
}

function buildReport(manifest, repetitions, results, runRoot, sourceRoot) {
  const successful = results.filter((row) => row.success)
  const allChecks = results.flatMap((row) => row.verification)
  const early = results.filter((row) => row.taskIndex < 3)
  const late = results.filter((row) => row.taskIndex >= manifest.tasks.length - 3)
  const finals = results.filter((row) => row.taskIndex === manifest.tasks.length - 1)
  const routeCounts = {}
  for (const row of results) {
    const action = row.pe3?.action ?? 'continue'
    routeCounts[action] = (routeCounts[action] ?? 0) + 1
  }
  const summary = {
    tasksAttempted: results.length,
    tasksSuccessful: successful.length,
    successRate: results.length ? successful.length / results.length : 0,
    acceptanceChecksPassed: allChecks.filter((check) => check.passed).length,
    acceptanceChecksTotal: allChecks.length,
    medianModelTokens: median(results.map((row) => row.usage.totalModelTokens)),
    medianUncachedInputTokens: median(results.map((row) => row.usage.uncachedInputTokens)),
    medianCachedInputTokens: median(results.map((row) => row.usage.cachedInputTokens)),
    cumulativeUncachedInputTokens: sum(results.map((row) => row.usage.uncachedInputTokens)),
    cumulativeCachedInputTokens: sum(results.map((row) => row.usage.cachedInputTokens)),
    earlyUncachedMedian: median(early.map((row) => row.usage.uncachedInputTokens)),
    lateUncachedMedian: median(late.map((row) => row.usage.uncachedInputTokens)),
    earlyCacheShareMedian: median(early.map(cacheShare).filter((value) => value !== null)),
    lateCacheShareMedian: median(late.map(cacheShare).filter((value) => value !== null)),
    finalTaskCacheShareMedian: median(finals.map(cacheShare).filter((value) => value !== null)),
    medianToolCalls: median(results.map((row) => row.toolCalls)),
    pe3Routes: routeCounts,
  }
  return {
    schema: 1,
    status: results.length === repetitions * manifest.tasks.length && results.every((row) => row.success) ? 'completed' : 'failed',
    createdAt: results[0]?.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    benchmarkVersion: manifest.benchmarkVersion,
    benchmark: manifest.name,
    sourceBenchmark: manifest.sourceBenchmark,
    sourceRepository: { ...manifest.sourceRepository, resolvedRoot: sourceRoot },
    topology: 'marathon',
    runtime: 'Cuppet Desktop RuntimeService',
    pe3Enabled: true,
    tstEnabled: true,
    backgroundPaused: true,
    model: manifest.model,
    repetitions,
    sequenceLength: manifest.tasks.length,
    runRoot,
    summary,
    tasks: results,
  }
}

function renderMarkdown(report) {
  const s = report.summary
  const lines = [
    `# ${report.benchmark}`,
    '',
    `- Status: **${report.status}**`,
    `- Runtime: ${report.runtime}`,
    `- Source seed: ${report.sourceRepository.startingSha}`,
    `- Topology: ${report.topology}; ${report.sequenceLength} tasks × ${report.repetitions} repeat(s)`,
    `- PE3: enabled`,
    `- TST: enabled`,
    `- Model: ${report.model.provider}/${report.model.model} (${report.model.reasoningEffort})`,
    '',
    '## Headline metrics',
    '',
    '| Metric | Cuppet Desktop |',
    '|---|---:|',
    `| Successful tasks | ${s.tasksSuccessful}/${s.tasksAttempted} |`,
    `| Acceptance checks | ${s.acceptanceChecksPassed}/${s.acceptanceChecksTotal} |`,
    `| Median model tokens/task | ${fmt(s.medianModelTokens)} |`,
    `| Median uncached input/task | ${fmt(s.medianUncachedInputTokens)} |`,
    `| Median cached input/task | ${fmt(s.medianCachedInputTokens)} |`,
    `| Cumulative uncached input | ${fmt(s.cumulativeUncachedInputTokens)} |`,
    `| Cumulative cached input | ${fmt(s.cumulativeCachedInputTokens)} |`,
    `| Early uncached median | ${fmt(s.earlyUncachedMedian)} |`,
    `| Late uncached median | ${fmt(s.lateUncachedMedian)} |`,
    `| Early cache share | ${pct(s.earlyCacheShareMedian)} |`,
    `| Late cache share | ${pct(s.lateCacheShareMedian)} |`,
    `| Final-task cache share | ${pct(s.finalTaskCacheShareMedian)} |`,
    `| Median tool calls/task | ${fmt(s.medianToolCalls)} |`,
    '',
    `PE3 routes: ${Object.entries(s.pe3Routes).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}.`,
    '',
    '## Per-task results',
    '',
    '| Repeat | Task | Result | PE3 | Uncached input | Cached input | Output | Reasoning | Tools | Acceptance |',
    '|---:|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.tasks.map((row) => `| ${row.repeat} | ${row.taskId} | ${row.success ? 'pass' : 'fail'} | ${row.pe3?.action ?? 'continue'} | ${fmt(row.usage.uncachedInputTokens)} | ${fmt(row.usage.cachedInputTokens)} | ${fmt(row.usage.outputTokens)} | ${fmt(row.usage.reasoningTokens)} | ${row.toolCalls} | ${(row.acceptanceScore * 100).toFixed(0)}% |`),
    '',
  ]
  return lines.join('\n')
}

async function changedFiles(workspace) {
  try {
    const output = await git(workspace, ['status', '--short'])
    return output.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean)
  } catch { return [] }
}

async function git(cwd, args) { return (await execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim() }
function expand(value, values) { return String(value).replaceAll('{controllerRoot}', values.controllerRoot).replaceAll('{workspace}', values.workspace) }
function delta(after, before) { return Math.max(0, (Number(after) || 0) - (Number(before) || 0)) }
function sum(values) { return values.reduce((total, value) => total + value, 0) }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
function cacheShare(row) { const total = row.usage.uncachedInputTokens + row.usage.cachedInputTokens; return total > 0 ? row.usage.cachedInputTokens / total : null }
function fmt(value) { return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US') }
function pct(value) { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%` }
function truncate(value) { return value.length > 12_000 ? `${value.slice(0, 12_000)}\n…<truncated>` : value }
function cleanError(error) { return error instanceof Error ? error.message : String(error) }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)) }
async function withTimeout(promise, timeoutMs, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) } finally { if (timer) clearTimeout(timer) } }

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    let timedOut = false, settled = false
    const started = performance.now()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1_500).unref()
    }, timeoutMs)
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Math.round(performance.now() - started), timedOut })
    }
    child.once('error', (error) => finish(error.message))
    child.once('close', (code, signal) => finish(code ?? signal ?? 'unknown'))
  })
}

function parseArgs(argv) {
  const options = { manifest: 'benchmarks/marathon/manifest.json', output: 'benchmarks/results', dryRun: false, keepWorkspaces: false, keepRunRoot: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--keep-workspaces') options.keepWorkspaces = true
    else if (arg === '--keep-run-root') options.keepRunRoot = true
    else if (['--manifest', '--output', '--repeats'].includes(arg)) {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      if (arg === '--manifest') options.manifest = value
      else if (arg === '--output') options.output = value
      else {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--repeats must be a positive integer')
        options.repeats = parsed
      }
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}
