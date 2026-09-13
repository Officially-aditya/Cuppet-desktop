import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { assertLocalProviderVersionSupported } from '../src/runtime/providers/version-policy.mjs';

const execFileAsync = promisify(execFile);
const TURN2_FINAL_MARKER = 'CUPPET_OPENCODE_AUTH_SMOKE_TURN2_OK';
const TURN2_TOOL_MARKER = 'CUPPET_SMOKE_TOOL_TURN2_OK';
const TOOL_NAME = 'cuppet_smoke_echo';
const descriptor = localCliDescriptor('opencode');

assert.ok(descriptor, 'OpenCode descriptor is missing.');
assert.equal(descriptor.transport, 'acp');
assert.equal(descriptor.mcpToolBridge, true);
assert.ok(Array.isArray(descriptor.requiredSessionSettings) && descriptor.requiredSessionSettings.length > 0, 'OpenCode execution guard session setting is missing.');

const cliCommand = text(process.env.CUPPET_OPENCODE_BIN) || 'opencode';
const selectedModel = text(process.env.CUPPET_OPENCODE_SMOKE_MODEL) || 'cli-default';
const selectedEffort = text(process.env.CUPPET_OPENCODE_SMOKE_EFFORT) || null;
const secondModel = text(process.env.CUPPET_OPENCODE_SMOKE_MODEL_2) || selectedModel;
const secondEffort = text(process.env.CUPPET_OPENCODE_SMOKE_EFFORT_2) || selectedEffort;
const replayNonce = randomBytes(12).toString('hex');
const turn1FinalMarker = `CUPPET_OPENCODE_AUTH_SMOKE_TURN1_${replayNonce}`;
const projectRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-auth-smoke-'));
const manager = new ProviderRuntimeManager();
let toolCalls = 0;

try {
  const version = await readVersion(cliCommand);
  assertLocalProviderVersionSupported('opencode', version.label, 'OpenCode');
  console.log(`[authenticated-smoke] OpenCode=${version.label}`);
  console.log(`[authenticated-smoke] turn1 model=${safeLabel(selectedModel)} effort=${safeLabel(selectedEffort || 'provider-default')}`);
  console.log(`[authenticated-smoke] turn2 model=${safeLabel(secondModel)} effort=${safeLabel(secondEffort || 'provider-default')}`);

  const turn1User = [
    'This is turn 1 of an automated Cuppet integration smoke test.',
    `You must call the Cuppet tool whose base name is ${TOOL_NAME} exactly once before answering.`,
    `The provider may display that MCP tool with a cuppet-runtime_ or cuppet_runtime_ prefix; choose the tool ending in ${TOOL_NAME}.`,
    'Call it with an empty object. The tool will return a unique marker that is not present in this prompt.',
    'After the successful tool result, answer with exactly the marker returned by the tool and nothing else.',
    'Do not inspect files, run commands, browse, use native OpenCode tools, or call any other tool.',
  ].join('\n');
  const turn1 = await managedAdapter(selectedModel, selectedEffort).stream([
    { role: 'user', content: turn1User },
  ], turnOptions(1, turn1FinalMarker));
  const turn1Text = String(turn1?.text || '').trim();
  assert.equal(toolCalls, 1, 'OpenCode turn 1 did not call the Cuppet MCP smoke tool exactly once.');
  assert.equal(turn1Text, turn1FinalMarker, `OpenCode turn 1 returned an unexpected marker: ${safeLabel(turn1Text || '(empty)')}`);

  const turn2User = [
    'This is turn 2 of the Cuppet integration smoke test.',
    'A fresh provider logical session should have received Cuppet-owned replay of the prior conversation.',
    `Call the Cuppet tool whose base name is ${TOOL_NAME} exactly once.`,
    'Pass the exact previous assistant response in the previousMarker argument. Do not invent or derive a value from this prompt.',
    `After the tool succeeds, answer with exactly ${TURN2_FINAL_MARKER} and nothing else.`,
    'Do not inspect files, run commands, browse, use native OpenCode tools, or call any other tool.',
  ].join('\n');
  const turn2 = await managedAdapter(secondModel, secondEffort).stream([
    { role: 'user', content: turn1User },
    { role: 'assistant', content: turn1Text },
    { role: 'user', content: turn2User },
  ], turnOptions(2, TURN2_TOOL_MARKER));
  const turn2Text = String(turn2?.text || '').trim();
  assert.equal(toolCalls, 2, 'OpenCode did not call the fresh Cuppet MCP smoke tool exactly once on each authenticated turn.');
  assert.equal(turn2Text, TURN2_FINAL_MARKER, `OpenCode turn 2 returned an unexpected marker: ${safeLabel(turn2Text || '(empty)')}`);

  const snapshot = manager.conversationSnapshot('authenticated-opencode-smoke');
  assert.equal(snapshot?.totalCompletedTurns, 2, 'Provider Runtime Manager did not record both authenticated turns.');
  assert.equal(snapshot?.completedTurns, 2, 'OpenCode warm route did not complete both turns.');
  assert.equal(snapshot?.warmRuntimeCount, 1, 'Authenticated OpenCode should retain exactly one warm process route across both logical sessions.');

  console.log(`[authenticated-smoke] toolCalls=${toolCalls}`);
  console.log(`[authenticated-smoke] replayMarkerVerified=${turn1FinalMarker}`);
  console.log(`[authenticated-smoke] finalMarker=${TURN2_FINAL_MARKER}`);
  console.log('[authenticated-smoke] PASS: two real authenticated prompts, fresh ACP logical-session rotation, Cuppet replay, fresh MCP tool authority, and final responses all succeeded in one warm OpenCode process.');
} catch (error) {
  console.error(`[authenticated-smoke] FAIL: ${redact(error instanceof Error ? error.message : String(error))}`);
  console.error('[authenticated-smoke] Ensure `opencode auth login` is complete for the provider/model you selected and OpenCode is current. No credential should be passed to this script.');
  process.exitCode = 1;
} finally {
  await manager.close().catch(() => undefined);
  await rm(projectRoot, { recursive: true, force: true });
}

