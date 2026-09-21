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

    if (this.#usePty && !ptyProcess && process.platform !== 'win32') {
      try {
        ptyProcess = ptySpawnWithPython(shell, {
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
      const args = process.platform === 'win32' ? [] : ['-i'];
      child = this.#spawn(shell, args, {
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
    if (!session.child?.stdin?.writable) throw new Error('Terminal is not accepting input');
    const input = text.replace(/\r/g, '\n');
    session.child.stdin.write(input);
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
    const interrupted = session.child?.kill ? session.child.kill('SIGINT') : false;
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
    if (session.ptyProcess?.kill) {
      try { session.ptyProcess.kill('SIGTERM'); } catch {}
    }
    try { session.child?.stdin?.end(); } catch {}
    try { session.child?.kill?.('SIGTERM'); } catch {}
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

function ptySpawnWithPython(shell, { cols = 80, rows = 24, cwd = process.cwd(), env = process.env } = {}) {
  const pyCode = `
import os, sys, select, pty, fcntl, termios, struct, signal

cols = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 80
rows = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 24
shell = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else '/bin/zsh'
cwd = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else os.getcwd()

try: os.chdir(cwd)
except Exception: pass

env = os.environ.copy()
env['PWD'] = cwd
env['TERM'] = 'xterm-256color'
env['COLORTERM'] = 'truecolor'

pid, master_fd = pty.fork()
if pid == 0:
    os.execlpe(shell, shell, '-l', env)

fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

try:
    while True:
        rfds, _, _ = select.select([0, master_fd], [], [])
        if master_fd in rfds:
            try:
                data = os.read(master_fd, 4096)
                if not data: break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break
        if 0 in rfds:
            try:
                data = os.read(0, 4096)
                if not data: break
                if b'\\x1b]99;resize;' in data:
                    parts = data.split(b'\\x1b]99;resize;')
                    if parts[0]: os.write(master_fd, parts[0])
                    for part in parts[1:]:
                        if b'\\x07' in part:
                            cmd, rest = part.split(b'\\x07', 1)
                            try:
                                c_str, r_str = cmd.decode('utf-8').split(';')
                                new_c, new_r = int(c_str), int(r_str)
                                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', new_r, new_c, 0, 0))
                                try: os.kill(pid, signal.SIGWINCH)
                                except ProcessLookupError: pass
                            except Exception: pass
                            if rest: os.write(master_fd, rest)
                        else:
                            os.write(master_fd, b'\\x1b]99;resize;' + part)
                else:
                    os.write(master_fd, data)
            except OSError:
                break
finally:
    try: os.close(master_fd)
    except Exception: pass
`;

  const child = spawn('python3', ['-c', pyCode, String(cols), String(rows), shell, cwd], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return {
    write(data) {
      if (child.stdin?.writable) child.stdin.write(data);
    },
    resize(newCols, newRows) {
      if (child.stdin?.writable) child.stdin.write(`\\x1b]99;resize;${newCols};${newRows}\\x07`);
    },
    onData(cb) {
      child.stdout?.on('data', (chunk) => cb(chunk));
    },
    onExit(cb) {
      child.on('exit', (exitCode, signal) => cb({ exitCode, signal }));
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}

