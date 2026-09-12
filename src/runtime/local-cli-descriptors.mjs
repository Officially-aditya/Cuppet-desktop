const DESCRIPTORS = Object.freeze({
  opencode: descriptor({
    id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use, then retry.',
    mcpToolBridge: true,
    // OpenCode owns model/provider credentials, but Cuppet owns execution. Keep
    // the official ACP process isolated from OpenCode's built-in execution tools;
    // session-scoped Cuppet tools arrive through ACP mcpServers instead.
    environment: openCodeAcpEnvironment,
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
    // Copilot ACP can frame ordinary assistant text as extremely small chunks with
    // transport whitespace around each fragment. Reassemble only those boundary
    // artifacts; the shared ACP runtime remains provider-agnostic.
    textStream: { framing: 'tokenized-whitespace' },
    // Copilot CLI 1.0.84-1 can resolve session/prompt with end_turn while an attached
    // async shell is still running, then autonomously emit more tool calls/text 12+
    // seconds later. Keep this provider quirk declarative instead of hard-coding
    // Copilot identity in the shared ACP transport.
    turnCompletion: {
      afterEndTurn: {
        toolInputModes: ['async'],
        firstActivityWaitMs: 20_000,
        toolActivityWaitMs: 20_000,
        quietPeriodMs: 1_500,
        maxWaitMs: 120_000,
      },
    },
  }),
  'mistral-vibe': descriptor({
    id: 'mistral-vibe', label: 'Mistral Vibe', transport: 'acp', command: 'vibe-acp', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_VIBE_BIN',
    loginHint: 'Run `vibe --setup` in Terminal once and complete Mistral sign-in/setup, then retry.',
  }),
  kiro: descriptor({
    id: 'kiro', label: 'Kiro', transport: 'acp', command: 'kiro-cli', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_KIRO_BIN',
    loginHint: 'Run `kiro-cli` in Terminal once and complete sign-in, then retry.',
    // Kiro follows the standard ACP PromptRequest `prompt` field. Do not override
    // the shared protocol shape here; older documentation used `content`, but the
    // live agent rejects/hangs on that legacy field.
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
    ...(value.textStream ? { textStream: freezeValue(cloneValue(value.textStream)) } : {}),
    ...(value.turnCompletion ? { turnCompletion: freezeValue(cloneValue(value.turnCompletion)) } : {}),
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
    ...(item.textStream ? { textStream: cloneValue(item.textStream) } : {}),
    ...(item.turnCompletion ? { turnCompletion: cloneValue(item.turnCompletion) } : {}),
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

function openCodeAcpEnvironment(inherited) {
  const environment = { ...inherited, OPENCODE_DISABLE_AUTOUPDATE: '1' };
  // ACP is stdio-only. Do not inherit credentials that could expose an unrelated
  // OpenCode HTTP server if the user also runs one locally.
  delete environment.OPENCODE_SERVER_PASSWORD;
  delete environment.OPENCODE_SERVER_USERNAME;

  let existing = {};
  try {
    const parsed = JSON.parse(environment.OPENCODE_CONFIG_CONTENT || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {}

  const existingTools = record(existing.tools);
  const existingPermission = record(existing.permission);
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...existing,
    tools: {
      ...existingTools,
      bash: false,
      edit: false,
      write: false,
      patch: false,
      read: false,
      glob: false,
      grep: false,
      webfetch: false,
      websearch: false,
      task: false,
      todowrite: false,
      lsp: false,
      skill: false,
      question: false,
    },
    permission: {
      ...existingPermission,
      '*': 'deny',
      'cuppet-runtime_*': 'allow',
      'cuppet_runtime_*': 'allow',
    },
  });
  return environment;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
