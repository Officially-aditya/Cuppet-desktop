import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/pe3/task-agents.mjs',
  'src/runtime/pe3/router.mjs',
  'src/runtime/pe3/semantic-router.mjs',
  'src/runtime/pe3/local-embedding.mjs',
  'src/runtime/pe3/registry.mjs',
  'src/runtime/service.mjs',
  'src/runtime/database.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/app.js',
  'migration/phase-b2-contract.json',
  'docs/phase-b2-pe3-routing.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

expect(text['src/runtime/pe3/task-agents.mjs'].includes('FINGERPRINT_DECAY = 0.96'), 'weighted task fingerprint decay changed');
expect(text['src/runtime/pe3/task-agents.mjs'].includes('noteWorkspaceChange') && text['src/runtime/pe3/task-agents.mjs'].includes('stalePaths'), 'workspace staleness invalidation missing');
expect(text['src/runtime/pe3/router.mjs'].includes('prepare({sourceSessionId') && text['src/runtime/pe3/router.mjs'].includes('accept(token') && text['src/runtime/pe3/router.mjs'].includes('commit(token') && text['src/runtime/pe3/router.mjs'].includes('abort(token'), 'transactional PE3 handoff states missing');
expect(text['src/runtime/pe3/router.mjs'].includes('explicitReturn') && text['src/runtime/pe3/router.mjs'].includes('semanticReturnOnly'), 'explicit dormant-task return behavior missing');
expect(text['src/runtime/pe3/router.mjs'].includes('normalizeAttachments') && text['src/runtime/pe3/router.mjs'].includes('MAX_ATTACHMENTS=16'), 'bounded attachment routing missing');
expect(text['src/runtime/pe3/semantic-router.mjs'].includes('dormantMatchMin') && text['src/runtime/pe3/semantic-router.mjs'].includes('fallback'), 'conservative semantic routing policy missing');
expect(text['src/runtime/pe3/local-embedding.mjs'].includes("@huggingface/transformers") && text['src/runtime/pe3/local-embedding.mjs'].includes('Xenova/all-MiniLM-L6-v2'), 'local PE3 embedding provider missing');
expect(text['src/runtime/pe3/registry.mjs'].includes('MAX_AGENTS=32') && text['src/runtime/pe3/registry.mjs'].includes("pe3-task-agents.json"), 'bounded project-local PE3 registry missing');
expect(text['src/runtime/pe3/registry.mjs'].includes('fileSignatures') && text['src/runtime/pe3/registry.mjs'].includes('recoveredFromCorruption'), 'offline staleness/corruption recovery missing');
expect(text['src/runtime/database.mjs'].includes('transaction(fn)') && text['src/runtime/database.mjs'].includes('ROLLBACK'), 'SQLite transaction boundary missing');
expect(text['src/runtime/service.mjs'].includes("type: 'pe3.routed'") && text['src/runtime/service.mjs'].includes('[PE3 routing marker]'), 'runtime PE3 target/source projection missing');
expect(text['src/runtime/service.mjs'].includes('this.#db.transaction') && text['src/runtime/service.mjs'].includes('router.commit'), 'runtime handoff is not transactional');
expect(text['src/main/main.mjs'].includes('cuppet:pe3:status') && text['src/preload/preload.cjs'].includes('pe3:'), 'PE3 desktop control surface missing');
expect(text['src/renderer/app.js'].includes("event.type === 'pe3.routed'"), 'renderer does not follow PE3 target session');
expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /opencode/i.test(value)), 'OpenCode leaked into B2 production source');

const tests = [
  'test/pe3-task-agents.test.mjs',
  'test/pe3-semantic-router.test.mjs',
  'test/pe3-registry.test.mjs',
  'test/pe3-transaction.test.mjs',
  'test/pe3-reactivation.test.mjs',
  'test/runtime-pe3.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase B2 gate passed: deterministic/local PE3 routing, persistence, staleness, attachments, and transactional task handoff verified.');
