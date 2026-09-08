import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from './service.mjs';
import { RemoteManager } from './remote/manager.mjs';
import { normalizeProviderConfiguration } from './provider-policy.mjs';
import { buildRuntimeDoctor, buildRuntimeStatus } from './diagnostics.mjs';

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
    case 'status': return buildRuntimeStatus({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.8.0-alpha.1' });
    case 'doctor': return buildRuntimeDoctor({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.8.0-alpha.1' });
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
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = normalizeProviderConfiguration({
    ...source,
    ...(typeof source.apiKey === 'string' ? { apiKey: source.apiKey.slice(0, 8192) } : {}),
    ...(typeof source.baseUrl === 'string' ? { baseUrl: source.baseUrl.slice(0, 500) } : {}),
    ...(Array.isArray(source.models) ? { models: source.models.slice(0, 512) } : {}),
    ...(Array.isArray(source.integrations) ? { integrations: source.integrations.slice(0, 256) } : {}),
  });
  return normalized;
}
