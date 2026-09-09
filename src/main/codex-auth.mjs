import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';

let resolvedBinaryPromise;
let activeLogin = null;
let lastLoginMessage = '';

export function installCodexAuthIpc() {
  ipcMain.handle('cuppet:codex-auth:status', () => codexAuthStatus());
  ipcMain.handle('cuppet:codex-auth:login', () => startCodexLogin());
  ipcMain.handle('cuppet:codex-auth:logout', () => logoutCodex());
}

async function codexAuthStatus() {
  const binary = await resolveCodexBinary();
  if (!binary) {
    return {
      available: false,
      loggedIn: false,
      loginRunning: Boolean(activeLogin),
      method: null,
      message: 'Official Codex CLI was not found. Install @openai/codex, then reopen Settings.',
    };
  }

  const version = await run(binary, ['--version'], 5_000).catch(() => ({ stdout: '' }));
  const result = await run(binary, ['login', 'status'], 8_000).catch((error) => ({ stdout: '', stderr: error?.message ?? '' }));
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const loggedIn = /logged in using/i.test(text);
  const method = /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'api-key' : null;
  return {
    available: true,
    loggedIn,
    loginRunning: Boolean(activeLogin),
    method,
    version: String(version.stdout ?? '').trim().slice(0, 120),
    message: loggedIn ? (method === 'chatgpt' ? 'Connected with ChatGPT through official Codex OAuth.' : 'Codex is authenticated with an API key.') : (lastLoginMessage || 'Not connected to ChatGPT.'),
  };
}

async function startCodexLogin() {
  const binary = await resolveCodexBinary();
  if (!binary) throw new Error('Official Codex CLI was not found. Install @openai/codex first.');
  if (activeLogin) return { started: false, running: true };

  lastLoginMessage = 'Complete the ChatGPT sign-in in your browser.';
  const child = spawn(binary, ['login'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeLogin = child;
  let output = '';
  const capture = (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_192); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', (error) => {
    lastLoginMessage = error?.message || 'Codex login could not start.';
    activeLogin = null;
  });
  child.once('exit', (code) => {
    lastLoginMessage = code === 0 ? 'ChatGPT sign-in completed.' : (output.trim() || `Codex login exited with code ${code ?? 'unknown'}.`);
    activeLogin = null;
  });
  return { started: true, running: true };
}

async function logoutCodex() {
  if (activeLogin) {
    activeLogin.kill('SIGTERM');
    activeLogin = null;
  }
  const binary = await resolveCodexBinary();
  if (!binary) throw new Error('Official Codex CLI was not found.');
  await run(binary, ['logout'], 10_000);
  lastLoginMessage = 'Signed out of ChatGPT in Codex.';
  return codexAuthStatus();
}

async function resolveCodexBinary() {
  if (!resolvedBinaryPromise) resolvedBinaryPromise = findCodexBinary();
  return resolvedBinaryPromise;
}

async function findCodexBinary() {
  const home = homedir();
  const candidates = [
    process.env.CUPPET_CODEX_BIN,
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.local', 'bin', 'codex'),
    join(home, '.npm-global', 'bin', 'codex'),
    'codex',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try { await access(candidate, constants.X_OK); } catch { continue; }
    }
    try {
      await run(candidate, ['--version'], 4_000);
      return candidate;
    } catch {
      // Try the next official Codex installation location.
    }
  }
  return null;
}

function run(binary, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env: process.env, timeout, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || stdout || error.message || 'Codex command failed').trim();
        const wrapped = new Error(message);
        wrapped.cause = error;
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}
