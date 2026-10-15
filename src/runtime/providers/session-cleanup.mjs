import { spawn } from 'node:child_process';
import { lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localCliLaunch } from '../local-cli-launch.mjs';
import { providerSessionStore } from './session-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sweep = null;

export function cleanupOwnedProviderSessions(configuration = {}, { store = providerSessionStore(), runtimeFactory = cleanupRuntime } = {}) {
  if (sweep) return sweep;
  const providers = [...new Set(store.pending(null, Infinity).map(record => record.providerID))];
  if (!providers.length) return Promise.resolve({ remaining: 0 });
  sweep = (async () => {
    for (const providerID of providers) {
      let runtime;
      try {
        const config = (configuration.providerID || configuration.primary?.providerID) === providerID ? configuration : { providerID };
        runtime = await runtimeFactory(config, store);
        await runtime?.cleanupPendingSessions();
      } catch {
        // Keep ownership evidence for providers which are unavailable or need login.
      } finally { await Promise.resolve(runtime?.close()).catch(() => undefined); }
    }
    return { remaining: store.pending(null, Infinity).length };
  })().finally(() => { sweep = null; });
  return sweep;
}

async function cleanupRuntime(configuration, sessionStore) {
  const { createProviderRuntime } = await import('./default-registry.mjs');
  const { AcpSessionRuntime } = await import('./transports/acp/acp-session.mjs');
  const managed = createProviderRuntime(configuration).cuppetManagedRuntime?.();
  if (managed?.protocol !== 'acp') return null;
  return new AcpSessionRuntime({ descriptor: managed.descriptor, configuration: managed.configuration, sessionStore });
}

export async function deleteGrokSessions({ command, environment, records }) {
  for (const record of records) await runCleanupCommand(command, ['--no-auto-update', 'sessions', 'delete', record.sessionId], environment);
}

export async function deleteKiroSessions({ command, environment, records }) {
  for (const record of records) await runCleanupCommand(command, ['chat', '--delete-session', record.sessionId], environment);
}

export async function deleteAntigravitySessions({ environment, records }) {
  const root = join(environment.GEMINI_HOME || join(environment.HOME || homedir(), '.gemini'), 'antigravity-acp');
  for (const { sessionId } of records) {
    if (!UUID.test(sessionId)) throw new Error('Antigravity returned an unsupported conversation ID; cleanup deferred.');
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.meta']) {
      const path = join(root, 'conversations', `${sessionId}${suffix}`);
      const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink() || stat?.isDirectory()) throw new Error('Unexpected Antigravity session storage; cleanup deferred.');
      if (stat) await rm(path);
    }
    const brain = join(root, 'brain', sessionId);
    const stat = await lstat(brain).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error('Unexpected Antigravity session storage; cleanup deferred.');
    if (stat) await rm(brain, { recursive: true });
  }
}

export async function deleteCopilotSessions({ command, environment, records }) {
  await copilotDeleteRpc(command, environment, records);
}

function runCleanupCommand(command, args, environment) {
  return new Promise((resolve, reject) => {
    const launch = localCliLaunch(command, args);
    const child = spawn(launch.command, launch.args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: launch.shell });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Provider session cleanup timed out.')); }, 8_000);
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-4000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-4000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0 || /session.*(?:not found|does not exist)/i.test(output)) resolve();
      else reject(new Error('Provider could not delete its temporary session.'));
    });
  });
}

function copilotDeleteRpc(command, environment, records) {
  return new Promise((resolve, reject) => {
    const launch = localCliLaunch(command, ['--server', '--stdio', '--no-auto-update', '--no-remote', '--no-remote-export', '--disable-builtin-mcps']);
    const child = spawn(launch.command, launch.args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: launch.shell });
    let buffer = Buffer.alloc(0);
    const pending = new Set(records.map((_, index) => index + 1));
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Copilot session cleanup timed out.')), 8_000);
    child.once('error', finish);
    child.stdin.on('error', finish);
    child.stderr.resume();
    child.once('exit', () => { if (!settled) finish(new Error('Copilot session cleanup stopped unexpectedly.')); });
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish(new Error('Invalid Copilot cleanup response.'));
      while (true) {
        const split = buffer.indexOf('\r\n\r\n');
        if (split < 0) return;
        const length = Number(buffer.subarray(0, split).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isInteger(length) || length < 0 || length > 1024 * 1024) return finish(new Error('Invalid Copilot cleanup response.'));
        if (buffer.length < split + 4 + length) return;
        let message;
        try { message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()); } catch { return finish(new Error('Invalid Copilot cleanup response.')); }
        buffer = buffer.subarray(split + 4 + length);
        if (!pending.has(message.id)) continue;
        if (message.error || message.result?.success !== true) {
          if (!/session.*(?:not found|does not exist)/i.test(String(message.result?.error || message.error?.message))) return finish(new Error('Copilot could not delete its temporary session.'));
        }
        pending.delete(message.id);
        if (!pending.size) return finish();
      }
    });
    records.forEach((record, index) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'session.delete', params: { sessionId: record.sessionId } }));
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    });
  });
}
