import { spawnSync } from 'node:child_process';
import { access, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'build', 'icon.png');
const output = join(root, 'build', 'icon-macos.png');
const resized = join(root, 'build', '.icon-macos-content.png');

const CANVAS_SIZE = 512;
// Apple's current rounded-rectangle icon grid leaves substantially more breathing
// room than an edge-to-edge legacy PNG. 412 / 512 ~= 80.5%, matching that
// optical footprint without changing the Cuppet artwork itself.
const ARTWORK_SIZE = 412;

await access(source);

if (process.platform !== 'darwin') {
  // Keep non-mac packaging commands deterministic. Electron Builder only consumes
  // this asset for macOS, but having the file present avoids config-resolution
  // surprises on other hosts.
  await copyFile(source, output);
  console.log(`macOS icon preparation skipped on ${process.platform}; copied source icon.`);
  process.exit(0);
}

await rm(resized, { force: true });
await rm(output, { force: true });

run('/usr/bin/sips', [
  '--resampleHeightWidth', String(ARTWORK_SIZE), String(ARTWORK_SIZE),
  source,
  '--out', resized,
]);
run('/usr/bin/sips', [
  '--padToHeightWidth', String(CANVAS_SIZE), String(CANVAS_SIZE),
  resized,
  '--out', output,
]);

const properties = run('/usr/bin/sips', [
  '-g', 'pixelWidth',
  '-g', 'pixelHeight',
  '-g', 'hasAlpha',
  output,
], true);

if (!/pixelWidth:\s*512\b/.test(properties) || !/pixelHeight:\s*512\b/.test(properties)) {
  throw new Error(`Prepared macOS icon has unexpected dimensions:\n${properties}`);
}
if (!/hasAlpha:\s*yes\b/i.test(properties)) {
  throw new Error(`Prepared macOS icon lost transparency:\n${properties}`);
}

await rm(resized, { force: true });
console.log(`Prepared macOS icon: ${ARTWORK_SIZE}px artwork centered on ${CANVAS_SIZE}px transparent canvas.`);

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return capture ? String(result.stdout || '') : '';
}
