import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from './service.mjs';
import { RemoteManager } from './remote/manager.mjs';

const dataDir = process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop');
const databasePath = join(dataDir, 'conversations.sqlite3');

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let remote;
const emit = (event) => {
  write({ kind: 'event', event });
  remote?.handleRuntimeEvent(event);
};
const service = new RuntimeService({ databasePath, dataDir, emit });
remote = new RemoteManager({ dataDir, call: (method, params) => service.handle(method, params), emit });

async function handle(method, params = {}) {
  switch (method) {
    case 'remote.status': return remote.status();
    case 'remote.start': return remote.start({ ...params, provider: boundedProvider(params.provider) });
    case 'remote.stop': return remote.stop();
    case 'remote.invite': return remote.createInvite({ role: params.role === 'viewer' ? 'viewer' : 'trusted', ...(Number.isFinite(params.ttlMs) ? { ttlMs: Math.max(1000, Math.min(Math.trunc(params.ttlMs), 10 * 60_000)) } : {}) });
    case 'remote.devices': return remote.devices();
    case 'remote.revoke': return remote.revoke(String(params.deviceId ?? '').slice(0, 128));
    case 'remote.provider-config': return remote.setProviderConfig(boundedProvider(params.provider));
    default: return service.handle(method, params);
  }
}

write({ kind: 'event', event: { type: 'runtime.ready', databasePath } });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid runtime request');
  } catch (error) {
    write({ kind: 'protocol-error', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    const result = await handle(request.method, request.params ?? {});
    write({ kind: 'response', id: request.id, ok: true, result });
  } catch (error) {
    write({ kind: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

let closing;
async function shutdown() {
  if (closing) return closing;
  closing = remote.close().catch(() => undefined).then(() => service.close()).catch(() => undefined).finally(() => process.exit(0));
  return closing;
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.stdin.on('end', () => void shutdown());

function boundedProvider(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl.slice(0, 500) } : {}),
    ...(typeof record.model === 'string' ? { model: record.model.slice(0, 240) } : {}),
    ...(typeof record.backgroundModel === 'string' ? { backgroundModel: record.backgroundModel.slice(0, 240) } : {}),
    ...(typeof record.apiKey === 'string' ? { apiKey: record.apiKey.slice(0, 8192) } : {}),
    ...(Number.isFinite(record.contextWindow) ? { contextWindow: Math.max(4096, Math.min(Math.trunc(record.contextWindow), 2_000_000)) } : {}),
  };
}
