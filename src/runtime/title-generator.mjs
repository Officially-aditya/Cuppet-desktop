import { isLocalCliProvider } from './local-cli-descriptors.mjs';
import { providerRequest } from './provider-policy.mjs';

const TITLE_TIMEOUT_MS = 15_000;
const ACCOUNT_PROVIDERS = new Set(['codex']);

export async function generateChatTitle({ providerFactory, providerConfig, userText, timeoutMs = TITLE_TIMEOUT_MS }) {
  if (typeof providerFactory !== 'function') return null;
  const text = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2400);
  if (!text) return null;
  const configuration = secondaryProviderConfiguration(providerConfig);
  if (!configuration) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || TITLE_TIMEOUT_MS));
  timer.unref?.();
  let output = '';
  try {
    const provider = providerFactory(configuration);
    await provider.stream([
      {
        role: 'system',
        content: 'Create a concise chat title from the user request. Return only the title: 2-6 words, plain text, no quotes, no markdown, no trailing punctuation. Do not use tools.',
      },
      { role: 'user', content: text },
    ], {
      signal: controller.signal,
      tools: [],
      onDelta: async (delta) => { output += String(delta ?? ''); },
    });
    if (controller.signal.aborted) return null;
    return sanitizeChatTitle(output);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function secondaryProviderConfiguration(configuration = {}) {
  const source = record(configuration);
  const secondary = record(source.secondary);
  const providerID = text(secondary.providerID) || text(source.providerID) || text(source.primary?.providerID);
  if (!providerID) return null;

  if (ACCOUNT_PROVIDERS.has(providerID.toLowerCase()) || isLocalCliProvider(providerID)) {
    const modelID = text(secondary.modelID) || text(source.backgroundModel) || text(source.model) || text(source.primary?.modelID);
    return {
      ...source,
      providerID,
      ...(modelID ? { model: modelID, modelID } : {}),
      primary: modelID ? { providerID, modelID, ...(text(secondary.variant) ? { variant: text(secondary.variant) } : {}) } : source.primary,
      primaryEffort: text(secondary.variant) || text(source.secondaryEffort) || text(source.primaryEffort),
    };
  }

  try { return providerRequest(source, 'secondary'); }
  catch { return null; }
}

export function sanitizeChatTitle(value) {
  let title = String(value ?? '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split(/\r?\n/, 1)[0]
    .replace(/^["'`*_#\-\s]+|["'`*_#\-\s]+$/g, '')
    .replace(/^\s*(?:title|chat title)\s*:\s*/i, '')
    .replace(/[.!?;:,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  if (title.length > 64) {
    title = title.slice(0, 64).replace(/\s+\S*$/, '').trim() || title.slice(0, 64).trim();
  }
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 10) return null;
  return title;
}

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
