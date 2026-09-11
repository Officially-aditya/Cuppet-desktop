import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserControlManager } from '../src/runtime/browser-control-manager.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] || defaultExecutable(root));
const resources = resourcesDirectory(executable);
const runtime = join(resources, 'browsercontrol', 'dist', 'local', 'runtime.js');
const manifestPath = join(resources, 'browsercontrol', 'browsercontrol-package.json');

await access(executable);
await access(runtime);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.vendor, 'Officially-aditya');
assert.equal(manifest.product, 'browserControl');
assert.equal(manifest.entry, 'dist/local/runtime.js');
assert.equal(manifest.localPort, 8765);

const priorResources = process.env.CUPPET_RESOURCES_PATH;
process.env.CUPPET_RESOURCES_PATH = resources;
const manager = new BrowserControlManager();
try {
  const before = await manager.status();
  assert.equal(before.available, true, 'packaged browserControl runtime was not discovered');
  const running = await manager.connect();
  assert.equal(running.available, true);
  assert.equal(running.running, true, running.message || 'browserControl did not start');
  assert.ok(running.toolCount > 0, 'browserControl MCP tool list is empty');
  const health = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(2_000) }).then((response) => response.json());
  assert.equal(health.service, 'browsercontrol-local');
  console.log(`Packaged browserControl smoke passed with ${running.toolCount} MCP tools: ${runtime}`);
} finally {
  await manager.close().catch(() => undefined);
  if (priorResources === undefined) delete process.env.CUPPET_RESOURCES_PATH;
  else process.env.CUPPET_RESOURCES_PATH = priorResources;
}

function defaultExecutable(projectRoot) {
  if (process.platform === 'win32') return join(projectRoot, 'dist', 'win-unpacked', 'cuppet.exe');
  if (process.platform === 'darwin') return join(projectRoot, 'dist', 'mac', 'Cuppet.app', 'Contents', 'MacOS', 'cuppet');
  return join(projectRoot, 'dist', 'linux-unpacked', 'cuppet');
}
function resourcesDirectory(executablePath) { return process.platform === 'darwin' ? resolve(dirname(executablePath), '..', 'Resources') : join(dirname(executablePath), 'resources'); }
