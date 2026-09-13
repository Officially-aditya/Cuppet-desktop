import { spawnSync } from 'node:child_process';
import { access, copyFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'build', 'icon.png');
const output = join(root, 'build', 'icon-macos.png');
const CANVAS_SIZE = 1024;

await access(source);

// Apple currently specifies a 1024x1024 square app-icon canvas for macOS and
// applies the platform rounded-rectangle mask itself. Do not shrink the whole
// icon, add transparent padding, or bake a rounded mask into this export.
const sourceInfo = readPngInfo(await readFile(source));
if (sourceInfo.width !== CANVAS_SIZE || sourceInfo.height !== CANVAS_SIZE) {
  throw new Error(
    `macOS app icon source must be ${CANVAS_SIZE}x${CANVAS_SIZE}; got ${sourceInfo.width}x${sourceInfo.height}.`,
  );
}

await rm(output, { force: true });
await copyFile(source, output);

if (process.platform === 'darwin') {
  const properties = run('/usr/bin/sips', [
    '-g', 'pixelWidth',
    '-g', 'pixelHeight',
    output,
  ]);

  if (!/pixelWidth:\s*1024\b/.test(properties) || !/pixelHeight:\s*1024\b/.test(properties)) {
    throw new Error(`Prepared macOS icon has unexpected dimensions:\n${properties}`);
  }
}

console.log('Prepared macOS icon: 1024x1024 unmasked square canvas; macOS applies the system mask.');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '');
}

function readPngInfo(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('macOS app icon source is not a valid PNG.');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('macOS app icon source is missing the PNG IHDR header.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}
