import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'package.json',
  'migration/d1-contract.json',
  'docs/d1-search-navigation.md',
  'src/runtime/database.mjs',
  'src/runtime/main.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/index.html',
  'src/renderer/d1-navigation.js',
  'src/renderer/navigation.css',
  'src/renderer/execution-ui.mjs',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(text['package.json']);
expect(pkg.scripts?.['d1:verify'] === 'node scripts/verify-d1.mjs', 'D1 verifier script is not registered');

const contract = JSON.parse(text['migration/d1-contract.json']);
expect(contract.phase === 'D1' && contract.status === 'implemented-candidate', 'D1 machine contract identity invalid');
for (const [key, value] of Object.entries(contract.requirements ?? {})) expect(value === true, `D1 contract requirement missing: ${key}`);

const database = text['src/runtime/database.mjs'];
expect(database.includes('CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5'), 'SQLite FTS5 search projection is missing');
expect(database.includes("m.status <> 'streaming'"), 'streaming assistant messages must not enter rebuilt search index');
expect(database.includes("if(nextStatus!=='streaming') this.#upsertSearchMessage(id)"), 'terminal assistant search indexing is missing');
expect(database.includes('archiveSession(') && database.includes('deleteSession(') && database.includes('renameSession('), 'chat lifecycle storage methods are incomplete');
expect(database.includes("archivedClause=includeArchived?'':'AND s.archived_at IS NULL'"), 'archived chats are not excluded from search by default');
expect(database.includes('function ftsQuery') && database.includes("join(' AND ')"), 'bounded FTS query lowering is missing');

const runtime = text['src/runtime/main.mjs'];
for (const method of ['session.search','session.rename','session.archive','session.restore','session.delete','project.rename']) expect(runtime.includes(`case '${method}'`), `runtime host missing ${method}`);
expect(runtime.includes('assertSessionIdle') && runtime.includes('queued messages') && runtime.includes('generating'), 'archive/delete active-work guard is missing');

const main = text['src/main/main.mjs'];
const preload = text['src/preload/preload.cjs'];
for (const channel of ['session:search','session:rename','session:archive','session:restore','session:delete','project:rename']) {
  expect(main.includes(`cuppet:${channel}`), `Electron IPC missing ${channel}`);
  expect(preload.includes(`cuppet:${channel}`), `preload bridge missing ${channel}`);
}

const index = text['src/renderer/index.html'];
expect(index.includes('id="search-button"') && !index.match(/id="search-button"[^>]*disabled/), 'Search navigation is not visibly enabled');
expect(index.includes('d1-navigation.js'), 'D1 navigation renderer is not loaded');
expect(index.includes('type="module" src="execution-ui.mjs"'), 'execution/Markdown renderer is not on the desktop boot path');

const renderer = text['src/renderer/d1-navigation.js'];
for (const token of ['sessions.search','sessions.rename','sessions.archive','sessions.restore','sessions.delete','projects.rename']) expect(renderer.includes(token), `renderer projection missing ${token}`);
expect(renderer.includes('cuppet.desktop.last-session') && renderer.includes('cuppet.desktop.scroll.'), 'presentation-state restore is missing');
expect(renderer.includes('stickyToBottom') && renderer.includes('user-scrolled'), 'streaming scroll preservation is missing');
expect(renderer.includes("event.metaKey || event.ctrlKey") && renderer.includes("key.toLowerCase() === 'k'"), 'Cmd/Ctrl+K search shortcut is missing');
expect(renderer.includes('scrollIntoView') && renderer.includes('search-hit'), 'exact message result navigation is missing');

for (const script of ['src/runtime/database.mjs','src/runtime/main.mjs','src/main/main.mjs','src/preload/preload.cjs','src/renderer/d1-navigation.js']) {
  const checked = spawnSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}

const tests = ['test/d1-search-lifecycle.test.mjs','test/d1-renderer-contract.test.mjs'];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);

console.log('D1 gate passed: local FTS search, lifecycle operations, exact message navigation, archived recovery, state restoration, and live-scroll behavior verified.');
