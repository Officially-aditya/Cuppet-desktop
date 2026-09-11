import { spawnSync } from 'node:child_process';
import { access, copyFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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

const rgba = decodeRgbaPng(await readFile(output));
for (const [x, y] of [[0, 0], [CANVAS_SIZE - 1, 0], [0, CANVAS_SIZE - 1], [CANVAS_SIZE - 1, CANVAS_SIZE - 1]]) {
  if (rgba.pixelAlpha(x, y) !== 0) {
    throw new Error(`Prepared macOS icon padding is not transparent at ${x},${y}.`);
  }
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

function decodeRgbaPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Prepared macOS icon is not a PNG.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width !== CANVAS_SIZE || height !== CANVAS_SIZE || bitDepth !== 8 || colorType !== 6) {
    throw new Error(`Prepared macOS icon must be 8-bit RGBA PNG; got ${width}x${height}, depth ${bitDepth}, type ${colorType}.`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const row = raw.subarray(sourceOffset, sourceOffset + stride);
    sourceOffset += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      if (filter === 0) out[x] = row[x];
      else if (filter === 1) out[x] = (row[x] + left) & 0xff;
      else if (filter === 2) out[x] = (row[x] + up) & 0xff;
      else if (filter === 3) out[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) out[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}.`);
    }
  }
  return {
    pixelAlpha(x, y) {
      return pixels[(y * width + x) * bytesPerPixel + 3];
    },
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
