import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalAppearance } from './appearance';
import './provider-authentication.css';

type AuthState = { id: string; active: boolean; message: string; url?: string; requestId?: string; showTerminal?: boolean };

export function ProviderAuthentication({ providerID }: { providerID: string }) {
  const [state, setState] = useState<AuthState | null>(null);
  const active = useRef<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const terminalAuthId = useRef<string | null>(null);
  const pendingOutput = useRef('');

  useEffect(() => {
    setState(null);
    const unsubscribe = window.cuppet.onEvent((event) => {
      if (event.type !== 'provider.authentication' || event.providerID !== providerID) return;
      if (event.kind === 'started') {
        active.current = event.authId;
        pendingOutput.current = '';
        setState({ id: event.authId, active: true, message: 'Preparing provider sign-in…' });
        return;
      }
      if (event.authId !== active.current) return;
      if (event.kind === 'output') {
        setState((current) => current && !current.showTerminal ? { ...current, showTerminal: true } : current);
        if (terminalAuthId.current === event.authId) terminal.current?.write(event.data);
        else pendingOutput.current = `${pendingOutput.current}${event.data}`.slice(-64_000);
      } else if (event.kind === 'url') {
        setState((current) => current ? { ...current, url: event.url, requestId: event.requestId, message: 'Open the provider’s sign-in page to continue.' } : current);
      } else if (event.kind === 'terminal') {
        setState((current) => current ? { ...current, showTerminal: true, message: 'Complete sign-in below. You can paste codes and answer prompts here.' } : current);
        terminal.current?.focus();
      } else if (event.kind === 'finished' || event.kind === 'failed') {
        active.current = null;
        setState((current) => current ? { ...current, active: false, url: undefined, requestId: undefined,
          message: event.kind === 'finished' ? 'Provider sign-in verified.' : event.message || 'Provider sign-in did not complete.' } : current);
      }
    });
    return () => {
      unsubscribe();
      const id = active.current;
      active.current = null;
      if (id) void window.cuppet.cliAgents.authCancel(id).catch(() => undefined);
    };
  }, [providerID]);

  useEffect(() => {
    if (!container.current || !state?.id) return;
    const id = state.id;
    const term = new Terminal({ cursorBlink: true, fontSize: 12, rows: 18, theme: terminalAppearance(), scrollback: 500, convertEol: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    terminal.current = term;
    terminalAuthId.current = id;
    term.write(pendingOutput.current);
    pendingOutput.current = '';
    const input = term.onData((data) => {
      if (active.current === id) void window.cuppet.cliAgents.authRespond(id, { data }).catch(() => undefined);
    });
    const resize = () => {
      fit.fit();
      if (active.current === id) void window.cuppet.cliAgents.authRespond(id, { cols: term.cols, rows: term.rows }).catch(() => undefined);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    term.focus();
    return () => { observer.disconnect(); input.dispose(); term.dispose(); terminal.current = null; terminalAuthId.current = null; };
  }, [state?.id, state?.showTerminal]);

  if (!state) return null;
  const respondToBrowser = async (accept: boolean) => {
    if (!state.url || !state.active) return;
    try {
      if (accept) await window.cuppet.native.openExternal(state.url);
      if (state.requestId) await window.cuppet.cliAgents.authRespond(state.id, { requestId: state.requestId, action: accept ? 'accept' : 'decline' });
      setState((current) => current?.active && current.id === state.id ? { ...current, requestId: undefined, message: accept ? 'Finish signing in with your provider, then return here.' : 'Browser sign-in declined.' } : current);
    } catch (error) {
      setState((current) => current ? { ...current, message: error instanceof Error ? error.message : String(error) } : current);
    }
  };
  return <section className="provider-sign-in" aria-label="Provider sign-in">
    <div className="provider-sign-in-heading"><strong>Sign in</strong>{state.active && <button type="button" className="ghost-button" onClick={() => void window.cuppet.cliAgents.authCancel(state.id).catch(() => undefined)}>Cancel</button>}</div>
    <p role="status">{state.message}</p>
    {state.url && state.active && <div className="provider-sign-in-browser">
      <button type="button" className="primary-button" onClick={() => void respondToBrowser(true)}>Open {new URL(state.url).host}</button>
      <button type="button" className="ghost-button" onClick={() => void window.cuppet.native.copyText(state.url!).catch(() => undefined)}>Copy link</button>
      {state.requestId && <button type="button" className="ghost-button" onClick={() => void respondToBrowser(false)}>Decline</button>}
    </div>}
    {state.showTerminal && <div ref={container} className="provider-sign-in-terminal" aria-label="Interactive provider sign-in terminal" />}
  </section>;
}
