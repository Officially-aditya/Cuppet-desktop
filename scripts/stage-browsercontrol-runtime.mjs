import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceArg = process.argv.find((value) => value.startsWith('--source='))?.slice('--source='.length)
  ?? process.env.BROWSERCONTROL_SOURCE_ROOT
  ?? '';
if (!sourceArg) throw new Error('browserControl source is required: --source=<built browserControl checkout>');

const source = resolve(sourceArg);
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (pkg.name !== 'chrome-computer-use') throw new Error(`Unexpected browserControl package: ${pkg.name || 'unknown'}`);

for (const required of [
  'dist/local/runtime.js',
  'node_modules/@modelcontextprotocol/server/package.json',
  'node_modules/ws/package.json',
  'node_modules/esbuild/bin/esbuild',
]) {
  await readFile(join(source, required)).catch(() => {
    throw new Error(`Built browserControl runtime is missing ${required}`);
  });
}

const target = join(root, 'vendor', 'browsercontrol');
await rm(target, { recursive: true, force: true });
await mkdir(join(target, 'dist', 'local'), { recursive: true });

// electron-builder deliberately filters nested node_modules from extraResources.
// Bundle browserControl and its production dependencies into the local runtime
// so the packaged app is self-contained instead of depending on a module tree
// that will not survive packaging.
const esbuild = join(source, 'node_modules', 'esbuild', 'bin', 'esbuild');
const sourceRuntime = join(source, 'dist', 'local', 'runtime.js');
const targetRuntime = join(target, 'dist', 'local', 'runtime.js');
const bundled = spawnSync(process.execPath, [
  esbuild,
  sourceRuntime,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  '--log-level=warning',
  `--outfile=${targetRuntime}`,
], { cwd: source, encoding: 'utf8' });
if (bundled.status !== 0) {
  throw new Error(`Unable to bundle browserControl runtime: ${(bundled.stderr || bundled.stdout || '').trim()}`);
}

// Keep the remaining compiled output for diagnostics/source-map references and
// future browserControl entrypoints, but ensure the bundled runtime above wins.
await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true, force: true, filter: (src) => resolve(src) !== resolve(sourceRuntime) });
await cp(join(source, 'package.json'), join(target, 'package.json'), { force: true });

const manifest = {
  schema: 1,
  vendor: 'Officially-aditya',
  product: 'browserControl',
  package: pkg.name,
  version: pkg.version,
  sourceRevision: String(process.env.BROWSERCONTROL_SOURCE_REVISION || '').trim() || null,
  entry: 'dist/local/runtime.js',
  bundled: true,
  localPort: 8765,
};
await writeFile(join(target, 'browsercontrol-package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Staged bundled browserControl ${pkg.version} into ${target}`);
