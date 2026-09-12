const DESCRIPTORS = Object.freeze({
  opencode: descriptor({
    id: 'opencode', label: 'OpenCode', transport: 'opencode-http', command: 'opencode', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use.',
  }),
  'claude-code': descriptor({
    id: 'claude-code', label: 'Claude Code', transport: 'acp', command: 'claude-agent-acp', args: [], versionArgs: ['--cli', '--version'], envOverride: 'CUPPET_CLAUDE_ACP_BIN',
    loginHint: 'Run `claude-agent-acp --cli auth login` in Terminal and complete Claude sign-in, then retry.',
    // claude-agent-acp forwards these ACP session extensions into the Claude Agent SDK.
    // Remove Claude's built-in coding tools and filesystem settings sources so project/user
    // MCP servers, hooks, plugins and tool settings cannot become a parallel execution path.
    // Authentication remains Claude-owned and is resolved independently by the Agent SDK.
    sessionMeta: {
      disableBuiltInTools: true,
      claudeCode: { options: { settingSources: [] } },
    },
  }),
  'grok-build': descriptor({
    id: 'grok-build', label: 'Grok Build', transport: 'acp', command: 'grok', args: ['--no-auto-update', 'agent', 'stdio'], versionArgs: ['version'], envOverride: 'CUPPET_GROK_BIN',
    loginHint: 'Run `grok login` in Terminal once, then retry.',
    authentication: {
      methods: [
        { id: 'xai.api_key', requiresEnv: 'XAI_API_KEY' },
        { id: 'cached_token' },
      ],
      meta: { headless: true },
    },
  }),
  'github-copilot': descriptor({
    id: 'github-copilot', label: 'GitHub Copilot', transport: 'acp', command: 'copilot', args: ['--acp', '--stdio', '--no-auto-update', '--no-remote', '--disable-builtin-mcps'], versionArgs: ['--version'], envOverride: 'CUPPET_COPILOT_BIN',
    loginHint: 'Run `copilot` in Terminal once and complete GitHub sign-in, then retry.',
  }),
  'mistral-vibe': descriptor({
    id: 'mistral-vibe', label: 'Mistral Vibe', transport: 'acp', command: 'vibe-acp', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_VIBE_BIN',
    loginHint: 'Run `vibe --setup` in Terminal once and complete Mistral sign-in/setup, then retry.',
  }),
  kiro: descriptor({
    id: 'kiro', label: 'Kiro', transport: 'acp', command: 'kiro-cli', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_KIRO_BIN',
    loginHint: 'Run `kiro-cli` in Terminal once and complete sign-in, then retry.',
    // Kiro's ACP implementation currently names the PromptRequest content array `content`
    // instead of the standard `prompt`. Keep this as driver metadata, never a transport-core ID check.
    promptParameter: 'content',
  }),
  antigravity: descriptor({
    id: 'antigravity', label: 'Google Antigravity', transport: 'managed-acp', command: 'agy', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_ANTIGRAVITY_BIN',
    loginHint: 'Complete Google Antigravity sign-in when Cuppet opens the authentication flow, then retry.',
  }),
});

export function localCliDescriptor(value) {
  const item = DESCRIPTORS[String(value ?? '').trim().toLowerCase()];
  return item ? cloneDescriptor(item) : null;
}

export function isLocalCliProvider(value) { return Boolean(localCliDescriptor(value)); }
export function localCliProviderIDs() { return Object.keys(DESCRIPTORS); }

function descriptor(value) {
  const copy = {
    ...value,
    args: Object.freeze([...value.args]),
    versionArgs: Object.freeze([...value.versionArgs]),
    ...(value.sessionMeta ? { sessionMeta: freezeValue(cloneValue(value.sessionMeta)) } : {}),
    ...(value.authentication ? { authentication: freezeValue(cloneValue(value.authentication)) } : {}),
    ...(value.clientCapabilities ? { clientCapabilities: freezeValue(cloneValue(value.clientCapabilities)) } : {}),
  };
  return Object.freeze(copy);
}
function cloneDescriptor(item) {
  return {
    ...item,
    args: [...item.args],
    versionArgs: [...item.versionArgs],
    ...(item.sessionMeta ? { sessionMeta: cloneValue(item.sessionMeta) } : {}),
    ...(item.authentication ? { authentication: cloneValue(item.authentication) } : {}),
    ...(item.clientCapabilities ? { clientCapabilities: cloneValue(item.clientCapabilities) } : {}),
  };
}
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}
function freezeValue(value) {
  if (!value || typeof value !== 'object') return value;
  for (const item of Object.values(value)) freezeValue(item);
  return Object.freeze(value);
}
