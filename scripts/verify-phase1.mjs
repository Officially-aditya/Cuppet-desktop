import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/main/main.mjs','src/main/runtime-client.mjs','src/runtime/main.mjs','src/runtime/service.mjs','src/runtime/database.mjs','src/runtime/provider.mjs','src/preload/preload.cjs',
  'src/renderer/index.html','src/renderer/main.tsx','src/renderer/react/App.tsx','src/renderer/react/ChatPane.tsx',
];
for (const path of required) await readFile(join(root, path), 'utf8');

const productionFiles = await walk(join(root, 'src'));
for (const path of productionFiles) {
  const text = await readFile(path, 'utf8');
  if (/opencode/i.test(text) && !isProviderIntegrationBoundary(path)) {
    throw new Error(`Phase 1 core production code must not depend on OpenCode: ${relative(root, path)}`);
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.dependencies?.opencode || pkg.devDependencies?.opencode) throw new Error('OpenCode package dependency is forbidden; it must remain an external provider integration');
if (!pkg.devDependencies?.electron) throw new Error('Electron must be pinned for the desktop shell');
if (!pkg.devDependencies?.react || !pkg.devDependencies?.vite || !pkg.devDependencies?.typescript) throw new Error('React/Vite/TypeScript renderer toolchain missing');
if (!pkg.build?.files?.includes('dist-renderer/**/*')) throw new Error('compiled renderer is not packaged');

const host = await readFile(join(root, 'src/main/main.mjs'), 'utf8');
const app = await readFile(join(root, 'src/renderer/react/App.tsx'), 'utf8');
const chat = await readFile(join(root, 'src/renderer/react/ChatPane.tsx'), 'utf8');
if (!/dist-renderer.*index\.html/s.test(host)) throw new Error('Electron does not load the Vite renderer');
if (!app.includes('window.cuppet.sessions.send') || !chat.includes('onSend')) throw new Error('React conversation send surface missing');

await run(process.execPath, ['--test']);
console.log(`Phase 1 gate passed: ${productionFiles.length} production files, provider-independent core runtime, provider integrations isolated at the driver/host boundary, React/Vite renderer, SQLite persistence, provider streaming, and Stop.`);

function isProviderIntegrationBoundary(path) {
  const rel = relative(root, path).split(sep).join('/');
  return rel.startsWith('src/runtime/providers/')
    || rel === 'src/runtime/local-cli-descriptors.mjs'
    || rel === 'src/main/local-provider-operations.mjs'
    || rel.startsWith('src/main/provider-');
}
async function walk(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit' }); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); child.on('error', reject); }); }