import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Electron does not implement window.prompt(), and confirm()/alert() freeze the whole renderer. Anything that needs
// input or consent goes through the dialog queue (dialog-store.ts) instead (UI-09).
const root = fileURLToPath(new URL('../src/renderer/', import.meta.url));

async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) yield* sources(`${path}/`);
    else if (/\.(?:tsx?|mjs|js)$/.test(entry.name)) yield path;
  }
}

test('no renderer source calls window.prompt, window.confirm or window.alert', async () => {
  const offenders = [];
  for await (const file of sources(root)) {
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of text.matchAll(/(?<![\w.$])(?:window\.)?(prompt|confirm|alert)\s*\(/g)) offenders.push(`${file.slice(root.length)}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test('the dialog host is mounted once at the root, so awaited dialogs can be shown', async () => {
  const entry = await readFile(`${root}main.tsx`, 'utf8');
  assert.equal((entry.match(/<DialogHost \/>/g) || []).length, 1);
});
