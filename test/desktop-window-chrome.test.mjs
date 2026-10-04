import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = fileURLToPath(new URL('.', import.meta.url));
const mainSource = await readFile(join(here, '..', 'src', 'main', 'main.mjs'), 'utf8');
const preloadSource = await readFile(join(here, '..', 'src', 'preload', 'preload.cjs'), 'utf8');
const cssSource = await readFile(join(here, '..', 'src', 'renderer', 'shell-panel-controls.css'), 'utf8');
const shellControlsSource = await readFile(join(here, '..', 'src', 'renderer', 'react', 'ShellPanelControls.tsx'), 'utf8');
const windowControlsSource = await readFile(join(here, '..', 'src', 'renderer', 'react', 'DesktopWindowControls.tsx'), 'utf8');

test('Windows/non-Mac BrowserWindow is frameless to eliminate duplicate native header', () => {
  // Verifies that frame: false is configured for non-macOS (Windows)
  assert.match(mainSource, /frame:\s*false/, 'BrowserWindow must set frame: false on non-Mac to remove native header');
  assert.match(mainSource, /autoHideMenuBar:\s*!isMac/, 'autoHideMenuBar must be enabled on non-Mac');
  assert.match(mainSource, /titleBarStyle:\s*'hiddenInset'/, 'macOS still preserves hiddenInset traffic lights');
});

test('main process provides window lifecycle IPC and maximize event dispatching', () => {
  assert.match(mainSource, /ipcMain\.handle\('cuppet:native:minimize'/, 'missing cuppet:native:minimize IPC handler');
  assert.match(mainSource, /ipcMain\.handle\('cuppet:native:toggle-maximize'/, 'missing cuppet:native:toggle-maximize IPC handler');
  assert.match(mainSource, /ipcMain\.handle\('cuppet:native:close'/, 'missing cuppet:native:close IPC handler');
  assert.match(mainSource, /ipcMain\.handle\('cuppet:native:is-maximized'/, 'missing cuppet:native:is-maximized IPC handler');

  assert.match(mainSource, /mainWindow\.on\('maximize'/);
  assert.match(mainSource, /mainWindow\.on\('unmaximize'/);
  assert.match(mainSource, /cuppet:window:maximize-change/);
});

test('preload bridges window controls to renderer via cuppet.native', () => {
  assert.match(preloadSource, /minimizeWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('cuppet:native:minimize'\)/);
  assert.match(preloadSource, /toggleMaximizeWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('cuppet:native:toggle-maximize'\)/);
  assert.match(preloadSource, /closeWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('cuppet:native:close'\)/);
  assert.match(preloadSource, /isWindowMaximized:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('cuppet:native:is-maximized'\)/);
  assert.match(preloadSource, /onWindowMaximizeChange:\s*\(callback\)/);
});

test('ShellPanelControls embeds DesktopWindowControls on non-Mac and supports double-click maximize', () => {
  assert.match(shellControlsSource, /import\s+\{\s*DesktopWindowControls\s*\}\s+from\s+'\.\/DesktopWindowControls'/);
  assert.match(shellControlsSource, /\{!isMac\s*&&\s*<DesktopWindowControls\s*\/>\}/);
  assert.match(shellControlsSource, /onDoubleClick=.*toggleMaximizeWindow/s);
});

test('DesktopWindowControls implements minimize, maximize/restore toggle, and close', () => {
  assert.match(windowControlsSource, /window-control-minimize/);
  assert.match(windowControlsSource, /window-control-maximize/);
  assert.match(windowControlsSource, /window-control-close/);
  assert.match(windowControlsSource, /onWindowMaximizeChange/);
  assert.match(windowControlsSource, /isWindowMaximized/);
});

test('shell header CSS has non-mac layout rules and window control styling', () => {
  assert.match(cssSource, /\.shell-panel-header\.is-non-mac\s+\.shell-panel-header-workspace\s*\{\s*padding-right:\s*0\s*\}/);
  assert.match(cssSource, /\.desktop-window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(cssSource, /\.window-control-btn\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(cssSource, /\.window-control-btn\.window-control-close:hover\s*\{[^}]*background:\s*#e81123/);
});
