// Run with Electron: npm run renderer:reasoning-smoke. Uses the production renderer and worker under the app CSP.
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createPackage } from '@electron/asar';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), 'cuppet-reasoning-smoke-'));
await mkdir(join(workspace, 'profile'));
app.setPath('userData', join(workspace, 'profile'));
const timeout = setTimeout(() => { console.error('Reasoning renderer smoke timed out'); app.exit(1); }, 90_000);

app.whenReady().then(async () => {
  let window;
  try {
    await build({ configFile: false, root: resolve(root, 'test/fixtures/reasoning-renderer'), base: './', plugins: [react()],
      build: { outDir: join(workspace, 'renderer'), emptyOutDir: true, target: 'es2022' }, logLevel: 'error' });
    await createPackage(join(workspace, 'renderer'), join(workspace, 'app.asar'));
    window = new BrowserWindow({ show: false, width: 1180, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    await window.loadFile(join(workspace, 'app.asar/index.html'));
    window.webContents.setBackgroundThrottling(false);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 4 });
    await window.webContents.executeJavaScript('window.setThought(800)');
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    const first = await window.webContents.executeJavaScript('window.runToggle()');
    const reopen = await window.webContents.executeJavaScript('window.runToggle()');
    // Leave headroom for shared CI hosts while catching the reproduced hundreds-of-ms renderer freeze.
    assert.ok(first.maxGap < 200, `First open stalled the renderer for ${first.maxGap.toFixed(0)}ms`);
    assert.ok(reopen.maxGap < 200, `Reopen stalled the renderer for ${reopen.maxGap.toFixed(0)}ms`);
    const streamed = await window.webContents.executeJavaScript('window.exerciseStreaming()');
    assert.deepEqual(errors, [], 'Renderer or worker reported an error');
    console.log(`Reasoning renderer smoke passed on ${process.platform}: ${JSON.stringify({ cpuThrottle: 4, first, reopen, ...streamed })}`);
    clearTimeout(timeout);
    window.destroy();
    await rm(workspace, { recursive: true, force: true });
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    window?.destroy();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    app.exit(1);
  }
});
