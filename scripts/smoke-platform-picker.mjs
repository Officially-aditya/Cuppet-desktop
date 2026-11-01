import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_PRESETS } from '../src/main/provider-presets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
const work = await mkdtemp(join(root, 'dist/platform-logo-smoke-'));
app.setPath('userData', join(work, 'profile'));
app.on('window-all-closed', () => {});
let stage = 'Electron startup';
const timer = setTimeout(() => { console.error('Platform picker smoke timed out during ' + stage); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
let window;
let failed = false;
try {
  stage = 'fixture build';
  const presets = Object.values(PROVIDER_PRESETS);
  await writeFile(join(work, 'index.html'), '<div id="root"></div><script type="module" src="./entry.tsx"></script>');
  await writeFile(join(work, 'entry.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PlatformPicker } from '../../src/renderer/react/PlatformPicker';
    import { hydrateClientProviderSettings } from '../../src/renderer/react/client-provider-state';
    import '../../src/renderer/index.css';
    const presets = ${JSON.stringify(presets)};
    let current = { providerID: 'codex', primary: { providerID: 'codex' }, savedProviderIDs: [...presets.map(p => p.id), 'custom-platform'], presets };
    const calls = [];
    let fail = false;
    window.cuppet = { settings: {
      get: async () => current,
      save: async ({ providerID }) => {
        calls.push(providerID);
        if (fail) { fail = false; throw new Error('Switch failed'); }
        current = { ...current, providerID, primary: { providerID } };
        return current;
      },
    } };
    hydrateClientProviderSettings(current);
    window.logoSmoke = {
      calls,
      select(providerID) { current = { ...current, providerID, primary: { providerID } }; hydrateClientProviderSettings(current); },
      empty() { current = { ...current, savedProviderIDs: [] }; hydrateClientProviderSettings(current); },
      fail() { fail = true; },
    };
    createRoot(document.getElementById('root')).render(<div style={{ position: 'fixed', bottom: 24, right: 24 }}><PlatformPicker /></div>);
  `);
  await build({ configFile: false, root: work, base: './', plugins: [react()],
    build: { outDir: join(work, 'built'), emptyOutDir: true, target: 'es2022' }, logLevel: 'error' });
  stage = 'page load';
  window = new BrowserWindow({ width: 900, height: 600, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await window.loadFile(join(work, 'built/index.html'));
  window.showInactive();
  const run = (source) => window.webContents.executeJavaScript(source);
  const settle = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await settle();
  assert.equal(await run('document.querySelector(".cuppet-select-trigger").innerText.trim()'), '');
  let rendered = 0;
  for (const [background, foreground] of [['#111111', '#eeeeee'], ['#ffffff', '#111111']]) {
    await run(`document.body.style.background = ${JSON.stringify(background)}; document.documentElement.style.setProperty('--text', ${JSON.stringify(foreground)});`);
    for (const id of [...presets.map(p => p.id), 'custom-platform']) {
      stage = 'painting ' + id + ' on ' + background;
      await run(`window.logoSmoke.select(${JSON.stringify(id)})`);
      await settle();
      const report = await run(`(() => {
        const logo = document.querySelector('.platform-logo'), rect = logo.getBoundingClientRect();
        return { id: logo.dataset.platformLogo, x: Math.round(rect.x), y: Math.round(rect.y), width: rect.width, height: rect.height,
          mask: getComputedStyle(logo).maskImage, text: document.querySelector('.cuppet-select-trigger').innerText.trim() };
      })()`);
      assert.equal(report.id, id === 'custom-platform' ? 'generic' : id);
      assert.equal(report.text, '');
      assert.equal(report.width, 18);
      assert.equal(report.height, 18);
      assert.match(report.mask, /data:image\/svg\+xml/);
      const bitmap = (await window.webContents.capturePage({ x: report.x, y: report.y, width: 18, height: 18 })).toBitmap();
      const shades = [];
      for (let i = 0; i < bitmap.length; i += 4) shades.push(bitmap[i] + bitmap[i + 1] + bitmap[i + 2]);
      assert.ok(Math.max(...shades) - Math.min(...shades) > 60, id + ' logo must paint pixels in ' + background);
      rendered++;
    }
  }
  stage = 'menu interactions';
  await run("window.logoSmoke.select('codex')");
  await settle();
  await run("document.querySelector('.cuppet-select-trigger').click()");
  await settle();
  const menu = await run(`[...document.querySelectorAll('[role="option"]')].map(option => ({
    name: option.getAttribute('aria-label'), title: option.title, text: option.innerText.replace('✓', '').trim(), logo: !!option.querySelector('.platform-logo')
  }))`);
  assert.equal(menu.length, presets.length + 1);
  assert.ok(menu.every(option => option.name && option.name === option.title && option.logo && !option.text));
  await run('document.querySelector(\'[role="option"][aria-label="Claude Code"]\').click()');
  await settle();
  assert.equal(await run("document.querySelector('.platform-logo').dataset.platformLogo"), 'claude-code');
  await run("window.logoSmoke.fail(); document.querySelector('.cuppet-select-trigger').click()");
  await settle();
  await run('document.querySelector(\'[role="option"][aria-label="Codex"]\').click()');
  await settle();
  assert.equal(await run("document.querySelector('.platform-logo').dataset.platformLogo"), 'claude-code');
  assert.equal(await run("document.querySelector('[role=alert]').textContent"), 'Switch failed');
  await run('window.logoSmoke.empty()');
  await settle();
  assert.equal(await run("document.querySelector('.cuppet-select-trigger').disabled"), true);
  assert.equal(await run("document.querySelector('.platform-logo').dataset.platformLogo"), 'generic');
  assert.deepEqual(errors, []);
  console.log('Platform picker smoke passed: ' + rendered + ' logos painted across dark/light themes; logo-only accessible menu, switching, failure, and empty state verified.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  window?.destroy();
  clearTimeout(timer);
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(failed ? 1 : 0);
}
});
