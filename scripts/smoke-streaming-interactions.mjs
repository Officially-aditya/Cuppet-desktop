// Runs the complete app with real event stores and input handling; no provider requests are sent.
import assert from 'node:assert/strict';
import { app } from 'electron';
import { build } from 'vite';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/runtime/database.mjs';

await mkdir(resolve('.release/streaming-smoke'), { recursive: true });
const profile = await mkdtemp(resolve('.release/streaming-smoke/profile-'));
app.setPath('userData', profile);
const db = new ConversationDatabase(join(profile, 'runtime', 'conversations.sqlite3'));
db.transaction(() => {
for (const [id, turns] of [['short-chat', 1], ['long-chat', 50]]) {
  db.createSession({ id, title: id });
  for (let n = 0; n < turns; n++) {
    db.appendMessage({ id: `${id}-u${n}`, sessionId: id, role: 'user', content: `Question ${n}` });
    const assistant = `${id}-a${n}`;
    db.appendMessage({ id: assistant, sessionId: id, role: 'assistant', content: `## Answer ${n}\n\n${'History with **details** and `src/app.ts`.\n\n'.repeat(12)}` });
    for (let t = 0; t < 80; t++) {
      db.appendMessageActivity({ sessionId: id, messageId: assistant, source: 'provider', activity: t % 4 === 0
        ? { type: 'activity.reasoning.delta', text: 'Considering the next step. '.repeat(80) }
        : { type: 'activity.tool.closed', callId: `tool-${n}-${t}`, tool: 'read_file', argumentsJson: JSON.stringify({ path: `src/file-${t}.ts` }), details: 'Read result '.repeat(100), status: 'success' } });
    }
  }
}
});
db.close();
await build({ logLevel: 'error' });
const timeout = setTimeout(() => { console.error('Streaming interaction profile timed out'); app.exit(1); }, 90_000);
let started = false;
app.on('browser-window-created', (_event, window) => {
  if (started) return;
  started = true;
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', async () => {
    const errors = [];
    window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
    try {
      await evaluate(async () => {
        for (let i = 0; i < 500; i++) {
          if (document.querySelector('textarea') && !document.querySelector('.loading-state')) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('App did not load');
      });
      window.show();
      window.focus();
      assert.equal(await evaluate(() => document.visibilityState), 'visible', 'the interaction test requires a foreground window');
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 4 });
      await window.webContents.debugger.sendCommand('Performance.enable');
      for (const [id, mode] of [['short-chat', 'answer'], ['short-chat', 'reasoning'], ['long-chat', 'answer'], ['long-chat', 'reasoning']]) {
        await evaluate(async (id) => {
          const button = [...document.querySelectorAll('.session-item')].find(node => node.textContent.includes(id));
          if (!button) throw new Error('Missing fixture chat '+id);
          button.click();
          for (let i = 0; i < 500; i++) {
            if (document.querySelector(`article[data-message-id="${id}-u0"]`) && !document.querySelector('article[aria-busy="true"]')) return;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          throw new Error('History did not load');
        }, id);
        const assistantId = id + '-' + mode + '-live';
        const initial = '## Current answer\n\n' + 'Streaming **implementation details** with `src/app.ts` and [a reference](https://example.com). '.repeat(800);
        let content = mode === 'answer' ? initial : '';
        const sequence = mode === 'answer' ? 999 : 1000;
        window.webContents.send('cuppet:event', { type: 'message.created', message: { id: assistantId, sessionId: id, role: 'assistant', content, status: 'streaming', sequence, createdAt: Date.now() } });
        window.webContents.send('cuppet:event', { type: 'run.started', sessionId: id, messageId: assistantId });
        if (mode === 'reasoning') window.webContents.send('cuppet:event', { type: 'runtime.activity', sessionId: id, messageId: assistantId, source: 'provider', sequence: 0, activity: { type: 'activity.reasoning.delta', text: initial } });
        await evaluate(async ({ mode, assistantId }) => {
          while (!document.querySelector('.message-preview') || (mode === 'answer' && document.querySelector('.message-preview .message-content')?.getAttribute('aria-busy') !== 'false')) await new Promise(resolve => setTimeout(resolve, 10));
          // Exclude the initial fixture insertion and first window paint from live-update timing.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const metrics = { gaps: [], frameGaps: [], tasks: [], inputs: 0, updates: 0, lastToken: -1, maxEventLag: 0 };
          const unsubscribe = window.cuppet.onEvent(event => {
            if (event.messageId !== assistantId) return;
            if (event.diagnosticSentAt) metrics.maxEventLag = Math.max(metrics.maxEventLag, Date.now() - event.diagnosticSentAt);
            if (mode === 'reasoning') {
              const token = String(event.activity?.text ?? '').match(/live-(\d+)/);
              if (token) metrics.lastToken = Number(token[1]);
            }
          });
          window.currentStreamToken = () => metrics.lastToken;
          const code = document.querySelector('.message-preview .message-content code');
          let lastFrame = performance.now();
          let frame;
          const onFrame = (now) => { metrics.frameGaps.push(now - lastFrame); lastFrame = now; frame = requestAnimationFrame(onFrame); };
          frame = requestAnimationFrame(onFrame);
          let last = performance.now();
          const timer = setInterval(() => { const now = performance.now(); metrics.gaps.push(now - last); last = now; }, 10);
          const tasks = new PerformanceObserver(list => metrics.tasks.push(...list.getEntries().map(entry => entry.duration)));
          tasks.observe({ type: 'longtask' });
          document.querySelector('textarea').focus();
          const input = () => metrics.inputs++;
          document.querySelector('textarea').addEventListener('input', input);
          const dom = new MutationObserver(() => {
            metrics.updates++;
            const text = document.querySelector('.message-preview .message-content')?.textContent ?? '';
            const values = [...text.matchAll(/live-(\d+)/g)];
            if (values.length) metrics.lastToken = Number(values.at(-1)[1]);
          });
          dom.observe(document.querySelector('.message-preview'), { childList: true, subtree: true, characterData: true });
          window.endProfile = () => {
            clearInterval(timer); cancelAnimationFrame(frame); tasks.disconnect(); dom.disconnect(); unsubscribe();
            document.querySelector('textarea').removeEventListener('input', input);
            return { maxEventLag: metrics.maxEventLag, maxGap: Math.max(...metrics.gaps), maxFrameGap: Math.max(...metrics.frameGaps), frames: metrics.frameGaps.length, retainedCode: code === document.querySelector('.message-preview .message-content code'), longTasks: metrics.tasks, inputs: metrics.inputs, updates: metrics.updates, lastToken: metrics.lastToken };
          };
        }, { mode, assistantId });
        let token = 0;
        const produce = setInterval(() => {
          const delta = [`live-${token} **up`, `date** and \`src/live`, `.ts\` `][token++ % 3];
          if (mode === 'answer') {
            content += delta;
            window.webContents.send('cuppet:event', { type: 'message.delta', sessionId: id, messageId: assistantId, delta, seq: content.length, diagnosticSentAt: Date.now() });
          } else {
            window.webContents.send('cuppet:event', { type: 'runtime.activity', sessionId: id, messageId: assistantId, source: 'provider', sequence: token, activity: { type: 'activity.reasoning.delta', text: delta }, diagnosticSentAt: Date.now() });
          }

        }, 50);
        let typingEnabled = true, keys = 0;
        const keyRequests = [];
        const typing = setInterval(() => {
          if (typingEnabled) {
            keys++;
            keyRequests.push(window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'x' }));
          }
        }, 100);
        const before = await window.webContents.debugger.sendCommand('Performance.getMetrics');
        await new Promise(resolve => setTimeout(resolve, 1000));
        typingEnabled = false;
        const settings = await evaluate(async () => {
          const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Settings' || node.getAttribute('aria-label') === 'Settings');
          const start = performance.now();
          button.click();
          while (!document.querySelector('.settings-hub-dialog')) await new Promise(resolve => setTimeout(resolve, 10));
          return { openedMs: performance.now() - start, firstToken: window.currentStreamToken() };
        });
        await new Promise(resolve => setTimeout(resolve, 700));
        await evaluate(async (settings) => {
          const current = window.currentStreamToken();
          if (current === settings.firstToken) throw new Error('Output stopped updating while Settings was open');
          document.querySelector('.settings-close-button').click();
          while (document.querySelector('.settings-hub-dialog')) await new Promise(resolve => setTimeout(resolve, 10));
          document.querySelector('textarea').focus();
          const messages = document.querySelector('.messages');
          messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 }));
          messages.scrollTop = Math.max(0, messages.scrollTop - 120);
          messages.dispatchEvent(new Event('scroll'));
        }, settings);
        typingEnabled = true;
        await new Promise(resolve => setTimeout(resolve, 1800));
        clearInterval(produce); clearInterval(typing);
        await Promise.all(keyRequests);
        await new Promise(resolve => setTimeout(resolve, 300));
        if (mode === 'answer') await evaluate(async () => {
          while (document.querySelector('.message-preview .message-content')?.getAttribute('aria-busy') !== 'false') await new Promise(resolve => setTimeout(resolve, 10));
        });
        const result = await evaluate(() => window.endProfile());
        const after = await window.webContents.debugger.sendCommand('Performance.getMetrics');
        const metrics = Object.fromEntries(after.metrics.filter(m => ['ScriptDuration','RecalcStyleDuration','LayoutDuration'].includes(m.name)).map(m => [m.name, m.value - (before.metrics.find(p=>p.name===m.name)?.value ?? 0)]));
        console.log('Streaming interaction metrics on '+process.platform+': '+JSON.stringify({ id, mode, sent: token, keys, settings, ...result, metrics }));
        assert.equal(result.lastToken, (token - 1) - ((token - 1) % 3), 'the rendered answer did not catch up with the event stream');
        if (mode === 'answer') assert.equal(result.retainedCode, true, 'streaming replaced existing code/link DOM');
        assert.ok(result.maxEventLag < 500, 'Runtime events queued behind a blocked renderer');
        assert.ok(result.inputs >= Math.floor(keys * 0.8), 'typing events were lost during output');
        assert.ok(result.frames > 10, 'streaming did not produce visible frames');
        assert.ok(result.maxGap < 500, `The app event loop stalled for ${result.maxGap.toFixed(0)}ms`);
        assert.ok(result.maxFrameGap < 500, `Painting stalled for ${result.maxFrameGap.toFixed(0)}ms`);
        assert.ok(settings.openedMs < 500, 'opening Settings stalled while output was streaming');
        console.log('Streaming interactions passed: '+id+' '+mode);
        window.webContents.send('cuppet:event', { type: 'message.completed', message: { id: assistantId, sessionId: id, role: 'assistant', content, status: 'complete', sequence } });
        window.webContents.send('cuppet:event', { type: 'run.finished', sessionId: id });
        // Let the finish-triggered history refresh settle before switching chats or shutting down.
        await evaluate(async (id) => {
          await window.cuppet.sessions.get(id);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, id);
      }
      assert.deepEqual(errors, [], 'The full app reported renderer errors during streaming');
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
await import('../src/main/bootstrap.mjs');
