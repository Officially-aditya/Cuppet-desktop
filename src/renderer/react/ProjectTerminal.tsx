import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

type TerminalSession = {
  sessionId: string;
  projectId: string;
  cwd: string;
  shell: string;
  startedAt: number;
};

type TerminalEvent = {
  sessionId: string;
  projectId: string;
  type: 'output' | 'exit' | 'error';
  stream?: 'stdout' | 'stderr';
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
};

type TerminalApi = {
  start: (projectId: string) => Promise<TerminalSession>;
  write: (sessionId: string, input: string) => Promise<{ written: boolean }>;
  interrupt: (sessionId: string) => Promise<{ interrupted: boolean }>;
  stop: (sessionId: string) => Promise<{ stopped: boolean }>;
  onEvent: (handler: (event: TerminalEvent) => void) => () => void;
};

type Props = {
  project: Project | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type OutputChunk = {
  id: number;
  kind: 'stdout' | 'stderr' | 'command';
  text: string;
};

const MAX_CHARS = 180_000;
const MAX_HISTORY = 80;

export function ProjectTerminal({ project, open: openProp, onOpenChange }: Props) {
  const terminal = (window.cuppet as typeof window.cuppet & { terminal: TerminalApi }).terminal;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(openProp ?? uncontrolledOpen) : value;
    if (onOpenChange) onOpenChange(next);
    else setUncontrolledOpen(next);
  };
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [output, setOutput] = useState<OutputChunk[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'exited' | 'error'>('idle');
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextId = useRef(1);
  const sessionRef = useRef<TerminalSession | null>(null);
  const projectIdRef = useRef<string | null>(project?.id ?? null);
  const startGeneration = useRef(0);

  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    projectIdRef.current = project?.id ?? null;
    startGeneration.current += 1;
    const active = sessionRef.current;
    sessionRef.current = null;
    setOpen(false);
    setSession(null);
    setOutput([]);
    setInput('');
    setHistory([]);
    setHistoryIndex(-1);
    setStatus('idle');
    if (active) void terminal.stop(active.sessionId).catch(() => undefined);
  }, [project?.id, terminal]);

  useEffect(() => {
    const unsubscribe = terminal.onEvent((event) => {
      const active = sessionRef.current;
      if (!active || event.sessionId !== active.sessionId || event.projectId !== active.projectId) return;
      handleTerminalEvent(event);
    });
    return unsubscribe;
  }, [terminal]);

  useEffect(() => {
    return () => {
      startGeneration.current += 1;
      const active = sessionRef.current;
      sessionRef.current = null;
      if (active) void terminal.stop(active.sessionId).catch(() => undefined);
    };
  }, [terminal]);

  useEffect(() => {
    if (!open || !project) return;
    if (!session && status !== 'starting') void startTerminal(project.id);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, project?.id, session, status]);

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
  }, [project?.id, setOpen]);

  if (!project) return null;

  async function startTerminal(projectId: string) {
    const generation = ++startGeneration.current;
    setStatus('starting');
    try {
      const next = await terminal.start(projectId);
      const stale = generation !== startGeneration.current || projectIdRef.current !== projectId;
      if (stale) {
        await terminal.stop(next.sessionId).catch(() => undefined);
        return;
      }
      setSession(next);
      sessionRef.current = next;
      setStatus('ready');
    } catch (reason) {
      if (generation !== startGeneration.current || projectIdRef.current !== projectId) return;
      append('stderr', `${cleanError(reason)}\n`);
      setStatus('error');
    }
  }

  async function submit() {
    const command = input.trimEnd();
    const active = sessionRef.current;
    if (!active || status !== 'ready') return;
    if (!command.trim()) {
      await terminal.write(active.sessionId, '\n');
      setInput('');
      return;
    }
    append('command', `❯ ${command}\n`);
    setHistory((current) => [command, ...current.filter((item) => item !== command)].slice(0, MAX_HISTORY));
    setHistoryIndex(-1);
    setInput('');
    try {
      await terminal.write(active.sessionId, `${command}\n`);
    } catch (reason) {
      append('stderr', `${cleanError(reason)}\n`);
      setStatus('error');
    }
  }

  function handleTerminalEvent(event: TerminalEvent) {
    if (event.type === 'output' && event.data) {
      append(event.stream === 'stderr' ? 'stderr' : 'stdout', stripAnsi(event.data));
      return;
    }
    if (event.type === 'exit') {
      setStatus('exited');
      setSession(null);
      sessionRef.current = null;
      return;
    }
    if (event.type === 'error') {
      append('stderr', `${event.message || 'Terminal error'}\n`);
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
      void terminal.interrupt(active.sessionId).catch((reason) => append('stderr', `${cleanError(reason)}\n`));
    }
  }

  return (
    <section className={`project-terminal ${open ? 'open' : 'collapsed'}`} aria-label="Project terminal">
      <button type="button" className="project-terminal-bar" aria-expanded={open} aria-label={open ? 'Hide terminal' : 'Show terminal'} onClick={() => setOpen((current) => !current)}>
        <span className="project-terminal-title">Terminal</span>
        <span className="project-terminal-shortcut">⌘J</span>
      </button>

      {open && (
        <div className="project-terminal-body">
          <div ref={outputRef} className="project-terminal-output" role="log">
            {output.map((item) => <span key={item.id} className={`terminal-output-${item.kind}`}>{item.text}</span>)}
          </div>
          <div className="project-terminal-input-row">
            <span className="project-terminal-prompt" aria-hidden="true">❯</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Terminal command"
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
