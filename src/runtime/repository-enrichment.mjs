import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { redactCredentials } from './credential-sanitization.mjs';

const SKIP = new Set(['node_modules', 'vendor', 'build', 'dist', 'target', '__pycache__']);
const MAX_BYTES = 96 * 1024;
const SIGNAL_CHARS = 16_000;

export async function repositoryEnrichmentSnapshot(projectRoot, prompt) {
  const files = [];
  const omitted = [];
  let text = '';
  async function visit(relative = '') {
    const entries = await readdir(join(projectRoot, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || /(?:auth\.json|\.pem|\.key)$/i.test(entry.name)) continue;
      if (files.length >= 64 || Buffer.byteLength(text) >= MAX_BYTES) { omitted.push(path); continue; }
      const buffer = await readFile(join(projectRoot, path));
      if (buffer.length > 64 * 1024 || buffer.includes(0)) { omitted.push(path); continue; }
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { omitted.push(path); continue; }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const block = `\nFILE ${path} (sha256 ${sha256})\n${content}\nEND FILE ${path}\n`;
      if (Buffer.byteLength(text + block) > MAX_BYTES) { omitted.push(path); continue; }
      text += block;
      files.push({ path, bytes: buffer.length, sha256 });
    }
  }
  await visit();
  text = redactCredentials(text);
  const signals = [`ORIGINAL TASK REQUEST:\n${String(prompt).slice(0, SIGNAL_CHARS)}`];
  for (let offset = 0; offset < text.length; offset += SIGNAL_CHARS) {
    signals.push(text.slice(offset, offset + SIGNAL_CHARS));
  }
  return { signals, files, omitted, snapshotBytes: Buffer.byteLength(text) };
}
