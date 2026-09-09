import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/tool-runtime.mjs',
  'src/runtime/permissions.mjs',
  'src/runtime/provider.mjs',
  'src/runtime/tst-client.mjs',
  'src/runtime/database.mjs',
  'src/runtime/service.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/permissions.js',
  'src/renderer/index.html',
  'migration/phase-c1-contract.json',
  'docs/phase-c1-tools-permissions.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const tools = text['src/runtime/tool-runtime.mjs'];
for (const name of ['cuppet_plan', 'cuppet_memory_search', 'tst_explore', 'tst_read', 'workspace_edit', 'workspace_write', 'bash']) {
  expect(tools.includes(`'${name}'`), `model tool missing: ${name}`);
}
expect(tools.includes('MAX_TOOL_STEPS = 64') && tools.includes('MAX_TOOL_OUTPUT = 128 * 1024') && tools.includes('MAX_FILE_BYTES = 1024 * 1024'), 'runtime tool safety caps changed');
expect(tools.includes('graphWorkspace') && tools.includes('graphList') && tools.includes('graphLocate') && tools.includes('graphTraceSummary'), 'TST explore parity surface incomplete');
expect(tools.includes('identical') && tools.includes('#graphCache'), 'duplicate TST exploration suppression missing');
expect(tools.includes('resolveWorkspacePath') && tools.includes('realpath') && tools.includes('isAtOrInside'), 'filesystem containment boundary missing');
expect(tools.includes('onPaths(result.paths, result.mutation') && tools.includes('result.details ?? null'), 'tool paths or mutation metadata do not feed task-state callback');

const permissions = text['src/runtime/permissions.mjs'];
expect(permissions.includes('isSafeAutoBashCommand') && permissions.includes('PLAIN_COMMAND') && permissions.includes("case 'rev-parse'"), 'safe-bash classifier missing');
expect(permissions.includes("source: 'workspace-read'") && permissions.includes('isEnvExampleResource'), 'ordinary read/.env.example compatibility missing');
expect(permissions.includes('isSensitivePath') && permissions.includes('isProtectedResource'), 'sensitive/protected file policy missing');
expect(permissions.includes("source: 'session-auto'") && permissions.includes("source: 'session-exact'"), 'guarded auto or exact always semantics missing');
expect(permissions.includes('plan_mode_read_only') && permissions.includes('interaction_required'), 'plan/noninteractive fail-closed policy missing');

const provider = text['src/runtime/provider.mjs'];
expect(provider.includes('request.tools = tools') && provider.includes("request.tool_choice = 'auto'"), 'provider tool registration missing');
expect(provider.includes('delta?.tool_calls') && provider.includes('mergeToolCallDeltas'), 'streamed provider tool-call reconstruction missing');

const database = text['src/runtime/database.mjs'];
expect(database.includes('CREATE TABLE IF NOT EXISTS tool_executions') && database.includes('createToolExecution') && database.includes('finishToolExecution'), 'durable SQLite tool audit missing');
expect(database.includes("status = 'error'") && database.includes('Interrupted by runtime restart'), 'stale running tool recovery missing');

const service = text['src/runtime/service.mjs'];
expect(service.includes("case 'permission.list'") && service.includes("case 'permission.reply'") && service.includes("case 'session.auto.set'"), 'runtime permission control methods missing');
expect(service.includes('this.#tools.run') && service.includes('await this.#pe3Observe(sessionId, paths, mutation)'), 'foreground tool loop or PE3 mutation feedback missing');
expect(service.includes('this.#permissions.close') && service.includes('run.controller.abort()'), 'shutdown does not abort permission/tool work');

const main = text['src/main/main.mjs'];
const preload = text['src/preload/preload.cjs'];
const renderer = text['src/renderer/permissions.js'];
expect(main.includes('cuppet:permission:reply') && main.includes('cuppet:session:auto:set'), 'Electron main permission bridge missing');
expect(preload.includes('permissions:') && preload.includes('autoSet') && preload.includes('reply:'), 'preload permission bridge missing');
expect(renderer.includes('Allow once') && renderer.includes('Always this exact request') && renderer.includes('Enable guarded auto') && renderer.includes("'reject'"), 'visible permission decision surface incomplete');
expect(text['src/renderer/index.html'].includes('permissions.js'), 'permission UI is not loaded');

expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /opencode/i.test(value)), 'OpenCode leaked into C1 production source');

const tests = [
  'test/c1-permissions.test.mjs',
  'test/provider-tools.test.mjs',
  'test/tool-runtime.test.mjs',
  'test/runtime-c1.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase C1 gate passed: TST exploration/read, runtime tool execution, streamed tool calls, durable audit, permissions, guarded auto, and desktop approval flow verified.');
