import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProviderAuthentication } from '../../../src/renderer/react/ProviderAuthentication';

const listeners = new Set<(event: any) => void>();
const calls: any[] = [];
const page = window as any;
page.cuppet = {
  onEvent: (listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  cliAgents: {
    authRespond: async (id: string, response: any) => { calls.push({ kind: 'respond', id, response }); return { accepted: true }; },
    authCancel: async (id: string) => { calls.push({ kind: 'cancel', id }); return { cancelled: true }; },
  },
  native: {
    openExternal: async (url: string) => { calls.push({ kind: 'open', url }); return { opened: true }; },
    copyText: async (text: string) => { calls.push({ kind: 'copy', text }); return { copied: true }; },
  },
};
document.body.style.cssText = 'margin:24px;background:#202024;color:#eee;font:14px sans-serif';
const root = createRoot(document.getElementById('root')!);
root.render(<ProviderAuthentication providerID="claude-code" />);
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
const emit = (event: any) => { for (const listener of listeners) listener({ type: 'provider.authentication', providerID: 'claude-code', authId: 'setup-1', ...event }); };
page.authSmoke = {
  calls,
  async start() {
    await pause();
    emit({ kind: 'started' });
    emit({ kind: 'terminal' });
    emit({ kind: 'output', data: 'Paste sign-in code here > ' });
    await pause();
    return Boolean(document.querySelector('.xterm-helper-textarea'));
  },
  async browser() {
    emit({ kind: 'url', requestId: 'browser-1', url: 'https://example.com/login' });
    await pause();
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Open example.com');
    if (!button) throw new Error('Browser destination was not displayed');
    button.click();
    await pause();
  },
  async cancel() {
    [...document.querySelectorAll('button')].find((item) => item.textContent === 'Cancel')!.click();
    await pause();
    emit({ kind: 'failed', message: 'Provider sign-in was cancelled.' });
    await pause();
    return document.body.textContent;
  },
  async unmount() { emit({ kind: 'started', authId: 'setup-2' }); await pause(); root.unmount(); await pause(); },
};
