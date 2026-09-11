import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
]) {
  await readFile(join(source, required)).catch(() => {
    throw new Error(`Built browserControl runtime is missing ${required}`);
  });
}

const target = join(root, 'vendor', 'browsercontrol');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true, force: true });
await cp(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true, force: true });
await cp(join(source, 'package.json'), join(target, 'package.json'), { force: true });

const manifest = {
  schema: 1,
  vendor: 'Officially-aditya',
  product: 'browserControl',
  package: pkg.name,
  version: pkg.version,
  sourceRevision: String(process.env.BROWSERCONTROL_SOURCE_REVISION || '').trim() || null,
  entry: 'dist/local/runtime.js',
  localPort: 8765,
};
await writeFile(join(target, 'browsercontrol-package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Staged browserControl ${pkg.version} into ${target}`);
