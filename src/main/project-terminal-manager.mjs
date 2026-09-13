import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_WRITE_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;

export class ProjectTerminalManager {
  #request;
  #spawn;
  #sessions = new Map();

  constructor({ request, spawnProcess = spawn } = {}) {
    if (typeof request !== 'function') throw new TypeError('ProjectTerminalManager requires a runtime request function');
    this.#request = request;
    this.#spawn = spawnProcess;
  }

  async start(sender, projectId) {
    if (!sender || typeof sender.send !== 'function') throw new Error('Terminal requires a renderer owner');
    const id = boundedId(projectId);
    if (!id) throw new Error('A project is required to open the terminal');

    const existing = [...this.#sessions.values()].find((session) => session.ownerId === sender.id && session.projectId === id && !session.closed);
    if (existing) return terminalDescriptor(existing);

    const root = await resolveProjectTerminalRoot(this.#request, id);
    const shell = await resolveTerminalShell();
    const sessionId = `terminal_${randomUUID()}`;
    const child = this.#spawn(shell, [], {
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

    const session = {
      id: sessionId,
      projectId: id,
      root,
      shell,
      ownerId: sender.id,
      sender,
      child,
      closed: false,
      startedAt: Date.now(),
    };
    this.#sessions.set(sessionId, session);

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
    if (!session.child.stdin?.writable) throw new Error('Terminal is not accepting input');
    session.child.stdin.write(text);
    return { written: true };
  }

  interrupt(sender, sessionId) {
    const session = this.#ownedSession(sender, sessionId);
    if (session.closed) return { interrupted: false };
    const interrupted = session.child.kill('SIGINT');
    return { interrupted };
  }

  stop(sender, sessionId) {
    const session = this.#ownedSession(sender, sessionId);
    return this.#stopSession(session);
  }

  stopOwner(ownerId) {
    for (const session of [...this.#sessions.values()]) {
      if (session.ownerId === ownerId) this.#stopSession(session);
    }
  }

  stopAll() {
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
    this.#emit(session, { type: 'output', stream, data: text.slice(0, MAX_EVENT_BYTES) });
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
  if (!id) throw new Error('A project is required to open the terminal');
  const project = await request('project.get', { projectId: id });
  if (!project || project.missing) throw new Error('The project folder is unavailable');
  const configured = typeof project.canonicalPath === 'string' && project.canonicalPath.trim()
    ? project.canonicalPath.trim()
    : typeof project.path === 'string' ? project.path.trim() : '';
  if (!configured || !isAbsolute(configured) || configured.includes('\0')) throw new Error('The project root is invalid');
  const root = await realpath(configured);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error('The project root is not a directory');
  return root;
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

function cleanError(error) {
  return error instanceof Error ? error.message : String(error ?? 'Terminal error');
}
