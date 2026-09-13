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
  if (isProviderIntegrationBoundary(path)) continue;
  const text = await readFile(path, 'utf8');
  if (hasOpenCodeModuleDependency(text)) {
    throw new Error(`Phase 1 core production code must not import or require OpenCode: ${relative(root, path)}`);
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.dependencies?.opencode || pkg.devDependencies?.opencode || pkg.dependencies?.['opencode-ai'] || pkg.devDependencies?.['opencode-ai']) {
  throw new Error('OpenCode package dependency is forbidden; it must remain an external provider integration');
}
if (!pkg.devDependencies?.electron) throw new Error('Electron must be pinned for the desktop shell');
if (!pkg.devDependencies?.react || !pkg.devDependencies?.vite || !pkg.devDependencies?.typescript) throw new Error('React/Vite/TypeScript renderer toolchain missing');
if (!pkg.build?.files?.includes('dist-renderer/**/*')) throw new Error('compiled renderer is not packaged');

const host = await readFile(join(root, 'src/main/main.mjs'), 'utf8');
const app = await readFile(join(root, 'src/renderer/react/App.tsx'), 'utf8');
const chat = await readFile(join(root, 'src/renderer/react/ChatPane.tsx'), 'utf8');
if (!/dist-renderer.*index\.html/s.test(host)) throw new Error('Electron does not load the Vite renderer');
if (!app.includes('window.cuppet.sessions.send') || !chat.includes('onSend')) throw new Error('React conversation send surface missing');

// Node's default --test discovery also treats executable provider fixtures under
// test/fixtures as test files. Those fixtures are intentionally long-lived stdio
// servers and therefore time out when executed directly. Run only actual test
// modules. Runtime integration tests mutate process-wide env and depend on brief
// permission/abort lifecycle windows, so serialize the suite instead of allowing
// unrelated files to interfere with those contracts under CI load. Keep force-exit
// for tests that intentionally leave runtime handles alive. Capture reporter output
// off the GitHub Actions stdout pipe, but wait for the child `close` event: unlike
// `exit`, `close` is emitted only after stdout/stderr have fully drained. This keeps
// a nonzero exit diagnostic instead of truncating the failing TAP record/summary.
const testFiles = (await walk(join(root, 'test')))
  .filter((path) => /\.test\.(?:mjs|js|cjs)$/.test(path))
  .map((path) => relative(root, path))
  .sort();
if (!testFiles.length) throw new Error('No Phase 1 test files found');
await runCaptured(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=120000', ...testFiles], { timeoutMs: 240000 });
console.log(`Phase 1 gate passed: ${productionFiles.length} production files, ${testFiles.length} serialized test files, provider-independent core runtime, provider integrations isolated at the driver/host boundary, React/Vite renderer, SQLite persistence, provider streaming, and Stop.`);

function hasOpenCodeModuleDependency(text) {
  return /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*opencode[^'"]*['"]/i.test(text);
}
function isProviderIntegrationBoundary(path) {
  const rel = relative(root, path).split(sep).join('/');
  return rel.startsWith('src/runtime/providers/')
    || rel === 'src/runtime/local-cli-descriptors.mjs'
    || rel === 'src/main/main.mjs'
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
function runCaptured(command, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let settled = false;
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));

    const replay = () => {
      if (!chunks.length) return;
      process.stdout.write(chunks.join(''));
      chunks.length = 0;
    };
    const finish = (fn) => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      replay();
      fn();
      return true;
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : undefined;
    timer?.unref?.();

    child.on('close', (code, signal) => {
      finish(() => {
        if (timedOut) reject(new Error(`${command} exceeded ${timeoutMs}ms`));
        else if (code === 0) resolve();
        else reject(new Error(`${command} exited ${code ?? `via ${signal ?? 'unknown signal'}`}`));
      });
    });
    child.on('error', (error) => finish(() => reject(error)));
  });
}
