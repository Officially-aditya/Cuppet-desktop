import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
let pty = null;
try {
  pty = require('node-pty');
} catch {}

const MAX_WRITE_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;

export class ProjectTerminalManager {
  #request;
  #spawn;
  #usePty;
  #sessions = new Map();
  #startTokens = new Map();

  constructor({ request, spawnProcess = spawn, usePty = true } = {}) {
    if (typeof request !== 'function') throw new TypeError('ProjectTerminalManager requires a runtime request function');
    this.#request = request;
    this.#spawn = spawnProcess;
    this.#usePty = spawnProcess === spawn && usePty !== false;
  }

  async start(sender, projectId, options = {}) {
    if (!sender || typeof sender.send !== 'function') throw new Error('Terminal requires a renderer owner');
    const id = boundedId(projectId) || 'default';

    for (const session of [...this.#sessions.values()]) {
      if (session.ownerId !== sender.id || session.closed) continue;
      if (session.projectId === id) return terminalDescriptor(session);
      this.#stopSession(session);
    }

    const startToken = randomUUID();
    this.#startTokens.set(sender.id, startToken);
    const root = await resolveProjectTerminalRoot(this.#request, id);
    const shell = await resolveTerminalShell();
    if (this.#startTokens.get(sender.id) !== startToken) throw new Error('Terminal start was superseded');

    const sessionId = `terminal_${randomUUID()}`;
    const cols = Number.isInteger(options?.cols) && options.cols > 0 ? options.cols : 80;
    const rows = Number.isInteger(options?.rows) && options.rows > 0 ? options.rows : 24;

    let ptyProcess = null;
    let child = null;

    if (this.#usePty && pty && typeof pty.spawn === 'function') {
      try {
        ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: root,
          env: {
            ...process.env,
            PWD: root,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          },
        });
      } catch {
        ptyProcess = null;
      }
    }

    if (!ptyProcess) {
      child = this.#spawn(shell, [], {
        cwd: root,
        env: {
          ...process.env,
          PWD: root,
          TERM: process.env.TERM || 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }

    if (this.#startTokens.get(sender.id) === startToken) this.#startTokens.delete(sender.id);

    const session = {
      id: sessionId,
      projectId: id,
      root,
      shell,
      ownerId: sender.id,
      sender,
      child,
      ptyProcess,
      closed: false,
      startedAt: Date.now(),
    };
    this.#sessions.set(sessionId, session);

    if (ptyProcess) {
      ptyProcess.onData((data) => this.#emitOutput(session, 'stdout', data));
      ptyProcess.onExit(({ exitCode, signal }) => {
        session.closed = true;
        this.#emit(session, { type: 'exit', code: Number.isInteger(exitCode) ? exitCode : null, signal: signal || null });
        this.#sessions.delete(session.id);
      });
    } else if (child) {
      child.stdout?.on('data', (chunk) => this.#emitOutput(session, 'stdout', chunk));
      child.stderr?.on('data', (chunk) => this.#emitOutput(session, 'stderr', chunk));
      child.on('error', (error) => {
        this.#emit(session, { type: 'error', message: cleanError(error) });
      });
      child.on('exit', (code, signal) => {
        session.closed = true;
        this.#emit(session, { type: 'exit', code: Number.isInteger(code) ? code : null, signal: signal || null });
        this.#sessions.delete(session.id);
      });
    }

    if (typeof sender.once === 'function') {
      sender.once('destroyed', () => this.stopOwner(sender.id));
    }

    return terminalDescriptor(session);
  }

  write(sender, sessionId, value) {
    const session = this.#ownedSession(sender, sessionId);
    const text = typeof value === 'string' ? value : '';
    if (!text) return { written: false };
    if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) throw new Error('Terminal input is too large');
    if (session.ptyProcess) {
      session.ptyProcess.write(text);
      return { written: true };
    }
    if (!session.child.stdin?.writable) throw new Error('Terminal is not accepting input');
    session.child.stdin.write(text);
    return { written: true };
  }

  resize(sender, sessionId, cols, rows) {
    const session = this.#ownedSession(sender, sessionId);
    if (session.closed) return { resized: false };
    const c = Number.isInteger(cols) && cols > 0 ? cols : 80;
    const r = Number.isInteger(rows) && rows > 0 ? rows : 24;
    if (session.ptyProcess?.resize) {
      try {
        session.ptyProcess.resize(c, r);
        return { resized: true, cols: c, rows: r };
      } catch {
        return { resized: false };
      }
    }
    return { resized: false };
  }

  interrupt(sender, sessionId) {
    const session = this.#ownedSession(sender, sessionId);
    if (session.closed) return { interrupted: false };
    if (session.ptyProcess) {
      session.ptyProcess.write('\x03');
      return { interrupted: true };
    }
    const interrupted = session.child.kill('SIGINT');
    return { interrupted };
  }

  stop(sender, sessionId) {
    const session = this.#ownedSession(sender, sessionId);
    return this.#stopSession(session);
  }

  stopOwner(ownerId) {
    this.#startTokens.delete(ownerId);
    for (const session of [...this.#sessions.values()]) {
      if (session.ownerId === ownerId) this.#stopSession(session);
    }
  }

  stopAll() {
    this.#startTokens.clear();
    for (const session of [...this.#sessions.values()]) this.#stopSession(session);
  }

  #ownedSession(sender, sessionId) {
    const id = boundedId(sessionId);
    const session = this.#sessions.get(id);
    if (!session || session.closed) throw new Error('Terminal session is not active');
    if (!sender || session.ownerId !== sender.id) throw new Error('Terminal session belongs to another renderer');
    return session;
  }

  #stopSession(session) {
    if (!session || session.closed) return { stopped: false };
    session.closed = true;
    try { session.child.stdin?.end(); } catch {}
    try { session.child.kill('SIGTERM'); } catch {}
    this.#sessions.delete(session.id);
    return { stopped: true };
  }

  #emitOutput(session, stream, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (!text) return;
    this.#emit(session, { type: 'output', stream, data: truncateUtf8(text, MAX_EVENT_BYTES) });
  }

  #emit(session, payload) {
    if (session.sender?.isDestroyed?.()) return;
    try {
      session.sender.send('cuppet:terminal:event', {
        sessionId: session.id,
        projectId: session.projectId,
        ...payload,
      });
    } catch {}
  }
}

export async function resolveProjectTerminalRoot(request, projectId) {
  const id = boundedId(projectId);
  if (!id || id === 'default') {
    return resolveFallbackTerminalRoot();
  }
  let project = null;
  if (typeof request === 'function') {
    try {
      project = await request('project.get', { projectId: id });
    } catch {}
  }
  if (!project || project.missing) {
    return resolveFallbackTerminalRoot();
  }
  const configured = typeof project.canonicalPath === 'string' ? project.canonicalPath.trim() : '';
  if (!configured || !isAbsolute(configured) || configured.includes('\0')) {
    throw new Error('The canonical project root is invalid');
  }
  try {
    const root = await realpath(configured);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) return resolveFallbackTerminalRoot();
    return root;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return resolveFallbackTerminalRoot();
    }
    throw error;
  }
}

export async function resolveFallbackTerminalRoot() {
  const candidates = [
    homedir(),
    process.env.HOME,
    '/',
  ].filter((value) => typeof value === 'string' && isAbsolute(value));

  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (metadata.isDirectory()) return resolved;
    } catch {}
  }
  return '/';
}

export async function resolveTerminalShell() {
  const candidates = [process.env.SHELL, process.platform === 'darwin' ? '/bin/zsh' : null, '/bin/bash', '/bin/sh']
    .filter((value) => typeof value === 'string' && isAbsolute(value));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('No supported shell was found');
}

function terminalDescriptor(session) {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    cwd: session.root,
    shell: session.shell,
    startedAt: session.startedAt,
  };
}

function boundedId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 256) : '';
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return buffer.toString('utf8').replace(/\uFFFD$/u, '');
}

function cleanError(error) {
  return error instanceof Error ? error.message : String(error ?? 'Terminal error');
}
