#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareBenchmarkSuites } from '../src/runtime/execution/benchmark.mjs';

const flags = parseFlags(process.argv.slice(2));
if (flags.help || flags.h) {
  usage();
  process.exit(0);
}
const manifestPath = resolve(required(flags.manifest, '--manifest'));
const outDir = resolve(required(flags['out-dir'], '--out-dir'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (Number(manifest.schemaVersion) !== 1) throw new Error('benchmark manifest schemaVersion must be 1');
const project = resolve(String(flags.project ?? manifest.project ?? ''));
if (!project || project === resolve('.')) throw new Error('benchmark manifest or --project must specify the benchmark repository');
const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
if (!tasks.length) throw new Error('benchmark manifest must contain at least one task');

const provider = manifest.provider && typeof manifest.provider === 'object' ? manifest.provider : {};
const providerID = String(flags['provider-id'] ?? provider.id ?? process.env.CUPPET_PROVIDER_ID ?? 'opencode');
const model = String(flags.model ?? provider.model ?? process.env.CUPPET_MODEL ?? '');
const effort = String(flags.effort ?? provider.effort ?? process.env.CUPPET_EFFORT ?? '');
const cliCommand = String(flags['cli-command'] ?? provider.cliCommand ?? '');
const cliArgs = flags['cli-args-json'] ?? (provider.cliArgs ? JSON.stringify(provider.cliArgs) : '');
const prepareDefault = stringValue(manifest.prepareCommand);
const rawPath = join(outDir, 'raw-baseline.jsonl');
const optimizedPath = join(outDir, 'optimized.jsonl');
const reportPath = join(outDir, 'comparison.json');
await mkdir(outDir, { recursive: true });
await Promise.all([writeFile(rawPath, '', 'utf8'), writeFile(optimizedPath, '', 'utf8')]);

const runner = fileURLToPath(new URL('./run-provider-benchmark.mjs', import.meta.url));
const processFailures = [];
for (const task of tasks) {
  const taskId = required(task?.id, 'task.id');
  const prompt = required(task?.prompt, `task ${taskId}.prompt`);
  const prepareCommand = stringValue(task?.prepareCommand) || prepareDefault;
  if (!prepareCommand) {
    throw new Error(`task '${taskId}' has no prepareCommand. A suite must explicitly restore identical project state before raw and optimized runs.`);
  }
  for (const policy of ['raw-baseline', 'optimized']) {
    const output = policy === 'raw-baseline' ? rawPath : optimizedPath;
    const args = [
      runner,
      '--task-id', taskId,
      '--project', project,
      '--prompt', prompt,
      '--provider-id', providerID,
      '--policy', policy,
      '--prepare-command', prepareCommand,
      '--output', output,
    ];
    addArg(args, '--model', model);
    addArg(args, '--effort', effort);
    addArg(args, '--cli-command', cliCommand);
    addArg(args, '--cli-args-json', cliArgs);
    addArg(args, '--base-url', String(flags['base-url'] ?? provider.baseUrl ?? ''));
    addArg(args, '--verify-command', stringValue(task?.verifyCommand));
    addArg(args, '--expect-output', stringValue(task?.expectOutput));
    addArg(args, '--turn-timeout-ms', numberValue(task?.turnTimeoutMs ?? manifest.turnTimeoutMs));
    addArg(args, '--verify-timeout-ms', numberValue(task?.verifyTimeoutMs ?? manifest.verifyTimeoutMs));
    const result = await run(process.execPath, args, dirname(manifestPath));
    if (result.code !== 0) processFailures.push({ taskId, policy, code: result.code, output: result.output.slice(-4000) });
  }
}

const [baseline, optimized] = await Promise.all([readJsonl(rawPath), readJsonl(optimizedPath)]);
const comparison = compareBenchmarkSuites({
  baseline,
  optimized,
  minImprovements: Number(flags['min-improvements'] ?? manifest.gate?.minImprovements ?? 2),
});
const report = {
  schemaVersion: 1,
  provider: { id: providerID, model: model || 'provider-default', ...(effort ? { effort } : {}) },
  project,
  tasks: tasks.map((task) => String(task.id)),
  rawPath,
  optimizedPath,
  processFailures,
  comparison,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!comparison.passed || processFailures.length) process.exitCode = 1;

async function readJsonl(path) {
  const source = (await readFile(path, 'utf8')).trim();
  if (!source) return [];
  return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const append = (chunk) => { output = `${output}${String(chunk)}`.slice(-32_000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, output: output.trim() }));
  });
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith('--')) throw new Error(`Unexpected positional argument: ${raw}`);
    const key = raw.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}
function addArg(args, name, value) { if (value !== '' && value !== null && value !== undefined) args.push(name, String(value)); }
function required(value, label) { const result = stringValue(value); if (!result) throw new Error(`${label} is required`); return result; }
function stringValue(value) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }
function numberValue(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? String(number) : ''; }

function usage() {
  console.log(`Cuppet provider benchmark suite\n\n  node scripts/run-provider-benchmark-suite.mjs \\\n    --manifest benchmarks/provider-v2.example.json \\\n    --out-dir .benchmark-results/opencode\n\nThe suite runs every task twice (raw-baseline and optimized), executes the same explicit prepareCommand before each run, records verified JSONL results, and writes comparison.json. Provider credentials remain in the normal environment/local CLI; do not put secrets in the manifest.\n`);
}
