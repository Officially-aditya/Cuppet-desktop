import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';

console.log('Starting terminal cursor smoke');
const timeout = setTimeout(() => { console.error('Terminal cursor smoke timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
const root = process.cwd();
const fixture = await build({
  stdin: { contents: `
    import React from 'react';
    import { ShellPanelControls } from './src/renderer/react/ShellPanelControls.tsx';
    import { createRoot } from 'react-dom/client';
    import { ProjectTerminal } from './src/renderer/react/ProjectTerminal.tsx';
    let onEvent;
    window.cuppet = { native: { platform: 'darwin' }, terminal: {
      start: async () => ({ sessionId: 'cursor-test', projectId: 'default', cwd: '/', shell: '/bin/sh', startedAt: 0 }),
      write: async (_id, input) => { window.terminalInput = input; return { written: true }; },
      resize: async () => ({ resized: true }),
      stop: async () => ({ stopped: true }),
      onEvent: (handler) => { onEvent = handler; return () => {}; },
    } };
    window.output = (data) => onEvent({ sessionId: 'cursor-test', projectId: 'default', type: 'output', data });

    function Fixture() {
      const [open, setOpen] = React.useState(false);
      return <div className="app-shell react-app">
        <aside className="sidebar react-sidebar" style={{ width: 240 }} />
        <main className="main-pane react-main-pane">
          <section className="messages react-messages">Chat</section>
          <footer className="composer-wrap react-composer-wrap" style={{ height: 100 }} />
          <ProjectTerminal project={null} open={open} onOpenChange={setOpen} />
        </main>
        <ShellPanelControls state={{ leftAvailable: true, leftOpen: true, bottomAvailable: true, bottomOpen: open }} onToggleLeft={() => {}} onToggleBottom={() => setOpen(value => !value)} />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);

  `, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, minify: true, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'empty' },
});

const entry = await readFile(resolve(root, 'src/renderer/main.tsx'), 'utf8');
const cssPaths = [...entry.matchAll(/import '([^']+css)'/g)].map(match => 'src/renderer/' + match[1].slice(2));
cssPaths.push('node_modules/@xterm/xterm/css/xterm.css');
const css = (await Promise.all(cssPaths.map(path => readFile(resolve(root, path), 'utf8')))).join('\n');
const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { offscreen: true, backgroundThrottling: false } });
try {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html data-theme="dark"><head><style>' + css + '</style></head><body><div id="root"></div><script>' +
    fixture.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>'
  ));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 50));
    // Offscreen windows cannot receive OS focus; simulate a focused document.
    document.hasFocus = () => true;
    while (!document.querySelector('.shell-panel-controls-right .shell-panel-button')) await wait();
    document.querySelector('.shell-panel-controls-right .shell-panel-button').click();
    while (!window.output || !document.querySelector('.xterm-helper-textarea')) await wait();
    await wait();
    window.output('line\\r\\n'.repeat(100) + 'test $ ');
    await wait();
    const states = [];
    const sample = async (name, data, reduced, expectedStyle = 'bar', expectedBlink = !reduced) => {
      document.body.classList.toggle('reduce-motion', reduced);
      if (data) window.output(data);
      const textarea = document.querySelector('.xterm-helper-textarea');
      textarea.focus();
      textarea.dispatchEvent(new FocusEvent('focus'));
      await wait();
      const cursor = document.querySelector('.xterm-cursor');
      const animations = cursor?.getAnimations() ?? [];
      const blink = animations.find(animation => animation.effect?.target === cursor);
      const values = [];
      if (blink) for (const time of [0, 750]) {
        blink.pause(); blink.currentTime = time;
        const style = getComputedStyle(cursor);
        values.push([style.boxShadow, style.borderBottomStyle, style.backgroundColor, style.color]);
      }
      states.push({ name, expectedStyle, expectedBlink, classes: cursor?.className, animation: cursor ? getComputedStyle(cursor).animationName : null,
        paint: cursor ? { boxShadow: getComputedStyle(cursor).boxShadow, borderBottomStyle: getComputedStyle(cursor).borderBottomStyle, backgroundColor: getComputedStyle(cursor).backgroundColor } : null,
        focused: document.activeElement?.className, rows: document.querySelector('.xterm-rows')?.className, visibility: document.visibilityState, screen: document.querySelector('.xterm-screen')?.getBoundingClientRect().toJSON(), cursorRect: cursor?.getBoundingClientRect().toJSON(), body: document.querySelector('.project-terminal-body')?.getBoundingClientRect().toJSON(), values });
    };
    await sample('normal', '', false);
    await sample('reduced-motion', '', true);
    await sample('shell-hidden', '\\x1b[?25l', false, null, false);
    await sample('shell-shown', '\\x1b[?25h', false);
    await sample('shell-block', '\\x1b[2 q', false, 'block', false);
    await sample('shell-blinking-block', '\\x1b[1 q', false, 'block');
    await sample('shell-underline', '\\x1b[4 q', false, 'underline', false);
    await sample('shell-blinking-underline', '\\x1b[3 q', false, 'underline');
    await sample('shell-steady-bar', '\\x1b[6 q', false, 'bar', false);
    await sample('shell-blinking-bar', '\\x1b[5 q', false);
    await sample('shell-blink-disabled', '\\x1b[0 q\\x1b[?12l', false, 'bar', false);
    await sample('shell-blink-enabled', '\\x1b[?12h', false);
    await sample('fullscreen-hidden', '\\x1b[?1049h\\x1b[2 q\\x1b[?25l', false, null, false);
    await sample('returned-hidden', '\\x1b[?1049l', false, null, false);
    await sample('returned-to-shell', '\\x1b[?25h', false, 'block', false);
    document.documentElement.dataset.theme = 'light';
    window.dispatchEvent(new Event('cuppet:appearance-changed'));
    await sample('light', '\\x1b[0 q', false);
    document.querySelector('.shell-panel-controls-right .shell-panel-button').click();
    await wait();
    document.querySelector('.shell-panel-controls-right .shell-panel-button').click();
    await wait();
    await sample('reopened', '', false);
    return states;
  })()`);

  for (const state of result) {
    if (state.expectedStyle === null) {
      assert.equal(state.classes, undefined, state.name + ': cursor hide control was ignored');
      continue;
    }
    assert.ok(state.cursorRect?.height > 0 && state.cursorRect.bottom <= Math.min(600, state.body.bottom) && state.cursorRect.top >= state.body.top, state.name + ': cursor is clipped');
    assert.match(state.classes, new RegExp('xterm-cursor-' + state.expectedStyle), state.name + ': cursor style control was ignored');
    if (state.expectedBlink) {
      assert.equal(state.values.length, 2, state.name + ': cursor does not blink');
      assert.notDeepEqual(state.values[0], state.values[1], state.name + ': cursor does not blink');
    } else {
      assert.equal(state.animation, 'none', state.name + ': cursor still blinks');
      if (state.expectedStyle === 'bar') assert.notEqual(state.paint.boxShadow, 'none', state.name + ': steady caret is invisible');
      if (state.expectedStyle === 'underline') assert.equal(state.paint.borderBottomStyle, 'solid', state.name + ': steady underline is invisible');
      if (state.expectedStyle === 'block') assert.notEqual(state.paint.backgroundColor, 'rgba(0, 0, 0, 0)', state.name + ': steady block is invisible');
    }
  }
  const rect = result.at(-1).cursorRect;
  const crop = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: 3, height: Math.floor(rect.height) };
  const pixels = [];
  for (const time of [0, 750]) {
    await win.webContents.executeJavaScript(`(async () => {
      const cursor = document.querySelector('.xterm-cursor');
      const blink = cursor.getAnimations().find(animation => animation.effect?.target === cursor);
      blink.pause();
      blink.currentTime = ${time};
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    })()`);
    pixels.push((await win.webContents.capturePage(crop)).toBitmap());
  }
  assert.notDeepEqual(pixels[0], pixels[1], 'Caret has CSS animation but its rendered pixels do not change');
  console.log('Terminal cursor visibility and shell controls passed for: ' + result.map(state => state.name).join(', '));
} finally {
  clearTimeout(timeout);
  win.destroy();
  app.quit();
}
}).catch(error => { console.error(error); app.exit(1); });
