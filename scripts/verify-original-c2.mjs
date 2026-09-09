import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listCommands, parseSlashCommand } from '../src/runtime/commands.mjs';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'package.json',
  'src/runtime/commands.mjs',
  'src/runtime/service.mjs',
  'src/runtime/tst-client.mjs',
  'src/runtime/remote/commands.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/cli/main.mjs',
  'src/renderer/app.js',
  'src/renderer/commands.js',
  'src/renderer/commands.css',
  'src/renderer/index.html',
  'migration/original-c2-contract.json',
  'docs/original-c2-command-surface.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const dense = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, value.replace(/\s+/g, '')]));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const expectedSlash = [
  'status','doctor','remote','remote-stop','memory','auto','background','orchestrator',
  'platform','effort','steer','abort','plan','compact','undo','models',
];
const expectedPalette = [
  'cuppet.memory.remember','cuppet.memory.forget','cuppet.memory.clear',
  'cuppet.background.pause','cuppet.background.resume','cuppet.steer.interrupt','cuppet.plan.agent',
];
const registry = listCommands();
expect(registry.filter((item) => !item.paletteOnly).map((item) => item.slash).join('|') === expectedSlash.join('|'), 'reviewed slash command inventory changed');
expect(registry.filter((item) => item.paletteOnly).map((item) => item.id).join('|') === expectedPalette.join('|'), 'reviewed palette action inventory changed');
expect(new Set(registry.map((item) => item.id)).size === registry.length, 'command IDs are not unique');
expect(parseSlashCommand('/remote-control').id === 'remote', '/remote-control alias changed');
expect(parseSlashCommand('/login').id === 'platform', '/login alias changed');
expect(parseSlashCommand('/models').id === 'models', '/models must remain canonical');
expect(parseSlashCommand('/model').kind === 'unknown', '/model must remain excluded from original C2');
expect(parseSlashCommand('normal prompt').kind === 'prompt', 'normal prompt parsing changed');

const pkg = JSON.parse(text['package.json']);
expect(pkg.version === '0.9.0-alpha.1', 'original C2 package version must be 0.9.0-alpha.1');
expect(pkg.scripts?.['original-c2:verify'] === 'node scripts/verify-original-c2.mjs', 'original C2 verifier script is not registered');

const contract = JSON.parse(text['migration/original-c2-contract.json']);
expect(contract.phase === 'original-C2' && contract.status === 'implemented-candidate', 'original C2 machine contract identity invalid');
expect(contract.targetVersion === '0.9.0-alpha.1', 'original C2 target version contract changed');
expect(contract.slashCommands.join('|') === expectedSlash.join('|'), 'machine contract slash inventory drifted');
expect(contract.paletteActions.join('|') === expectedPalette.join('|'), 'machine contract palette inventory drifted');
expect(contract.excludedSlashCommands?.includes('model'), 'machine contract must exclude /model');
for (const key of [
  'canonicalRegistrySharedAcrossSurfaces',
  'recognizedSlashBypassesProviderInference',
  'unknownSlashBypassesProviderInference',
  'commandExecutionDoesNotCreateVisibleTranscriptMessages',
  'desktopLocalCommandsDoNotRequireConfiguredProvider',
  'remoteInnerCommandScopeReauthorization',
  'runtimeOwnsSteerAuthority',
  'noSecondSessionOrSettingsStore',
]) expect(contract.requirements?.[key] === true, `original C2 contract requirement missing: ${key}`);

const commands = text['src/runtime/commands.mjs'];
expect(commands.includes('const MAX_COMMAND_TEXT = 8192') && commands.includes('const MAX_ARGUMENTS = 32'), 'command parser bounds changed');
expect(commands.includes("case 'steer'") && commands.includes("call('session.steer'"), 'registry steer does not delegate to runtime authority');
for (const id of expectedPalette) expect(commands.includes(`'${id}'`), `palette command missing from registry source: ${id}`);

const service = text['src/runtime/service.mjs'];
expect(service.includes("const slash = parseSlashCommand(text)") && service.includes('must be executed through the command registry') && service.includes('Unknown Cuppet command'), 'runtime slash inference boundary is missing');
expect(service.includes("case 'session.steer': return this.#steer(params)"), 'runtime does not own session.steer');
for (const method of ['memory.remember','memory.forget','memory.clear']) expect(service.includes(`case '${method}'`), `runtime explicit memory authority missing: ${method}`);

const tst = text['src/runtime/tst-client.mjs'];
expect(tst.includes("memory.remember") && tst.includes("memory.forget") && tst.includes('clear_scope'), 'TST explicit memory bridge is incomplete');

