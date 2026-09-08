import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/context-compiler.mjs',
  'src/runtime/lossless-plan.mjs',
  'src/runtime/tst-client.mjs',
  'src/runtime/candidate-ledger.mjs',
  'src/runtime/background-enricher.mjs',
  'src/runtime/cognitive-state.mjs',
  'src/runtime/service.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/index.html',
  'src/renderer/app.js',
  'src/main/provider-settings.mjs',
  'migration/phase-b1-contract.json',
  'docs/phase-b1-cognitive-runtime.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

expect(text['src/runtime/context-compiler.mjs'].includes('Math.min(2_048, Math.max(512, Math.floor(usableTokens * 0.04)))'), 'foreground context budget changed');
expect(text['src/runtime/context-compiler.mjs'].includes('Math.min(16_384, Math.max(0, Math.floor(usableTokens * 0.12)))'), 'plan context budget changed');
expect(text['src/runtime/context-compiler.mjs'].includes("mode: 'orchestrator', injected: false"), 'orchestrator must bypass automatic injection');
expect(text['src/runtime/context-compiler.mjs'].includes('observationComplete') && text['src/runtime/context-compiler.mjs'].includes('hasStm'), 'fail-closed history trimming guards missing');
expect(text['src/runtime/lossless-plan.mjs'].includes('prompt: sourcePrompt'), 'lossless plan no longer preserves exact source');
expect(text['src/runtime/tst-client.mjs'].includes("TST_PROTOCOL_VERSION = 'cuppet.tst.v3'"), 'TST v3 protocol contract missing');
expect(text['src/runtime/background-enricher.mjs'].includes("provenance: 'model_candidate'"), 'background model candidate provenance missing');
expect(text['src/runtime/background-enricher.mjs'].includes('!this.#tst?.configured'), 'background work must gate on TST availability');
expect(text['src/runtime/candidate-ledger.mjs'].includes('if (observation.trustedSupport)'), 'model canonicalization must not count as evidence by itself');
expect(text['src/runtime/service.mjs'].includes('context.compiled'), 'runtime context compilation event missing');
expect(text['src/runtime/service.mjs'].includes("roles: { foreground: 'primary', plan: 'primary', background: 'secondary'"), 'model role contract missing');
expect(text['src/preload/preload.cjs'].includes('modeSet') && text['src/preload/preload.cjs'].includes('orchestratorSet') && text['src/preload/preload.cjs'].includes('backgroundPause'), 'cognitive preload surface missing');
expect(text['src/renderer/index.html'].includes('mode-toggle') && text['src/renderer/index.html'].includes('orchestrator-toggle') && text['src/renderer/index.html'].includes('background-toggle'), 'visible cognitive controls missing');
expect(text['src/main/provider-settings.mjs'].includes('backgroundModel'), 'secondary model setting missing');
expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /opencode/i.test(value)), 'OpenCode leaked into B1 production source');

const tests = [
  'test/context-compiler.test.mjs',
  'test/lossless-plan.test.mjs',
  'test/candidate-ledger.test.mjs',
  'test/background-enricher.test.mjs',
  'test/cognitive-state.test.mjs',
  'test/runtime-cognitive.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase B1 gate passed: detached context, plans, TST contracts, evidence-gated background memory, and cognitive controls verified.');
