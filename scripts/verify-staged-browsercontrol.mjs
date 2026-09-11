import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staged = join(root, 'vendor', 'browsercontrol');
const runtime = join(staged, 'dist', 'local', 'runtime.js');

await access(runtime);
const runtimeSource = await readFile(runtime, 'utf8');
const pkg = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(staged, 'browsercontrol-package.json'), 'utf8'));
assert.equal(pkg.name, 'chrome-computer-use');
assert.equal(manifest.vendor, 'Officially-aditya');
assert.equal(manifest.product, 'browserControl');
assert.equal(manifest.package, 'chrome-computer-use');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.entry, 'dist/local/runtime.js');
assert.equal(manifest.bundled, true);
assert.equal(manifest.localPort, 8765);
assert.doesNotMatch(runtimeSource, /^\s*import\s+.*?from\s+["']@modelcontextprotocol\//m, 'bundled browserControl still imports MCP packages externally');
assert.doesNotMatch(runtimeSource, /^\s*import\s+.*?from\s+["']ws["']/m, 'bundled browserControl still imports ws externally');

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ['--check', runtime], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`browserControl runtime syntax check failed: ${stderr.trim()}`)));
});
console.log(`browserControl bundled runtime verified: ${runtime}`);
