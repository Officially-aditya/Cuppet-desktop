import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'cuppet-auth-renderer-'));
await mkdir(join(workspace, 'profile'));
app.setPath('userData', join(workspace, 'profile'));
app.on('window-all-closed', () => {});
let stage = 'Electron startup';
const timer = setTimeout(() => { console.error(`Provider authentication smoke timed out during ${stage}`); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
let window;
try {
  stage = 'renderer build';
  await build({ configFile: false, root: resolve(root, 'test/fixtures/provider-auth-renderer'), base: './', plugins: [react()],
    build: { outDir: join(workspace, 'renderer'), emptyOutDir: true, target: 'es2022' }, logLevel: 'error' });
  window = new BrowserWindow({ width: 900, height: 600, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  stage = 'page load';
  await window.loadFile(join(workspace, 'renderer', 'index.html'));
  window.show(); window.focus();
  stage = 'terminal startup';
  assert.equal(await window.webContents.executeJavaScript('window.authSmoke.start()'), true);
  await window.webContents.executeJavaScript('document.querySelector(".xterm-helper-textarea").focus()');
  for (const keyCode of '123456') window.webContents.sendInputEvent({ type: 'char', keyCode });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  stage = 'browser interaction';
  await window.webContents.executeJavaScript('window.authSmoke.browser()');
  let calls = await window.webContents.executeJavaScript('window.authSmoke.calls');
  assert.equal(calls.filter((call) => call.kind === 'respond' && call.response.data).map((call) => call.response.data).join(''), '123456\r');
  assert.ok(calls.some((call) => call.kind === 'open' && call.url === 'https://example.com/login'));
  assert.ok(calls.some((call) => call.response?.requestId === 'browser-1' && call.response.action === 'accept'));
  stage = 'cancellation';
  assert.match(await window.webContents.executeJavaScript('window.authSmoke.cancel()'), /cancelled/);
  await window.webContents.executeJavaScript('window.authSmoke.unmount()');
  calls = await window.webContents.executeJavaScript('window.authSmoke.calls');
  assert.ok(calls.some((call) => call.kind === 'cancel' && call.id === 'setup-1'));
  assert.ok(calls.some((call) => call.kind === 'cancel' && call.id === 'setup-2'));
  assert.deepEqual(errors, []);
  window.destroy();
  clearTimeout(timer);
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('Provider auth renderer smoke passed: typed code, browser consent, cancel, and unmount cleanup.');
  app.quit();
} catch (error) {
  console.error(error);
  window?.destroy(); clearTimeout(timer);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  app.exit(1);
}
});
