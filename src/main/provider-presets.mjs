export const PROVIDER_PRESETS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    baseUrl: 'codex://app-server',
    model: 'codex-default',
    authType: 'chatgpt',
    authLabel: 'ChatGPT account',
    note: 'Uses your existing ChatGPT Codex subscription through the official OpenAI Codex app-server. Cuppet never reads or stores Codex OAuth credentials.',
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    authType: 'api-key',
    authLabel: 'OpenAI API key',
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
    authType: 'api-key',
    authLabel: 'Anthropic API key',
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    authType: 'api-key',
    authLabel: 'Alibaba Cloud Model Studio API key',
    note: 'Uses Alibaba Cloud Model Studio’s supported international DashScope endpoint so no workspace ID is required.',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    authType: 'api-key',
    authLabel: 'DeepSeek API key',
  }),
  google: Object.freeze({
    id: 'google',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    authType: 'api-key',
    authLabel: 'Gemini API key',
  }),
  meta: Object.freeze({
    id: 'meta',
    label: 'Meta',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    authType: 'api-key',
    authLabel: 'Meta Model API key',
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    authType: 'api-key',
    authLabel: 'OpenRouter API key',
    note: 'Uses OpenRouter Auto so model routing stays current without another model setting.',
  }),
});

export const DEFAULT_PROVIDER_PRESET_ID = 'openai';

export function providerPreset(providerID) {
  const key = String(providerID ?? '').trim().toLowerCase();
  return PROVIDER_PRESETS[key] ?? null;
}

export function providerPresetList() {
  return Object.values(PROVIDER_PRESETS).map(({ id, label, baseUrl, model, authType = 'api-key', authLabel, note = '' }) => ({
    id,
    label,
    baseUrl,
    model,
    authType,
    authLabel,
    note,
  }));
}
