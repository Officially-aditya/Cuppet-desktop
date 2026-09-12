import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from '../src/main/runtime-client.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appPath = appArgument(process.argv.slice(2));
const model = text(process.env.CUPPET_OPENCODE_SMOKE_MODEL) || 'cli-default';
const effort = text(process.env.CUPPET_OPENCODE_SMOKE_EFFORT);
const marker = `CUPPET_OPENCODE_DESKTOP_PATH_OK_${Date.now().toString(36)}`;
const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-opencode-desktop-path-'));

const launch = appPath
  ? packagedLaunch(appPath)
  : {
      mode: 'source-runtime',
      execPath: process.execPath,
      entry: join(root, 'src', 'runtime', 'main.mjs'),
      environment: {},
    };

await access(launch.execPath);
await access(launch.entry);

const client = new RuntimeClient({
  execPath: launch.execPath,
  entry: launch.entry,
  dataDir,
  environment: {
    ...launch.environment,
    CUPPET_NONINTERACTIVE: '1',
  },
  startupTimeoutMs: 20_000,
});

const runtimeErrors = [];
const stderrChunks = [];
client.on('event', (event) => {
  if (event?.type === 'runtime.error') runtimeErrors.push(redactObject(event));
});
client.on('stderr', (chunk) => {
  stderrChunks.push(redact(String(chunk)));
  if (stderrChunks.length > 24) stderrChunks.shift();
});

try {
  console.log(`[desktop-smoke] mode=${launch.mode}`);
  if (appPath) console.log(`[desktop-smoke] app=${appPath}`);
  console.log(`[desktop-smoke] model=${model} effort=${effort || 'provider-default'}`);

  await client.start();
  const session = await client.request('session.create', { projectId: null });
  assert.ok(session?.id, 'desktop runtime did not create a session');

  const finished = waitForEvent(client, (event) => event?.type === 'run.finished' && event?.sessionId === session.id, 150_000);
  const accepted = await client.request('session.send', {
    sessionId: session.id,
    text: `This is an authenticated Cuppet desktop-path acceptance check. Do not call tools. Reply with exactly ${marker} and nothing else.`,
    provider: openCodeProvider(model, effort),
  }, 30_000);
  assert.equal(accepted?.accepted, true, 'desktop runtime did not accept the OpenCode turn');
  await finished;

  const finalSession = await client.request('session.get', { sessionId: session.id });
  const assistant = [...(finalSession?.messages ?? [])].reverse().find((message) => message?.role === 'assistant');
  if (assistant?.status !== 'complete' || text(assistant?.content) !== marker) {
    const failure = runtimeErrors.at(-1);
    const diagnostic = failure?.providerError?.diagnostic || failure?.message || '(no structured runtime diagnostic)';
    console.error(`[desktop-smoke] assistantStatus=${assistant?.status ?? '(missing)'}`);
    console.error(`[desktop-smoke] assistantContent=${redact(String(assistant?.content ?? '')).slice(0, 1200) || '(empty)'}`);
    console.error(`[desktop-smoke] providerCategory=${failure?.providerError?.category ?? '(unknown)'}`);
    console.error(`[desktop-smoke] diagnostic=${redact(String(diagnostic)).slice(0, 2400)}`);
    if (stderrChunks.length) console.error(`[desktop-smoke] runtimeStderr=${stderrChunks.join('').slice(-2400)}`);
    process.exitCode = 1;
  } else {
    console.log(`[desktop-smoke] finalMarker=${marker}`);
    console.log('[desktop-smoke] PASS: Cuppet RuntimeService -> production tool runtime -> OpenCode ACP -> packaged/source MCP bridge -> authenticated model response succeeded.');
  }
} catch (error) {
  console.error(`[desktop-smoke] FAIL: ${redact(error instanceof Error ? error.stack || error.message : String(error)).slice(0, 4000)}`);
  const failure = runtimeErrors.at(-1);
  if (failure) console.error(`[desktop-smoke] runtimeError=${redact(JSON.stringify(failure)).slice(0, 4000)}`);
  if (stderrChunks.length) console.error(`[desktop-smoke] runtimeStderr=${stderrChunks.join('').slice(-2400)}`);
  process.exitCode = 1;
} finally {
  await client.stop().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

function openCodeProvider(modelID, variant) {
  const selection = { providerID: 'opencode', modelID, ...(variant ? { variant } : {}) };
  return {
    providerID: 'opencode',
    integrations: [{ id: 'opencode', name: 'OpenCode' }],
    models: [{
      providerID: 'opencode',
      modelID,
      name: modelID === 'cli-default' ? 'OpenCode CLI default' : modelID,
      context: 128_000,
      outputLimit: 16_384,
      capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
      variants: variant ? [{ id: variant }] : [],
    }],
    primary: selection,
    secondary: selection,
    model: modelID,
    backgroundModel: modelID,
  };
}

function packagedLaunch(app) {
  if (process.platform !== 'darwin') throw new Error('--app currently expects a macOS .app bundle');
  const resolved = resolve(app.replace(/^~(?=\/)/, homedir()));
  if (!resolved.endsWith('.app')) throw new Error(`Expected a .app bundle, received ${resolved}`);
  const resources = join(resolved, 'Contents', 'Resources');
  const executable = join(resolved, 'Contents', 'MacOS', 'cuppet');
  return {
    mode: `packaged-${basename(resolved)}`,
    execPath: executable,
    entry: join(resources, 'app.asar', 'src', 'runtime', 'main.mjs'),
    environment: { CUPPET_RESOURCES_PATH: resources },
  };
}

function appArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--app') return text(args[index + 1]);
    if (value.startsWith('--app=')) return text(value.slice('--app='.length));
  }
  return text(process.env.CUPPET_DESKTOP_APP);
}

function waitForEvent(client, predicate, timeoutMs) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectEvent(new Error(`desktop runtime event timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (event) => {
      if (!predicate(event)) return;
      cleanup();
      resolveEvent(event);
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off('event', onEvent);
    };
    client.on('event', onEvent);
  });
}

function redactObject(value) {
  try { return JSON.parse(redact(JSON.stringify(value))); }
  catch { return { message: redact(String(value ?? '')) }; }
}

function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|xai)-[A-Za-z0-9._~-]{12,}\b/g, '[redacted-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted-token]');
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