function managedAdapter(model, effort) {
  const configuration = {
    providerID: 'opencode',
    cliCommand,
    primary: {
      providerID: 'opencode',
      modelID: model,
      ...(effort ? { variant: effort } : {}),
    },
  };
  const adapter = new AcpProviderAdapter(configuration, { descriptor });
  return manager.adapterFor({
    sessionId: 'authenticated-opencode-smoke',
    projectRoot,
    adapter,
  });
}

function turnOptions(turn, toolMarker) {
  return {
    tools: [{
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: `Authenticated OpenCode smoke tool for turn ${turn}.`,
        parameters: {
          type: 'object',
          properties: { previousMarker: { type: 'string' } },
          additionalProperties: false,
        },
      },
    }],
    executeTool: async (call) => {
      assert.equal(call?.name, TOOL_NAME, `Unexpected Cuppet tool requested: ${String(call?.name ?? '(missing)')}`);
      toolCalls += 1;
      assert.equal(toolCalls, turn, `OpenCode called the authenticated smoke tool out of sequence on turn ${turn}.`);
      const args = parseArguments(call?.arguments);
      if (turn === 1) {
        assert.equal(text(args.previousMarker), '', 'Turn 1 unexpectedly supplied a previousMarker.');
      } else {
        assert.equal(text(args.previousMarker), turn1FinalMarker, 'Turn 2 did not recover the exact prior assistant marker from Cuppet replay.');
      }
      return { success: true, output: toolMarker, paths: [], mutation: false };
    },
  };
}

async function readVersion(command) {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: process.env,
    });
    return { label: safeLabel(String(stdout || stderr || 'unknown').trim().split(/\r?\n/, 1)[0] || 'unknown') };
  } catch (error) {
    throw new Error(`OpenCode CLI is unavailable: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('OpenCode supplied invalid JSON arguments to the Cuppet smoke tool.');
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
