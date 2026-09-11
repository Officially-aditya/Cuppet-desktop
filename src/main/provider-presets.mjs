export const PROVIDER_PRESETS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    baseUrl: 'codex://app-server',
    model: 'codex-default',
    models: [],
    authType: 'chatgpt',
    authLabel: 'ChatGPT account',
    note: 'Uses your existing ChatGPT Codex subscription through the official OpenAI Codex app-server. Cuppet never reads or stores Codex OAuth credentials.',
  }),
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    baseUrl: 'cli://opencode',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'OpenCode default', description: 'Use the model/provider selected in your local OpenCode configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local OpenCode CLI',
    note: 'Uses your locally installed OpenCode CLI through ACP. Cuppet never reads or stores OpenCode provider credentials.',
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    baseUrl: 'cli://claude-code',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Claude Code default', description: 'Use the model selected by your Claude account and local Claude Code configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Claude Code',
    note: 'Uses Claude Code through the maintained Agent Client Protocol adapter for the Claude Agent SDK. Claude authentication and subscription/API billing remain owned by Claude; Cuppet supplies its own optimized tools through the shared ACP execution path.',
  }),
  'grok-build': Object.freeze({
    id: 'grok-build',
    label: 'Grok Build',
    baseUrl: 'cli://grok-build',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Grok Build default', description: 'Use the default model selected by your local Grok Build account/configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Grok Build CLI',
    note: 'Uses your locally installed and authenticated Grok Build CLI through ACP. Cuppet never reads or stores Grok credentials.',
  }),
  antigravity: Object.freeze({
    id: 'antigravity',
    label: 'Google Antigravity',
    baseUrl: 'cli://antigravity',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Antigravity default', description: 'Uses the model selected by your local Antigravity account/configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Antigravity CLI',
    note: 'Uses your locally authenticated Google Antigravity CLI. Cuppet runs the current headless transport in plan + sandbox mode so it cannot bypass Cuppet mutation permissions; this provider is analysis/planning-only until Google exposes an interceptable agent protocol.',
  }),
  'github-copilot': Object.freeze({
    id: 'github-copilot',
    label: 'GitHub Copilot',
    baseUrl: 'cli://github-copilot',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Copilot default', description: 'Uses the default model selected by your GitHub Copilot plan/configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local GitHub Copilot CLI',
    note: 'Uses the official Copilot CLI ACP server over stdio. Authentication and plan usage remain owned by GitHub Copilot; Cuppet does not copy credentials.',
  }),
  'mistral-vibe': Object.freeze({
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    baseUrl: 'cli://mistral-vibe',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Vibe default', description: 'Uses the model/profile selected in your local Vibe configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Mistral Vibe CLI',
    note: 'Uses the official Vibe ACP agent. Mistral credentials and Free/paid plan usage stay in Vibe; Cuppet does not read the stored credential.',
  }),
  kiro: Object.freeze({
    id: 'kiro',
    label: 'Kiro',
    baseUrl: 'cli://kiro',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Kiro default', description: 'Uses the active model available to your local Kiro account.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Kiro CLI',
    note: 'Uses the official `kiro-cli acp` interface as an ACP client. Authentication and Kiro plan credits remain inside Kiro.',
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-sol',
    models: Object.freeze([
      Object.freeze({ id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Latest OpenAI flagship for the hardest reasoning and coding work.' }),
      Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'GPT-5.6 flagship for complex professional work.' }),
      Object.freeze({ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced intelligence and cost.' }),
      Object.freeze({ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast, cost-efficient GPT-5.6 tier.' }),
    ]),
    authType: 'api-key',
    authLabel: 'OpenAI API key',
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
    models: Object.freeze([
      Object.freeze({ id: 'claude-fable-5', label: 'Claude Fable 5', description: 'Latest adaptive-thinking Claude for advanced agentic work.' }),
      Object.freeze({ id: 'claude-opus-5', label: 'Claude Opus 5', description: 'High-capability Claude tier for difficult long-running work.' }),
      Object.freeze({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Balanced Claude model for coding and everyday agentic work.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Anthropic API key',
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    models: Object.freeze([
      Object.freeze({ id: 'qwen3.8-max', label: 'Qwen3.8 Max', description: 'Latest flagship Qwen3.8 model for coding, reasoning, and agents.' }),
      Object.freeze({ id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', description: 'Fast Qwen3.8 model with long-context agentic capability.' }),
      Object.freeze({ id: 'qwen3.8-27b', label: 'Qwen3.8 27B', description: 'Smaller Qwen3.8 family model for lower-cost workloads.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Alibaba Cloud Model Studio API key',
    note: 'Uses Alibaba Cloud Model Studio’s supported international DashScope endpoint so no workspace ID is required.',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    models: Object.freeze([
      Object.freeze({ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Latest production DeepSeek V4 model for advanced agents.' }),
      Object.freeze({ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Faster V4 tier optimized for coding and agent workflows.' }),
    ]),
    authType: 'api-key',
    authLabel: 'DeepSeek API key',
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
    models: Object.freeze([
      Object.freeze({ id: 'kimi-k3', label: 'Kimi K3', description: 'Current Kimi flagship for long-context reasoning, coding, and agentic work.' }),
      Object.freeze({ id: 'kimi-k2.6', label: 'Kimi K2.6', description: 'Previous Kimi flagship for agentic coding, reasoning, and multimodal work.' }),
      Object.freeze({ id: 'kimi-k2.5', label: 'Kimi K2.5', description: 'Earlier Kimi multimodal flagship, retained as an available fallback.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Kimi API key',
    note: 'Uses the standard Kimi Open Platform API. Kimi Code membership uses a separate endpoint and quota.',
  }),
  zai: Object.freeze({
    id: 'zai',
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.3',
    models: Object.freeze([
      Object.freeze({ id: 'glm-5.3', label: 'GLM-5.3', description: 'Current Z.ai flagship for long-horizon agentic engineering and coding work.' }),
      Object.freeze({ id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', description: 'Faster GLM-5.3 family model for lower-latency workloads.' }),
      Object.freeze({ id: 'glm-5.1', label: 'GLM-5.1', description: 'Previous GLM-5.x flagship for agentic engineering.' }),
      Object.freeze({ id: 'glm-5-turbo', label: 'GLM-5 Turbo', description: 'Fast GLM-5 tier optimized for agent execution continuity.' }),
      Object.freeze({ id: 'glm-5', label: 'GLM-5', description: 'GLM-5 family model for coding, planning, and debugging.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Z.ai API key',
    note: 'Uses Z.ai’s general API endpoint. GLM Coding Plan keys use a separate coding-only endpoint and are not interchangeable.',
  }),
  google: Object.freeze({
    id: 'google',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    models: Object.freeze([
      Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Latest stable Gemini model for long-horizon coding and agents.' }),
      Object.freeze({ id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', description: 'Latest Pro-tier Gemini model currently exposed by the API.' }),
      Object.freeze({ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', description: 'Current low-latency, cost-efficient Gemini tier.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Gemini API key',
  }),
  meta: Object.freeze({
    id: 'meta',
    label: 'Meta',
    baseUrl: 'https://api.meta.ai/v1',
    model: 'muse-spark-1.3',
    models: Object.freeze([
      Object.freeze({ id: 'muse-spark-1.3', label: 'Muse Spark 1.3', description: 'Latest Meta coding and agentic model.' }),
    ]),
    authType: 'api-key',
    authLabel: 'Meta Model API key',
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    models: Object.freeze([
      Object.freeze({ id: 'openrouter/auto', label: 'OpenRouter Auto', description: 'Lets OpenRouter route each request to a current compatible model.' }),
    ]),
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
  return Object.values(PROVIDER_PRESETS).map(({ id, label, baseUrl, model, models = [], authType = 'api-key', authLabel, note = '' }) => ({
    id,
    label,
    baseUrl,
    model,
    models: models.map((item) => ({ ...item })),
    authType,
    authLabel,
    note,
  }));
}
