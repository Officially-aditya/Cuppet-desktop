import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';

const execFileAsync = promisify(execFile);
const FINAL_MARKER = 'CUPPET_OPENCODE_AUTH_SMOKE_OK';
const TOOL_MARKER = 'CUPPET_SMOKE_TOOL_OK';
const TOOL_NAME = 'cuppet_smoke_echo';
const descriptor = localCliDescriptor('opencode');

assert.ok(descriptor, 'OpenCode descriptor is missing.');
assert.equal(descriptor.transport, 'acp');
assert.equal(descriptor.mcpToolBridge, true);

const cliCommand = text(process.env.CUPPET_OPENCODE_BIN) || 'opencode';
const selectedModel = text(process.env.CUPPET_OPENCODE_SMOKE_MODEL) || 'cli-default';
const selectedEffort = text(process.env.CUPPET_OPENCODE_SMOKE_EFFORT) || null;
const projectRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-auth-smoke-'));
const manager = new ProviderRuntimeManager();
let toolCalls = 0;
let streamedText = '';

try {
  const version = await readVersion(cliCommand);
  console.log(`[authenticated-smoke] OpenCode=${version}`);
  console.log(`[authenticated-smoke] model=${safeLabel(selectedModel)} effort=${safeLabel(selectedEffort || 'provider-default')}`);

  const configuration = {
    providerID: 'opencode',
    cliCommand,
    primary: {
      providerID: 'opencode',
      modelID: selectedModel,
      ...(selectedEffort ? { variant: selectedEffort } : {}),
    },
  };
  const adapter = new AcpProviderAdapter(configuration, { descriptor });
  const managed = manager.adapterFor({
    sessionId: 'authenticated-opencode-smoke',
    projectRoot,
    adapter,
  });

  const result = await managed.stream([
    {
      role: 'user',
      content: [
        'This is an automated Cuppet integration smoke test.',
        `You must call the Cuppet tool whose base name is ${TOOL_NAME} exactly once before answering.`,
        `The provider may display that MCP tool with a cuppet-runtime_ or cuppet_runtime_ prefix; choose the tool ending in ${TOOL_NAME}.`,
        `The tool will return ${TOOL_MARKER}.`,
        `After the successful tool result, answer with exactly ${FINAL_MARKER} and nothing else.`,
        'Do not inspect files, run commands, browse, or call any other tool.',
      ].join('\n'),
    },
  ], {
    tools: [{
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: `Authenticated OpenCode smoke tool. Returns ${TOOL_MARKER}.`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }],
    executeTool: async (call) => {
      assert.equal(call?.name, TOOL_NAME, `Unexpected Cuppet tool requested: ${String(call?.name ?? '(missing)')}`);
      toolCalls += 1;
      if (toolCalls > 1) throw new Error('OpenCode called the authenticated smoke tool more than once.');
      return { success: true, output: TOOL_MARKER, paths: [], mutation: false };
    },
    onDelta: async (delta) => { streamedText += String(delta ?? ''); },
  });

  const finalText = String(result?.text || streamedText || '').trim();
  assert.equal(toolCalls, 1, 'OpenCode completed without calling the Cuppet MCP smoke tool exactly once.');
  assert.equal(finalText, FINAL_MARKER, `OpenCode returned an unexpected final marker: ${safeLabel(finalText || '(empty)')}`);

  const snapshot = manager.conversationSnapshot('authenticated-opencode-smoke');
  assert.equal(snapshot?.totalCompletedTurns, 1, 'Provider Runtime Manager did not record the authenticated turn.');
  assert.equal(snapshot?.warmRuntimeCount, 1, 'Authenticated OpenCode runtime was not retained as one managed route.');

  console.log(`[authenticated-smoke] toolCalls=${toolCalls}`);
  console.log(`[authenticated-smoke] finalMarker=${FINAL_MARKER}`);
  console.log('[authenticated-smoke] PASS: real session/prompt, model response, Cuppet MCP tool call, and final response all succeeded.');
} catch (error) {
  console.error(`[authenticated-smoke] FAIL: ${redact(error instanceof Error ? error.message : String(error))}`);
  console.error('[authenticated-smoke] Ensure `opencode auth login` is complete for the provider/model you selected. No credential should be passed to this script.');
  process.exitCode = 1;
} finally {
  await manager.close().catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
}

async function readVersion(command) {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    return safeLabel(String(stdout || stderr || 'unknown').trim().split(/\r?\n/, 1)[0] || 'unknown');
  } catch (error) {
    throw new Error(`OpenCode CLI is unavailable: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}

function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|xai)-[A-Za-z0-9._~-]{10,}\b/g, '[redacted-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/g, '[redacted-long-token]')
    .slice(0, 4_000);
}

function safeLabel(value) {
  return redact(String(value ?? '')).replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
