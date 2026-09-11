#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { createBenchmarkRecord } from '../src/runtime/execution/benchmark.mjs';
import { ProjectManager } from '../src/runtime/projects.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

const flags = parseFlags(process.argv.slice(2));
if (flags.help || flags.h) {
  usage();
  process.exit(0);
}

const taskId = required(flags['task-id'], '--task-id');
const prompt = required(flags.prompt, '--prompt');
const projectPath = resolve(required(flags.project, '--project'));
const policy = String(flags.policy ?? 'optimized');
if (!['optimized', 'raw-baseline'].includes(policy)) throw new Error('--policy must be optimized or raw-baseline');

const ownsDataDir = !flags['data-dir'];
const dataDir = flags['data-dir']
  ? resolve(String(flags['data-dir']))
  : await mkdtemp(join(tmpdir(), 'cuppet-provider-benchmark-'));
const databasePath = join(dataDir, 'conversations.sqlite3');
await mkdir(dataDir, { recursive: true });

const projectId = `benchmark_project_${randomUUID()}`;
const sessionId = `benchmark_session_${randomUUID()}`;
let canonicalProjectRoot = projectPath;
let service = null;
const previousEnvironment = saveEnvironment([
  'CUPPET_PROVIDER_BENCHMARK',
  'CUPPET_EXECUTION_BENCHMARK_POLICY',
  'CUPPET_PE3',
  'CUPPET_NONINTERACTIVE',
]);

try {
  const db = new ConversationDatabase(databasePath);
  try {
    const projects = new ProjectManager({ db });
    const project = await projects.addLocal({ id: projectId, path: projectPath, name: `Benchmark ${basename(projectPath)}` });
    canonicalProjectRoot = project.canonicalPath;
    if (flags['prepare-command']) {
      const prepared = await runShell(String(flags['prepare-command']), canonicalProjectRoot, numberFlag(flags['command-timeout-ms'], 10 * 60_000));
      if (prepared.code !== 0) throw new Error(`prepare command failed (${prepared.code}): ${prepared.output}`);
    }
    db.createSession({ id: sessionId, projectId, title: `Benchmark: ${taskId}` });
  } finally {
    db.close();
  }

  process.env.CUPPET_PROVIDER_BENCHMARK = '1';
  process.env.CUPPET_EXECUTION_BENCHMARK_POLICY = policy;
  process.env.CUPPET_PE3 = '0';
  process.env.CUPPET_NONINTERACTIVE = '1';

  let benchmarkSample = null;
  service = new RuntimeService({
    databasePath,
    dataDir,
    interactive: false,
    backgroundFactory: () => noOpBackgroundWorker(),
    emit: (event) => {
      if (event?.type === 'runtime.benchmark.sample' && event.sessionId === sessionId) benchmarkSample = event.sample;
    },
  });

  // Guarded auto mode keeps the benchmark non-interactive while preserving the
  // same project-root, protected-file and command safety checks in both modes.
  await service.handle('session.auto.set', { sessionId, enabled: true });
  const provider = providerConfiguration(flags);
  const accepted = await service.handle('session.send', { sessionId, text: prompt, provider });
  if (accepted.sessionId !== sessionId) throw new Error('Benchmark routing changed the isolated session unexpectedly.');
  const message = await waitForTerminalAssistant(service, sessionId, numberFlag(flags['turn-timeout-ms'], 30 * 60_000));
  if (!benchmarkSample) throw new Error('Foreground turn completed without a runtime.benchmark.sample.');

  const correctness = await verifyBenchmark({
    message,
    projectRoot: canonicalProjectRoot,
    verifyCommand: stringFlag(flags['verify-command']),
    expectOutput: stringFlag(flags['expect-output']),
    timeoutMs: numberFlag(flags['verify-timeout-ms'], 10 * 60_000),
  });
  const providerID = String(provider.providerID ?? provider.primary?.providerID ?? 'unknown');
  const modelID = String(provider.primary?.modelID ?? provider.model ?? 'provider-default');
  const record = createBenchmarkRecord({
    taskId,
    providerID,
    modelID,
    mode: policy,
    execution: benchmarkSample.execution,
    usage: benchmarkSample.usage,
    elapsedMs: benchmarkSample.elapsedMs,
    correctness,
    ...(benchmarkSample.error || message.status === 'error' ? { error: benchmarkSample.error || message.content || 'Provider turn failed.' } : {}),
  });

  if (flags.output) {
    const outputPath = resolve(String(flags.output));
    await mkdir(dirname(outputPath), { recursive: true });
    await appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (!record.correctness.verified || !record.correctness.passed) process.exitCode = 1;
} finally {
  await service?.close().catch(() => undefined);
  restoreEnvironment(previousEnvironment);
  if (ownsDataDir && flags['keep-data'] !== true) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

function providerConfiguration(input) {
  const providerID = String(input['provider-id'] ?? process.env.CUPPET_PROVIDER_ID ?? 'opencode').trim();
  const model = String(input.model ?? process.env.CUPPET_MODEL ?? '').trim();
  const effort = String(input.effort ?? process.env.CUPPET_EFFORT ?? '').trim();
  const configuration = {
    providerID,
    ...(model ? { model } : {}),
    ...(input['base-url'] || process.env.CUPPET_BASE_URL ? { baseUrl: String(input['base-url'] ?? process.env.CUPPET_BASE_URL) } : {}),
    ...(input['api-key'] || process.env.CUPPET_API_KEY || process.env.OPENAI_API_KEY ? { apiKey: String(input['api-key'] ?? process.env.CUPPET_API_KEY ?? process.env.OPENAI_API_KEY) } : {}),
    ...(input['cli-command'] ? { cliCommand: String(input['cli-command']) } : {}),
  };
  const cliArgs = jsonFlag(input['cli-args-json'], '--cli-args-json');
  if (cliArgs !== null) {
    if (!Array.isArray(cliArgs)) throw new Error('--cli-args-json must decode to an array');
    configuration.cliArgs = cliArgs.map(String);
  }
  if (model || effort) configuration.primary = { providerID, ...(model ? { modelID: model } : {}), ...(effort ? { variant: effort } : {}) };
  if (effort) configuration.primaryEffort = effort;
  return configuration;
}

async function verifyBenchmark({ message, projectRoot, verifyCommand, expectOutput, timeoutMs }) {
  const checks = [];
  if (message.status !== 'complete') checks.push({ passed: false, detail: `assistant status is ${message.status}` });
  if (expectOutput) checks.push({ passed: String(message.content ?? '').includes(expectOutput), detail: `assistant output contains ${JSON.stringify(expectOutput)}` });
  if (verifyCommand) {
    const result = await runShell(verifyCommand, projectRoot, timeoutMs);
    checks.push({ passed: result.code === 0, detail: `verify command exited ${result.code}${result.output ? `: ${result.output}` : ''}` });
  }
  if (checks.length === 0) {
    return {
      verified: false,
      passed: false,
      score: 0,
      details: 'No correctness verifier supplied. Use --verify-command and/or --expect-output before using this record in a benchmark gate.',
    };
  }
  const passed = checks.every((check) => check.passed);
  return {
    verified: true,
    passed,
    score: passed ? 1 : 0,
    details: checks.map((check) => `${check.passed ? 'PASS' : 'FAIL'} ${check.detail}`).join('\n').slice(0, 2000),
  };
}

function noOpBackgroundWorker() {
  return {
    stats: { queued: 0, running: false, paused: true },
    foregroundStarted() {},
    foregroundIdle() {},
    setProviderConfig() {},
    forgetSession() {},
    pause() {},
    resume() {},
    async flush() { return { flushed: 0 }; },
    async recordTurn() {},
    async close() {},
  };
}

async function waitForTerminalAssistant(runtime, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await runtime.handle('session.get', { sessionId });
    const message = [...(session.messages ?? [])].reverse().find((item) => item.role === 'assistant');
    if (message && message.status !== 'streaming') return message;
    if (Date.now() >= deadline) throw new Error(`benchmark provider turn timed out after ${timeoutMs}ms`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-lc', command];
    const child = spawn(shell, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const append = (chunk) => { output = `${output}${String(chunk)}`.slice(-16_000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, output: output.trim() });
    });
  });
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith('--')) throw new Error(`Unexpected positional argument: ${raw}`);
    const key = raw.slice(2);
    if (!key) throw new Error('Empty flag');
    const next = values[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}
