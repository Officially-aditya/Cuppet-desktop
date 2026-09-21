import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
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
  start: (projectId: string, options?: { cols?: number; rows?: number }) => Promise<TerminalSession>;
  write: (sessionId: string, input: string) => Promise<{ written: boolean }>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<{ resized: boolean }>;
  interrupt: (sessionId: string) => Promise<{ interrupted: boolean }>;
  stop: (sessionId: string) => Promise<{ stopped: boolean }>;
  onEvent: (handler: (event: TerminalEvent) => void) => () => void;
};

type Props = {
  project: Project | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function ProjectTerminal({ project, open: openProp, onOpenChange }: Props) {
  const terminal = (window.cuppet as typeof window.cuppet & { terminal?: TerminalApi })?.terminal;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;

  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  const setOpen = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(openRef.current) : value;
    if (onOpenChangeRef.current) onOpenChangeRef.current(next);
    else setUncontrolledOpen(next);
  }, []);

  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'exited' | 'error'>('idle');
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const projectIdRef = useRef<string | null>(project?.id ?? null);
  const prevProjectIdRef = useRef<string | null>(project?.id ?? null);
  const startGeneration = useRef(0);

  useEffect(() => { sessionRef.current = session; }, [session]);

  // Handle project switch: only trigger when project?.id actually changes
  useEffect(() => {
    const currentId = project?.id ?? null;
    if (prevProjectIdRef.current === currentId) return;
    prevProjectIdRef.current = currentId;
    projectIdRef.current = currentId;
    startGeneration.current += 1;
    const active = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStatus('idle');
    if (active && terminal) void terminal.stop(active.sessionId).catch(() => undefined);
    if (xtermRef.current) {
      xtermRef.current.reset();
    }
    if (open && currentId) {
      void startTerminal(currentId);
    }
  }, [project?.id, terminal, open]);

  // Listen to terminal backend events
  useEffect(() => {
    if (!terminal?.onEvent) return;
    const unsubscribe = terminal.onEvent((event) => {
      const active = sessionRef.current;
      if (!active || event.sessionId !== active.sessionId || event.projectId !== active.projectId) return;
      if (event.type === 'output' && event.data) {
        xtermRef.current?.write(event.data);
      } else if (event.type === 'exit') {
        setStatus('exited');
        setSession(null);
        sessionRef.current = null;
        xtermRef.current?.write('\r\n\x1b[90m[Process completed]\x1b[0m\r\n');
      } else if (event.type === 'error') {
        setStatus('error');
        xtermRef.current?.write(`\r\n\x1b[31m${event.message || 'Terminal error'}\x1b[0m\r\n`);
      }
    });
    return unsubscribe;
  }, [terminal]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      startGeneration.current += 1;
      const active = sessionRef.current;
      sessionRef.current = null;
      if (active && terminal) void terminal.stop(active.sessionId).catch(() => undefined);
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminal]);

  const initTerminal = useCallback(() => {
    const container = terminalContainerRef.current;
    if (!container || xtermRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      lineHeight: 1.2,
      theme: {
        background: '#050608',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#050608',
        selectionBackground: 'rgba(56, 139, 253, 0.35)',
        selectionForeground: '#ffffff',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      allowTransparency: true,
      convertEol: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      const active = sessionRef.current;
      if (!active || !terminal) return;
      void terminal.write(active.sessionId, data).catch(() => undefined);
    });

    // Keyboard shortcuts: ⌘C to copy selection, ⌘V to paste, ⌘K to clear, ⌘J to toggle
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void window.cuppet?.native?.copyText(term.getSelection()).catch(() => undefined);
        return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        term.clear();
        return false;
      }
      return true;
    });
  }, [terminal]);

  // Start terminal session if open and no session exists
  useEffect(() => {
    if (!open) return;
    initTerminal();
    if (!session && status !== 'starting') {
      void startTerminal(project?.id || 'default');
    }
  }, [open, project?.id, session, status, initTerminal]);

  // Fit and focus when open changes to true
  useEffect(() => {
    if (!open) return;
    initTerminal();

    const frame = requestAnimationFrame(() => {
      try {
        const term = xtermRef.current;
        if (term) {
          const core = (term as any)._core;
          if (core?._charSizeService && (!core._renderService?.dimensions?.css?.cell?.width)) {
            core._charSizeService.measure();
          }
        }
        fitAddonRef.current?.fit();
        xtermRef.current?.focus();
        const active = sessionRef.current;
        if (active && terminal && xtermRef.current && xtermRef.current.cols > 0 && xtermRef.current.rows > 0) {
          void terminal.resize(active.sessionId, xtermRef.current.cols, xtermRef.current.rows).catch(() => undefined);
        }
      } catch {}
    });

    return () => cancelAnimationFrame(frame);
  }, [open, initTerminal, terminal]);

  // ResizeObserver for automatic terminal resizing
  useEffect(() => {
    const node = terminalContainerRef.current;
    if (!node || !open || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!xtermRef.current || !fitAddonRef.current) return;
      try {
        fitAddonRef.current.fit();
        const active = sessionRef.current;
        if (active && terminal && xtermRef.current.cols > 0 && xtermRef.current.rows > 0) {
          void terminal.resize(active.sessionId, xtermRef.current.cols, xtermRef.current.rows).catch(() => undefined);
        }
      } catch {}
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [open, terminal]);

  // ⌘J shortcut to toggle terminal
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'j') return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  async function startTerminal(projectId: string = 'default') {
    if (!terminal) return;
    const generation = ++startGeneration.current;
    setStatus('starting');
    try {
      const cols = xtermRef.current?.cols && xtermRef.current.cols > 0 ? xtermRef.current.cols : 80;
      const rows = xtermRef.current?.rows && xtermRef.current.rows > 0 ? xtermRef.current.rows : 24;
      const next = await terminal.start(projectId, { cols, rows });
      const stale = generation !== startGeneration.current || projectIdRef.current !== (projectId === 'default' ? null : projectId);
      if (stale) {
        await terminal.stop(next.sessionId).catch(() => undefined);
        return;
      }
      setSession(next);
      sessionRef.current = next;
      setStatus('ready');
      if (xtermRef.current && fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
          if (xtermRef.current.cols > 0 && xtermRef.current.rows > 0) {
            void terminal.resize(next.sessionId, xtermRef.current.cols, xtermRef.current.rows).catch(() => undefined);
          }
        } catch {}
      }
      xtermRef.current?.focus();
    } catch (reason) {
      if (generation !== startGeneration.current || projectIdRef.current !== (projectId === 'default' ? null : projectId)) return;
      xtermRef.current?.write(`\r\n\x1b[31m${cleanError(reason)}\x1b[0m\r\n`);
      setStatus('error');
    }
  }

  return (
    <section className={`project-terminal ${open ? 'open' : 'collapsed'}`} aria-label="Project terminal">
      <button type="button" className="project-terminal-bar" aria-expanded={open} aria-label={open ? 'Hide terminal' : 'Show terminal'} onClick={() => setOpen((current) => !current)}>
        <span className="project-terminal-title">{project?.name ? `Terminal — ${project.name}` : 'Terminal'}</span>
        <span className="project-terminal-shortcut">⌘J</span>
      </button>

      <div className="project-terminal-body" onClick={() => xtermRef.current?.focus()}>
        <div ref={terminalContainerRef} className="project-terminal-xterm-container" />
      </div>
    </section>
  );
}

function cleanError(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? 'Terminal error');
}
