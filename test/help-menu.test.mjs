import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HELP_TOPICS, buildMenuTemplate, installApplicationMenu } from '../src/main/app-menu.mjs';
import { IPC_EVENTS, IPC_METHODS } from '../src/shared/ipc-contract.mjs';
import { loadModule } from './helpers/load-tsx.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative) => readFile(path(`../${relative}`), 'utf8');

const helpMenu = (template) => template.find((menu) => menu.role === 'help');
const labels = (menu) => menu.submenu.filter((item) => item.type !== 'separator').map((item) => item.label);

test('the Help menu lists the three help pages, and each entry opens its own topic', () => {
  for (const isMac of [true, false]) {
    const opened = [];
    const template = buildMenuTemplate({ isMac, appName: 'Cuppet', openHelp: (topic) => opened.push(topic) });
    const menu = helpMenu(template);
    assert.equal(menu.label, 'Help');
    assert.deepEqual(labels(menu), ['Security & Sandbox', 'Data & Privacy', 'About Cuppet']);
    for (const item of menu.submenu.filter((entry) => entry.click)) item.click();
    assert.deepEqual(opened, ['security', 'privacy', 'about']);
    assert.deepEqual(opened, [...HELP_TOPICS], 'every help topic is reachable from the menu');
  }
});

test('Help entries are disabled while there is no window to show them in', () => {
  const template = buildMenuTemplate({ isMac: true, openHelp() {}, canOpenHelp: false });
  const entries = helpMenu(template).submenu.filter((item) => item.click);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((item) => item.enabled === false));
  const enabled = buildMenuTemplate({ isMac: true, openHelp() {} });
  assert.ok(helpMenu(enabled).submenu.filter((item) => item.click).every((item) => item.enabled === true));
});

test('macOS gets an app menu with About; other platforms get a File menu; both keep Edit, View and Window', () => {
  const mac = buildMenuTemplate({ isMac: true, appName: 'Cuppet', openHelp() {} });
  assert.equal(mac[0].label, 'Cuppet');
  assert.ok(mac[0].submenu.some((item) => item.label === 'About Cuppet'));
  assert.ok(mac[0].submenu.some((item) => item.role === 'quit'));
  const other = buildMenuTemplate({ isMac: false, appName: 'Cuppet', openHelp() {} });
  assert.deepEqual(other[0], { role: 'fileMenu' });
  for (const template of [mac, other]) {
    // Without the Edit menu, copy and paste shortcuts stop working on macOS.
    for (const role of ['editMenu', 'viewMenu', 'windowMenu']) assert.ok(template.some((menu) => menu.role === role), role);
  }
});

test('installApplicationMenu builds the template and makes it the application menu', () => {
  const calls = [];
  const built = { built: true };
  const Menu = {
    buildFromTemplate: (template) => { calls.push(['build', template.length]); return built; },
    setApplicationMenu: (menu) => calls.push(['set', menu]),
  };
  assert.equal(installApplicationMenu({ Menu, isMac: false, appName: 'Cuppet', openHelp() {} }), built);
  assert.deepEqual(calls, [['build', 5], ['set', built]]);
});