function required(value, flag) { const result = stringFlag(value); if (!result) throw new Error(`${flag} is required`); return result; }
function stringFlag(value) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }
function numberFlag(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function jsonFlag(value, label) { if (value === undefined) return null; try { return JSON.parse(String(value)); } catch { throw new Error(`${label} must be valid JSON`); } }
function saveEnvironment(keys) { return Object.fromEntries(keys.map((key) => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined])); }
function restoreEnvironment(saved) { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }

function usage() {
  console.log(`Cuppet provider benchmark runner\n\nRun one task on a clean/disposable project state:\n  node scripts/run-provider-benchmark.mjs \\\n    --task-id multi-file-change \\\n    --project /path/to/repo \\\n    --prompt "Implement the requested change and validate it" \\\n    --provider-id opencode \\\n    --model provider/model \\\n    --policy optimized \\\n    --prepare-command "git reset --hard HEAD && git clean -fd" \\\n    --verify-command "npm test" \\\n    --output benchmarks/opencode-optimized.jsonl\n\nRepeat from the same prepared project state with --policy raw-baseline, then compare:\n  node scripts/compare-provider-benchmarks.mjs benchmarks/opencode-raw.jsonl benchmarks/opencode-optimized.jsonl\n\nImportant:\n  --prepare-command is optional and is executed exactly as supplied. Use it only on a disposable/clean benchmark checkout.\n  A record without --verify-command or --expect-output is marked unverified and cannot pass the comparison gate.\n`);
}