const main = text['src/main/main.mjs']; const mainDense = dense['src/main/main.mjs'];
expect(main.includes("cuppet:command:list") && main.includes("cuppet:command:execute"), 'Electron command IPC is missing');
expect(main.includes('parseSlashCommand(text)') && main.includes("if (parsed.kind === 'command') return executeDesktopCommand"), 'Desktop send does not intercept slash commands before runtime inference');
expect(main.includes('validateCommandInput') && main.includes("['session', 'project', 'global'].includes(record.scope)") && main.includes("['plan', 'build'].includes(record.mode)"), 'structured command input boundary is not allowlisted');
expect(!mainDense.includes('method===\'session.steer\'?'), 'Desktop must not maintain a second steer implementation');

const preload = text['src/preload/preload.cjs'];
expect(preload.includes("cuppet:command:list") && preload.includes("cuppet:command:execute"), 'preload command bridge missing');

const remote = text['src/runtime/remote/commands.mjs'];
expect(remote.includes("parseSlashCommand(prompt)") && remote.includes("parsed.definition?.scope") && remote.includes("actor.scopes?.includes?.(required)"), 'Remote inner command scope reauthorization is missing');
expect(remote.includes("this.#call('session.steer'"), 'Remote steer does not delegate to runtime authority');
expect(!remote.includes("await this.#call('session.stop',{sessionId}).catch"), 'Remote still owns a stop/wait/send steer loop');

const cli = text['src/cli/main.mjs'];
expect(cli.includes('executeCommand, listCommands, parseSlashCommand') && cli.includes("command==='commands'") && cli.includes("command==='command'"), 'headless CLI does not share command registry');
expect(cli.includes("const slash=parseSlashCommand(prompt)") && cli.includes("slash.kind==='command'"), 'headless prompt slash interception is missing');

const app = text['src/renderer/app.js'];
expect(app.includes("!text.startsWith('/')&&"), 'Desktop still requires provider readiness for local slash commands');
expect(app.includes('document.body.dataset.cuppetSessionId') && app.includes('delete document.body.dataset.cuppetSessionId'), 'renderer session-ID-only command projection is missing');

const renderer = text['src/renderer/commands.js'];
expect(renderer.includes("composer.addEventListener('submit'") && renderer.includes('stopImmediatePropagation()'), 'renderer slash submit interception is missing');
expect(renderer.includes("prompt.addEventListener('input'") && renderer.includes('currentQuery()') && renderer.includes("value.startsWith('/')"), 'typed slash command palette activation is missing');
expect(renderer.includes("window.cuppet.commands.execute") && renderer.includes("{ id: item.id, input }"), 'renderer structured palette execution is missing');
expect(renderer.includes('if (item.paletteOnly)') && renderer.includes("item.paletteOnly ? 'action'"), 'renderer does not generically project palette-only registry actions');
for (const id of ['cuppet.memory.remember','cuppet.memory.forget','cuppet.memory.clear','cuppet.steer.interrupt','cuppet.plan.agent']) expect(renderer.includes(`'${id}'`), `renderer custom-input palette action UI missing: ${id}`);
expect(renderer.includes('window.confirm') && renderer.includes('Clear memory scope'), 'memory clear confirmation is missing');
expect(renderer.includes('commandForm') && renderer.includes('maxLength: 8192'), 'bounded command form controls are missing');

const index = text['src/renderer/index.html']; const commandCssDense = dense['src/renderer/commands.css'];
expect(index.includes('commands.css') && index.includes('commands.js'), 'command surface assets are not loaded');
expect(!index.includes('/ for commands') && !index.includes('composer-hint'), 'removed composer command hint returned');
expect(commandCssDense.includes('.command-trigger{display:none!important}'), 'visible slash trigger must remain hidden while typed slash activation stays available');

for (const script of [
  'src/runtime/commands.mjs','src/runtime/service.mjs','src/runtime/remote/commands.mjs',
  'src/main/main.mjs','src/cli/main.mjs','src/renderer/commands.js',
]) {
  const checked = spawnSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}

const tests = [
  'test/original-c2-commands.test.mjs',
  'test/original-c2-runtime-boundary.test.mjs',
  'test/original-c2-remote.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);

console.log('Original C2 gate passed: canonical command inventory, typed slash/palette surface, inference/transcript isolation, Desktop/headless/Remote reuse, bounded palette actions, inner Remote scopes, and runtime-owned steer verified.');
