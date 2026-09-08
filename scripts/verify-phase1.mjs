import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/main/main.mjs',
  'src/main/runtime-client.mjs',
  'src/runtime/main.mjs',
  'src/runtime/service.mjs',
  'src/runtime/database.mjs',
  'src/runtime/provider.mjs',
  'src/preload/preload.cjs',
  'src/renderer/index.html',
  'src/renderer/app.js',
];
for (const path of required) await readFile(join(root, path), 'utf8');

const productionFiles = await walk(join(root, 'src'));
for (const path of productionFiles) {
  const text = await readFile(path, 'utf8');
  if (/opencode/i.test(text)) throw new Error(`Phase 1 production code must not depend on OpenCode: ${relative(root, path)}`);
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.dependencies?.opencode || pkg.devDependencies?.opencode) throw new Error('OpenCode dependency is forbidden');
if (!pkg.devDependencies?.electron) throw new Error('Electron must be pinned for the desktop shell');

await run(process.execPath, ['--test']);
console.log(`Phase 1 gate passed: ${productionFiles.length} production files, independent runtime, SQLite persistence, provider streaming, Stop, no OpenCode dependency.`);

async function walk(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    child.on('error', reject);
  });
}
