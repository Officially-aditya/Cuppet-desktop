import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localCliDescriptor } from './local-cli-descriptors.mjs';

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

export class AntigravityHeadlessProvider {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = configuration;
    this.#descriptor = localCliDescriptor('antigravity');
  }

  async stream(messages, { signal, onDelta = async () => {}, projectRoot = null } = {}) {
    if (signal?.aborted) throw abortError();
    const command = text(this.#configuration.cliCommand) || text(process.env[this.#descriptor.envOverride]) || this.#descriptor.command;
    const prompt = antigravityPrompt(messages);
    const cwd = projectRoot ? resolve(projectRoot) : tmpdir();
    const baseArgs = Array.isArray(this.#configuration.cliArgs) && this.#configuration.cliArgs.length
      ? this.#configuration.cliArgs.map((value) => String(value))
      : [...this.#descriptor.args];
    const args = [...baseArgs, '--mode=plan', '--sandbox', '--output-format', 'stream-json', '--print-timeout', '30m', '-p', prompt];
    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    } catch (error) {
      throw launchError(this.#descriptor, error);
    }

    let output = '';
    let finalResponse = '';
    let usage = null;
    let stderr = '';
    let settled = false;
    let abortListener;
    const lines = createInterface({ input: child.stdout });
    const completion = new Promise((resolveRun, rejectRun) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        rejectRun(new Error('Antigravity headless request timed out.'));
      }, PROMPT_TIMEOUT_MS);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      child.once('error', (error) => finish(rejectRun, launchError(this.#descriptor, error)));
      child.once('exit', (code, exitSignal) => {
        if (signal?.aborted) { finish(rejectRun, abortError()); return; }
        if (code === 0) finish(resolveRun, undefined);
        else finish(rejectRun, new Error(`Google Antigravity exited${code !== null ? ` with code ${code}` : ''}${exitSignal ? ` (${exitSignal})` : ''}.${stderr.trim() ? ` ${stderr.trim().slice(-1200)}` : ''}`));
      });
    });

    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.event === 'step_update' && event?.step_update?.step_type === 'agent_response') {
        const delta = typeof event.step_update.text_delta === 'string' ? event.step_update.text_delta : '';
        if (delta) { output += delta; void onDelta(delta); }
      }
      if (event?.event === 'result') {
        finalResponse = typeof event.result?.response === 'string' ? event.result.response : finalResponse;
        usage = normalizeUsage(event.result?.usage);
        if (event.result?.status && event.result.status !== 'SUCCESS') stderr = `${stderr}\nAntigravity status: ${event.result.status}`.trim();
      }
    });

    abortListener = () => { try { child.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      await completion;
      if (signal?.aborted) throw abortError();
      const textOutput = output || finalResponse;
      if (!textOutput.trim()) throw new Error(`Google Antigravity returned no response.${stderr.trim() ? ` ${stderr.trim().slice(-1200)}` : ''}`);
      if (!output && finalResponse) await onDelta(finalResponse);
      return { text: textOutput, toolCalls: [], usage };
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      lines.close();
      try { child.kill(); } catch {}
    }
  }
}

function antigravityPrompt(messages) {
  const safety = [
    '[CUPPET ANTIGRAVITY BRIDGE]',
    'You are running through Google Antigravity headless PLAN mode inside Cuppet.',
    'Direct file writes, shell execution, browser actions, and other mutations are intentionally not delegated through this transport because Cuppet cannot intercept Antigravity headless permission prompts yet.',
    'Use project read access for analysis. Never claim that you edited files, ran commands, tests, or changed the workspace.',
    'For change requests, return a precise implementation plan and exact suggested code/diff where useful so the user can act on it safely.',
    '[/CUPPET ANTIGRAVITY BRIDGE]',
  ].join('\n');
  const conversation = (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role ?? 'user').toUpperCase();
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    return `[${role}]\n${content}`;
  }).join('\n\n');
  const value = `${safety}\n\n${conversation}`;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= MAX_PROMPT_BYTES ? value : `${safety}\n\n${bytes.subarray(bytes.length - MAX_PROMPT_BYTES).toString('utf8')}`;
}

function normalizeUsage(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!Object.keys(source).length) return null;
  return {
    inputTokens: number(source.input_tokens ?? source.inputTokens),
    outputTokens: number(source.output_tokens ?? source.outputTokens),
    totalTokens: number(source.total_tokens ?? source.totalTokens),
    cachedInputTokens: number(source.cache_read_tokens ?? source.cached_input_tokens ?? source.cachedInputTokens),
    reasoningTokens: number(source.thinking_tokens ?? source.reasoning_tokens ?? source.reasoningTokens),
  };
}
function launchError(descriptor, error) { return error?.code === 'ENOENT' ? new Error(`${descriptor.label} CLI was not found. ${descriptor.loginHint}`) : error instanceof Error ? error : new Error(String(error)); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
