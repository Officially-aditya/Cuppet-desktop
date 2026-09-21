import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'build', 'icon.png');
const output = join(root, 'build', 'icon-macos.png');
const CANVAS_SIZE = 1024;

await access(source);

function readPngRgba(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const compressed = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const inflated = inflateSync(compressed);
  const stride = width * 4;
  const decoded = Buffer.alloc(height * stride);

  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[srcOff++];
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[srcOff + x];
      const left = x >= 4 ? decoded[rowOff + x - 4] : 0;
      const up = y > 0 ? decoded[prevOff + x] : 0;
      const upLeft = y > 0 && x >= 4 ? decoded[prevOff + x - 4] : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLeft);
      }
      decoded[rowOff + x] = (raw + pred) & 0xff;
    }
    srcOff += stride;
  }
  return { width, height, data: decoded };
}

function writePngRgba(width, height, data) {
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    data.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  function chunk(type, d) {
    const t = Buffer.from(type, 'ascii');
    const b = Buffer.concat([t, d]);
    const res = Buffer.alloc(12 + d.length);
    res.writeUInt32BE(d.length, 0);
    t.copy(res, 4);
    d.copy(res, 8);
    let crc = 0xffffffff;
    for (const byte of b) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    res.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + d.length);
    return res;
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function isInSquircle(px, py, cx, cy, rx, ry, p = 4.5) {
  const nx = Math.abs(px - cx) / rx;
  const ny = Math.abs(py - cy) / ry;
  return Math.pow(nx, p) + Math.pow(ny, p) <= 1.0;
}

function squircleCoverage(px, py, cx, cy, rx, ry, p = 4.5) {
  let inside = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const subX = px + (sx + 0.5) / 4 - 0.5;
      const subY = py + (sy + 0.5) / 4 - 0.5;
      if (isInSquircle(subX, subY, cx, cy, rx, ry, p)) inside++;
    }
  }
  return inside / 16;
}

const sourceData = readPngRgba(await readFile(source));
const outputData = Buffer.alloc(CANVAS_SIZE * CANVAS_SIZE * 4);

const tileCx = 512;
const tileCy = 508;
const tileRx = 412;
const tileRy = 412;

const scale = 0.72;
const birdTargetCx = 512;
const birdTargetCy = 504;
const birdSrcCx = 552;
const birdSrcCy = 507;

for (let y = 0; y < CANVAS_SIZE; y++) {
  for (let x = 0; x < CANVAS_SIZE; x++) {
    const idx = (y * CANVAS_SIZE + x) * 4;

    const shadowAlpha = squircleCoverage(x, y - 16, tileCx, tileCy, tileRx + 8, tileRy + 8, 4.0) * 0.18;
    const shadowAlpha2 = squircleCoverage(x, y - 8, tileCx, tileCy, tileRx + 4, tileRy + 4, 4.2) * 0.12;
    const totalShadow = Math.min(1.0, shadowAlpha + shadowAlpha2);

    const tileCov = squircleCoverage(x, y, tileCx, tileCy, tileRx, tileRy, 4.4);

    let r = 0, g = 0, b = 0, a = 0;

    if (totalShadow > 0 && tileCov < 1.0) {
      const sA = totalShadow * (1.0 - tileCov);
      r = 0;
      g = 0;
      b = 0;
      a = Math.floor(sA * 255);
    }

    if (tileCov > 0) {
      const grad = 1.0 - (y - (tileCy - tileRy)) / (tileRy * 2) * 0.03;
      const tileR = Math.floor(255 * grad);
      const tileG = Math.floor(255 * grad);
      const tileB = Math.min(255, Math.floor(255 * grad + 1));
      const tileA = Math.floor(tileCov * 255);

      const outA = tileA + Math.floor(a * (255 - tileA) / 255);
      if (outA > 0) {
        r = Math.floor((tileR * tileA + r * a * (255 - tileA) / 255) / outA);
        g = Math.floor((tileG * tileA + g * a * (255 - tileA) / 255) / outA);
        b = Math.floor((tileB * tileA + b * a * (255 - tileA) / 255) / outA);
        a = outA;
      }
    }

    outputData[idx] = r;
    outputData[idx + 1] = g;
    outputData[idx + 2] = b;
    outputData[idx + 3] = a;
  }
}

