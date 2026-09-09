export const PROVIDER_PRESETS = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    authLabel: 'OpenAI API key',
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
    authLabel: 'Anthropic API key',
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    authLabel: 'Alibaba Cloud Model Studio API key',
    note: 'Uses Alibaba Cloud Model Studio’s supported international DashScope endpoint so no workspace ID is required.',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    authLabel: 'DeepSeek API key',
  }),
  google: Object.freeze({
    id: 'google',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    authLabel: 'Gemini API key',
  }),
  meta: Object.freeze({
    id: 'meta',
    label: 'Meta',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    authLabel: 'Meta Model API key',
  }),
});

export const DEFAULT_PROVIDER_PRESET_ID = 'openai';

export function providerPreset(providerID) {
  const key = String(providerID ?? '').trim().toLowerCase();
  return PROVIDER_PRESETS[key] ?? null;
}

export function providerPresetList() {
  return Object.values(PROVIDER_PRESETS).map(({ id, label, baseUrl, model, authLabel, note = '' }) => ({
    id,
    label,
    baseUrl,
    model,
    authLabel,
    note,
  }));
}
