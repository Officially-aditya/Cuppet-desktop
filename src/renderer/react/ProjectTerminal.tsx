import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, TerminalEvent, TerminalSession } from '../types';

type Props = {
  project: Project | null;
};

type OutputChunk = {
  id: number;
  kind: 'stdout' | 'stderr' | 'command' | 'system';
  text: string;
};

const MAX_CHARS = 180_000;
const MAX_HISTORY = 80;

export function ProjectTerminal({ project }: Props) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [output, setOutput] = useState<OutputChunk[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'exited' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextId = useRef(1);
  const sessionRef = useRef<TerminalSession | null>(null);

  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    setOpen(false);
    setSession(null);
    setOutput([]);
    setInput('');
    setHistoryIndex(-1);
    setStatus('idle');
    setError(null);
  }, [project?.id]);

  useEffect(() => {
    const unsubscribe = window.cuppet.terminal.onEvent((event) => {
      const active = sessionRef.current;
      if (!active || event.sessionId !== active.sessionId) return;
      handleTerminalEvent(event);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
      const active = sessionRef.current;
      if (active) void window.cuppet.terminal.stop(active.sessionId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!open || !project) return;
    if (!session && status !== 'starting') void startTerminal();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, project?.id]);

  useEffect(() => {
    const node = outputRef.current;
    if (!node || !open) return;
    node.scrollTop = node.scrollHeight;
  }, [open, output]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return;
      if (!project) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [project?.id]);

  const prompt = useMemo(() => project?.name?.trim() || 'project', [project?.name]);
  if (!project) return null;

  async function startTerminal() {
    setStatus('starting');
    setError(null);
    try {
      const next = await window.cuppet.terminal.start(project.id);
      setSession(next);
      sessionRef.current = next;
      setStatus('ready');
      append('system', `Shell ready at ${next.cwd}\n`);
    } catch (reason) {
      setStatus('error');
      setError(cleanError(reason));
    }
  }

  async function restart() {
    const active = sessionRef.current;
    if (active) await window.cuppet.terminal.stop(active.sessionId).catch(() => undefined);
    setSession(null);
    sessionRef.current = null;
    setOutput([]);
    setStatus('idle');
    await startTerminal();
  }

  async function submit() {
    const command = input.trimEnd();
    const active = sessionRef.current;
    if (!active || status !== 'ready') return;
    if (!command.trim()) {
      await window.cuppet.terminal.write(active.sessionId, '\n');
      setInput('');
      return;
    }
    append('command', `❯ ${command}\n`);
    setHistory((current) => [command, ...current.filter((item) => item !== command)].slice(0, MAX_HISTORY));
    setHistoryIndex(-1);
    setInput('');
    try {
      await window.cuppet.terminal.write(active.sessionId, `${command}\n`);
    } catch (reason) {
      append('system', `${cleanError(reason)}\n`);
      setStatus('error');
    }
  }

  function handleTerminalEvent(event: TerminalEvent) {
    if (event.type === 'output' && event.data) {
      append(event.stream === 'stderr' ? 'stderr' : 'stdout', stripAnsi(event.data));
      return;
    }
    if (event.type === 'exit') {
      append('system', `\nShell exited${event.code !== null && event.code !== undefined ? ` with code ${event.code}` : ''}${event.signal ? ` (${event.signal})` : ''}.\n`);
      setStatus('exited');
      setSession(null);
      sessionRef.current = null;
      return;
    }
    if (event.type === 'error') {
      const message = event.message || 'Terminal error';
      append('system', `${message}\n`);
      setError(message);
      setStatus('error');
    }
  }

  function append(kind: OutputChunk['kind'], text: string) {
    if (!text) return;
    setOutput((current) => trimOutput([...current, { id: nextId.current++, kind, text }]));
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === 'ArrowUp') {
      if (!history.length) return;
      event.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      setInput(history[next] ?? '');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = historyIndex - 1;
      if (next < 0) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(next);
        setInput(history[next] ?? '');
      }
      return;
    }
    if (event.key === 'c' && event.ctrlKey && !event.metaKey) {
      const active = sessionRef.current;
      if (!active) return;
      event.preventDefault();
      append('command', '^C\n');
      void window.cuppet.terminal.interrupt(active.sessionId).catch((reason) => append('system', `${cleanError(reason)}\n`));
    }
  }

  return (
    <section className={`project-terminal ${open ? 'open' : 'collapsed'}`} aria-label="Project terminal">
      <button type="button" className="project-terminal-bar" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="project-terminal-glyph">›_</span>
        <span className="project-terminal-title">Terminal</span>
        <span className="project-terminal-project">{project.name}</span>
        <span className={`project-terminal-status ${status}`}>{status === 'ready' ? 'ready' : status === 'starting' ? 'starting…' : status === 'error' ? 'error' : status === 'exited' ? 'exited' : ''}</span>
        <span className="project-terminal-shortcut">⌘J</span>
        <span className="project-terminal-chevron" aria-hidden="true">{open ? '⌄' : '⌃'}</span>
      </button>

      {open && (
        <div className="project-terminal-body">
          <div className="project-terminal-toolbar">
            <span className="project-terminal-cwd" title={session?.cwd || project.path || ''}>{session?.cwd || project.path || project.name}</span>
            <div className="project-terminal-actions">
              <button type="button" onClick={() => setOutput([])}>Clear</button>
              <button type="button" onClick={() => void restart()}>Restart</button>
            </div>
          </div>
          <div ref={outputRef} className="project-terminal-output" role="log" aria-live="polite">
            {output.map((item) => <span key={item.id} className={`terminal-output-${item.kind}`}>{item.text}</span>)}
            {status === 'starting' && <span className="terminal-output-system">Starting shell at the project root…\n</span>}
            {error && <span className="terminal-output-stderr">{error}\n</span>}
          </div>
          <div className="project-terminal-input-row">
            <span className="project-terminal-prompt" title={session?.cwd || project.path || ''}>{prompt} ❯</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Terminal command"
              placeholder={status === 'ready' ? 'Run a command' : 'Starting shell…'}
              disabled={status !== 'ready'}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function trimOutput(chunks: OutputChunk[]) {
  let total = chunks.reduce((sum, item) => sum + item.text.length, 0);
  let index = 0;
  while (total > MAX_CHARS && index < chunks.length - 1) {
    total -= chunks[index].text.length;
    index += 1;
  }
  return index ? chunks.slice(index) : chunks;
}

function stripAnsi(value: string) {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function cleanError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'Terminal error');
}