for (let y = 0; y < CANVAS_SIZE; y++) {
  for (let x = 0; x < CANVAS_SIZE; x++) {
    const tileCov = squircleCoverage(x, y, tileCx, tileCy, tileRx, tileRy, 4.4);
    if (tileCov <= 0) continue;

    const srcX = (x - birdTargetCx) / scale + birdSrcCx;
    const srcY = (y - birdTargetCy) / scale + birdSrcCy;

    if (srcX >= 0 && srcX < sourceData.width - 1 && srcY >= 0 && srcY < sourceData.height - 1) {
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = srcX - x0;
      const fy = srcY - y0;

      const idx00 = (y0 * sourceData.width + x0) * 4;
      const idx10 = (y0 * sourceData.width + x1) * 4;
      const idx01 = (y1 * sourceData.width + x0) * 4;
      const idx11 = (y1 * sourceData.width + x1) * 4;

      const bA = (
        sourceData.data[idx00 + 3] * (1 - fx) * (1 - fy) +
        sourceData.data[idx10 + 3] * fx * (1 - fy) +
        sourceData.data[idx01 + 3] * (1 - fx) * fy +
        sourceData.data[idx11 + 3] * fx * fy
      ) / 255 * tileCov;

      if (bA > 0.001) {
        const bR = (
          sourceData.data[idx00] * (1 - fx) * (1 - fy) +
          sourceData.data[idx10] * fx * (1 - fy) +
          sourceData.data[idx01] * (1 - fx) * fy +
          sourceData.data[idx11] * fx * fy
        );
        const bG = (
          sourceData.data[idx00 + 1] * (1 - fx) * (1 - fy) +
          sourceData.data[idx10 + 1] * fx * (1 - fy) +
          sourceData.data[idx01 + 1] * (1 - fx) * fy +
          sourceData.data[idx11 + 1] * fx * fy
        );
        const bB = (
          sourceData.data[idx00 + 2] * (1 - fx) * (1 - fy) +
          sourceData.data[idx10 + 2] * fx * (1 - fy) +
          sourceData.data[idx01 + 2] * (1 - fx) * fy +
          sourceData.data[idx11 + 2] * fx * fy
        );

        const outIdx = (y * CANVAS_SIZE + x) * 4;
        const bgR = outputData[outIdx];
        const bgG = outputData[outIdx + 1];
        const bgB = outputData[outIdx + 2];
        const bgA = outputData[outIdx + 3] / 255;

        const finalA = bA + bgA * (1 - bA);
        outputData[outIdx] = Math.round((bR * bA + bgR * bgA * (1 - bA)) / finalA);
        outputData[outIdx + 1] = Math.round((bG * bA + bgG * bgA * (1 - bA)) / finalA);
        outputData[outIdx + 2] = Math.round((bB * bA + bgB * bgA * (1 - bA)) / finalA);
        outputData[outIdx + 3] = Math.round(finalA * 255);
      }
    }
  }
}

await rm(output, { force: true });
await writeFile(output, writePngRgba(CANVAS_SIZE, CANVAS_SIZE, outputData));
console.log('Successfully generated build/icon-macos.png with macOS squircle tile background!');

if (process.platform === 'darwin') {
  const iconsetDir = join(root, 'build', 'icon.iconset');
  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(iconsetDir, { recursive: true });

  const sizes = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ];

  for (const { name, size } of sizes) {
    spawnSync('/usr/bin/sips', ['-z', String(size), String(size), output, '--out', join(iconsetDir, name)]);
  }

  const icnsOutput = join(root, 'build', 'icon.icns');
  await rm(icnsOutput, { force: true });
  spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', icnsOutput]);
  await rm(iconsetDir, { recursive: true, force: true });
  console.log('Successfully generated build/icon.icns with macOS squircle tile background!');
}
