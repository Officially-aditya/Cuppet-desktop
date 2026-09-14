import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'build', 'icon.png');
const output = join(root, 'build', 'icon-macos.png');
const CANVAS_SIZE = 1024;

await access(source);

// Keep Apple's 1024x1024 square icon canvas and leave the rounded-rectangle
// mask to macOS. For the macOS asset only, flatten the source transparency
// onto solid white so the Cuppet mark sits on a white background without
// shrinking or otherwise changing the artwork footprint.
const sourceBuffer = await readFile(source);
const sourceInfo = readPngInfo(sourceBuffer);
if (sourceInfo.width !== CANVAS_SIZE || sourceInfo.height !== CANVAS_SIZE) {
  throw new Error(
    `macOS app icon source must be ${CANVAS_SIZE}x${CANVAS_SIZE}; got ${sourceInfo.width}x${sourceInfo.height}.`,
  );
}
if (sourceInfo.bitDepth !== 8 || sourceInfo.colorType !== 6 || sourceInfo.interlaceMethod !== 0) {
  throw new Error(
    `macOS app icon source must be a non-interlaced 8-bit RGBA PNG; got bitDepth=${sourceInfo.bitDepth}, colorType=${sourceInfo.colorType}, interlace=${sourceInfo.interlaceMethod}.`,
  );
}

await rm(output, { force: true });
await writeFile(output, flattenRgbaPngOntoWhite(sourceBuffer, sourceInfo));

const outputInfo = readPngInfo(await readFile(output));
if (outputInfo.width !== CANVAS_SIZE || outputInfo.height !== CANVAS_SIZE) {
  throw new Error(
    `Prepared macOS icon must be ${CANVAS_SIZE}x${CANVAS_SIZE}; got ${outputInfo.width}x${outputInfo.height}.`,
  );
}

if (process.platform === 'darwin') {
  const properties = run('/usr/bin/sips', [
    '-g', 'pixelWidth',
    '-g', 'pixelHeight',
    '-g', 'hasAlpha',
    output,
  ]);

  if (!/pixelWidth:\s*1024\b/.test(properties) || !/pixelHeight:\s*1024\b/.test(properties)) {
    throw new Error(`Prepared macOS icon has unexpected dimensions:\n${properties}`);
  }
}

console.log('Prepared macOS icon: 1024x1024 Cuppet artwork flattened onto solid white; macOS applies the system mask.');

function flattenRgbaPngOntoWhite(buffer, info) {
  const chunks = readPngChunks(buffer);
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (!compressed.length) throw new Error('macOS app icon source has no PNG IDAT data.');

  const bytesPerPixel = 4;
  const stride = info.width * bytesPerPixel;
  const inflated = inflateSync(compressed);
  const expectedLength = info.height * (stride + 1);
  if (inflated.length !== expectedLength) {
    throw new Error(`Unexpected PNG scanline length: expected ${expectedLength}, got ${inflated.length}.`);
  }

  const decoded = Buffer.alloc(info.height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < info.height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousOffset = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? decoded[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? decoded[previousOffset + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? decoded[previousOffset + x - bytesPerPixel] : 0;
      let predictor = 0;

      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter type ${filter}.`);

      decoded[rowOffset + x] = (raw + predictor) & 0xff;
    }
    sourceOffset += stride;
  }

  const flattened = Buffer.alloc(info.height * (stride + 1));
  let outputOffset = 0;
  for (let y = 0; y < info.height; y += 1) {
    flattened[outputOffset] = 0;
    outputOffset += 1;
    const rowOffset = y * stride;

    for (let x = 0; x < stride; x += 4) {
      const r = decoded[rowOffset + x];
      const g = decoded[rowOffset + x + 1];
      const b = decoded[rowOffset + x + 2];
      const alpha = decoded[rowOffset + x + 3];
      const inverseAlpha = 255 - alpha;

      flattened[outputOffset + x] = Math.floor((r * alpha + 255 * inverseAlpha + 127) / 255);
      flattened[outputOffset + x + 1] = Math.floor((g * alpha + 255 * inverseAlpha + 127) / 255);
      flattened[outputOffset + x + 2] = Math.floor((b * alpha + 255 * inverseAlpha + 127) / 255);
      flattened[outputOffset + x + 3] = 255;
    }
    outputOffset += stride;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(info.width, 0);
  ihdr.writeUInt32BE(info.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', deflateSync(flattened, { level: 9 })),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function readPngChunks(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('macOS app icon source is not a valid PNG.');
  }

  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) throw new Error('macOS app icon source contains a truncated PNG chunk.');

    const type = buffer.toString('ascii', typeStart, dataStart);
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return chunks;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

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
  if (buffer.length < 29 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('macOS app icon source is not a valid PNG.');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('macOS app icon source is missing the PNG IHDR header.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    compressionMethod: buffer[26],
    filterMethod: buffer[27],
    interlaceMethod: buffer[28],
  };
}
