import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = fileURLToPath(new URL('.', import.meta.url));
const bootstrapSource = await readFile(join(here, '..', 'src', 'main', 'bootstrap.mjs'), 'utf8');
const mainSource = await readFile(join(here, '..', 'src', 'main', 'main.mjs'), 'utf8');
const preloadSource = await readFile(join(here, '..', 'src', 'preload', 'preload.cjs'), 'utf8');
const cssSource = await readFile(join(here, '..', 'src', 'renderer', 'shell-panel-controls.css'), 'utf8');
const themeSource = await readFile(join(here, '..', 'src', 'renderer', 'theme.css'), 'utf8');
const shellControlsSource = await readFile(join(here, '..', 'src', 'renderer', 'react', 'ShellPanelControls.tsx'), 'utf8');
const windowControlsSource = await readFile(join(here, '..', 'src', 'renderer', 'react', 'DesktopWindowControls.tsx'), 'utf8');

test('Windows/non-Mac BrowserWindow is frameless to eliminate duplicate native header', () => {
  // Verifies that frame: false is configured for non-macOS (Windows)
  assert.match(mainSource, /frame:\s*false/, 'BrowserWindow must set frame: false on non-Mac to remove native header');
  assert.match(mainSource, /autoHideMenuBar:\s*!isMac/, 'autoHideMenuBar must be enabled on non-Mac');
  assert.match(mainSource, /titleBarStyle:\s*'hiddenInset'/, 'macOS still preserves hiddenInset traffic lights');
});

test('main process provides window lifecycle IPC and maximize event dispatching', () => {
  assert.match(mainSource, /handle\('native\.minimizeWindow'/, 'missing guarded minimize IPC handler');
  assert.match(mainSource, /handle\('native\.toggleMaximizeWindow'/, 'missing guarded maximize IPC handler');
  assert.match(mainSource, /handle\('native\.closeWindow'/, 'missing guarded close IPC handler');
  assert.match(mainSource, /handle\('native\.isWindowMaximized'/, 'missing guarded window status IPC handler');

  assert.match(mainSource, /mainWindow\.on\('maximize'/);
  assert.match(mainSource, /mainWindow\.on\('unmaximize'/);
  assert.match(mainSource, /cuppet:window:maximize-change/);
});

test('preload bridges window controls to renderer via cuppet.native', () => {
  for (const name of ['minimizeWindow', 'toggleMaximizeWindow', 'closeWindow', 'isWindowMaximized', 'onWindowMaximizeChange']) {
    assert.ok(preloadSource.includes('native.' + name));
  }
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
  assert.match(cssSource, /\.shell-panel-header\.is-non-mac\s+\.shell-panel-header-workspace\s*\{\s*padding-right:\s*0\s*;?\s*\}/);
  assert.match(cssSource, /\.desktop-window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(cssSource, /\.window-control-btn\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(cssSource, /\.window-control-btn\.window-control-close:hover\s*\{[^}]*background:\s*var\(--danger\)/);
  assert.match(cssSource, /\.window-control-btn\.window-control-close:hover\s*\{[^}]*color:\s*#ffffff/);
  assert.match(cssSource, /\.window-control-btn\.window-control-close:active\s*\{[^}]*background:\s*var\(--danger-solid\)/);
  assert.match(cssSource, /\.window-control-btn\.window-control-close:active\s*\{[^}]*color:\s*#ffffff/);
});

test('desktop theme defines genuine red tokens for danger and controls', () => {
  assert.match(themeSource, /--danger:\s*#e81123;/, 'dark theme --danger must be vibrant red #e81123, not pale pastel peach');
  assert.match(themeSource, /--danger-solid:\s*#c42b1c;/, 'dark theme --danger-solid must be Windows fluent red #c42b1c');
  assert.doesNotMatch(themeSource, /--danger:\s*#ffb4ab;/, 'pale peach #ffb4ab must not be used for danger');
});

test('desktop bootstrap forces sRGB color profile on Windows to prevent color distortion', () => {
  assert.match(bootstrapSource, /process\.platform\s*===\s*'win32'/);
  assert.match(bootstrapSource, /force-color-profile/);
  assert.match(bootstrapSource, /'srgb'/);
});