test('main and renderer agree on the help channel, and the main process only sends known topics', async () => {
  const [main, app] = await Promise.all([read('src/main/main.mjs'), read('src/renderer/react/App.tsx')]);
  const event = IPC_EVENTS['native.onHelpRequested'];
  assert.equal(event.channel, 'cuppet:menu:open-help');
  assert.ok(main.includes(`webContents.send('${event.channel}', topic)`), 'main sends on the contract channel');
  assert.match(main, /if \(!HELP_TOPICS\.includes\(topic\) \|\| !mainWindow\) return;/);
  assert.match(main, /installApplicationMenu\(\{ Menu,/);
  assert.match(main, /handle\('native\.appVersion', \(\) => app\.getVersion\(\)\)/);
  assert.equal(IPC_METHODS['native.appVersion'].channel, 'cuppet:native:app-version');
  assert.match(app, /window\.cuppet\.native\.onHelpRequested\?\.\(\(topic\) => \{\s+setHelpTopic\(topic\);\s+setModal\('help'\);/);
  assert.match(app, /modal === 'help' && <HelpModal topic=\{helpTopic\} onTopic=\{setHelpTopic\}/);
});

test('Settings no longer lists security, data & privacy or about, and keeps its real sections', async () => {
  const settings = await read('src/renderer/react/SettingsModal.tsx');
  const meta = settings.slice(settings.indexOf('const SECTION_META'), settings.indexOf('};', settings.indexOf('const SECTION_META')));
  for (const id of ['general', 'account', 'platform', 'personalisation', 'usage', 'devices']) assert.match(meta, new RegExp(`\\b${id}:`), id);
  for (const id of ['security', 'privacy', 'about']) assert.doesNotMatch(meta, new RegExp(`\\b${id}:`), id);
  assert.doesNotMatch(settings, /SecurityPanel|PrivacyPanel|AboutPanel|sandboxStatus|refreshSandbox|isUnsandboxed/);
  // Account still owns deleted-chat recovery until it gets a better home.
  assert.match(settings, /<strong>Deleted chats<\/strong>/);
});

function renderHelp(topic, { status = null, platform = 'win32' } = {}) {
  const real = loadModule(path('../src/renderer/react/sandbox-status.ts'));
  const { HelpModal } = loadModule(path('../src/renderer/react/HelpModal.tsx'), {
    './sandbox-status': { isUnsandboxed: real.isUnsandboxed, useSandboxStatus: () => status },
    // brand.ts builds the logo URL from import.meta, which the CommonJS test loader cannot evaluate.
    './brand': { CUPPET_LOGO_URL: 'cuppet.png' },
  });
  const previous = globalThis.window;
  globalThis.window = { cuppet: { native: { platform } } };
  try {
    return renderToStaticMarkup(React.createElement(HelpModal, { topic, onTopic() {}, onClose() {} }));
  } finally {
    globalThis.window = previous;
  }
}

test('the Help modal shows a nav with all three topics and marks the open one', () => {
  const html = renderHelp('privacy');
  for (const label of ['Security &amp; Sandbox', 'Data &amp; privacy', 'About']) assert.match(html, new RegExp(`>${label}</button>`), label);
  assert.match(html, /<button type="button" class="active">Data &amp; privacy<\/button>/);
  assert.match(html, /Desktop conversations and project state are stored locally\./);
  assert.doesNotMatch(html, /Kernel Sandbox Containment/);
});

test('the Security page reports the live sandbox state and warns when there is no OS sandbox', () => {
  const enforced = renderHelp('security', { status: { available: true, driverName: 'linux-bwrap', platform: 'linux', credentialProtection: true } });
  assert.match(enforced, /Enforced/);
  assert.match(enforced, /Linux Bubblewrap \(bwrap\)/);
  assert.match(enforced, /Protected/);
  assert.doesNotMatch(enforced, /No OS sandbox on this system/);

  const none = renderHelp('security', { status: { available: false, driverName: 'none', platform: 'win32', credentialProtection: false } });
  assert.match(none, /No OS sandbox on this system/);
  assert.match(none, /None \(Unsandboxed\)/);

  const loading = renderHelp('security', { status: null });
  assert.match(loading, /Checking…/);
  assert.doesNotMatch(loading, /No OS sandbox on this system/);
});

test('the About page shows the app version and platform, not filler rows', () => {
  const html = renderHelp('about', { platform: 'darwin' });
  assert.match(html, /<strong>Version<\/strong>/);
  assert.match(html, /<strong>Platform<\/strong>/);
  assert.match(html, />macOS</);
  assert.doesNotMatch(html, /React \+ TypeScript/);
});
