import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/database.mjs',
  'src/runtime/projects.mjs',
  'src/runtime/service.mjs',
  'src/main/main.mjs',
  'src/preload/preload.cjs',
  'src/renderer/index.html',
  'src/renderer/app.js',
  'test/database-migration.test.mjs',
  'test/database-projects.test.mjs',
  'test/projects.test.mjs',
  'test/runtime-project-binding.test.mjs',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

expect(text['src/runtime/database.mjs'].includes('CREATE TABLE IF NOT EXISTS projects'), 'projects table missing');
expect(text['src/runtime/database.mjs'].includes('project_id'), 'session project binding missing');
expect(text['src/runtime/projects.mjs'].includes("['clone', '--'"), 'Git clone boundary missing');
expect(text['src/runtime/projects.mjs'].includes("GIT_TERMINAL_PROMPT: '0'"), 'noninteractive Git clone missing');
expect(text['src/runtime/projects.mjs'].includes('GITHUB_URL_CREDENTIALS'), 'credential-bearing URL rejection missing');
expect(text['src/runtime/projects.mjs'].includes('isDescendantPath'), 'clone path containment missing');
expect(text['src/runtime/projects.mjs'].includes("segment === '..'"), 'dot-segment repository rejection missing');
expect(text['src/runtime/projects.mjs'].includes("'user/repos'"), 'authenticated repository picker missing');
expect(text['src/runtime/service.mjs'].includes("case 'project.github-clone'"), 'project clone runtime method missing');
expect(text['src/runtime/service.mjs'].includes('projectId:existing.projectId??null'), 'run project binding missing');
expect(text['src/main/main.mjs'].includes('dialog.showOpenDialog'), 'native folder picker missing');
expect(text['src/preload/preload.cjs'].includes('githubClone') && text['src/preload/preload.cjs'].includes('chooseFolder'), 'narrow project preload surface missing');
expect(text['src/renderer/index.html'].includes('Local folder') && text['src/renderer/index.html'].includes('GitHub URL') && text['src/renderer/index.html'].includes('GitHub repositories'), 'three Add project paths missing');
expect(text['src/renderer/app.js'].includes('state.draft') && text['src/renderer/app.js'].includes('createPersistedSessionForDraft'), 'first-message persistence draft behavior missing');
expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /opencode/i.test(value)), 'OpenCode leaked into Phase B production source');

const testRun = spawnSync(process.execPath, [
  '--test',
  'test/database-migration.test.mjs',
  'test/database-projects.test.mjs',
  'test/projects.test.mjs',
  'test/runtime-project-binding.test.mjs',
], { stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase B gate passed: projects, clone/auth recovery, containment, project-bound chats, migration, and switching semantics verified.');
