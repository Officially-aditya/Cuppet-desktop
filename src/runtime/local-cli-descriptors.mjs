import { randomUUID } from 'node:crypto';

const OPENCODE_GUARD_AGENT_ENV = 'CUPPET_OPENCODE_AGENT_ID';

const DESCRIPTORS = Object.freeze({
  opencode: descriptor({
    id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use, then retry.',
    mcpToolBridge: true,
    // OpenCode merges per-agent permissions after global permissions. A global
    // OPENCODE_PERMISSION deny is therefore defense-in-depth, not a sufficient
    // execution boundary by itself. Inject one process-unique primary agent whose
    // own permission rules deny native tools and allow only Cuppet's session MCP,
    // then force every fresh ACP logical session onto that advertised mode.
    requiredSessionSettings: [
      { category: 'mode', valueFromEnv: OPENCODE_GUARD_AGENT_ENV, label: 'Cuppet execution mode' },
    ],
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
    // transport whitespace around each fragment. It can also emit pre-tool planning
    // through agent_message_chunk rather than agent_thought_chunk. Reassemble framing
    // artifacts, but do not render unclassified text as the live final answer until
    // Cuppet knows whether a tool call follows.
    textStream: { framing: 'tokenized-whitespace', preview: 'defer-unclassified' },
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
    // Kiro currently exposes model selection through the legacy ACP session/set_model
    // surface and model-dependent reasoning through its command extension. Keep those
    // extension method names descriptor-owned so shared ACP transport stays identity-free.
    sessionCommandSettings: [
      {
        id: 'effort',
        label: 'Effort',
        category: 'thought_level',
        command: 'effort',
        optionsMethod: '_kiro.dev/commands/options',
        executeMethod: '_kiro.dev/commands/execute',
      },
    ],
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
    ...(value.requiredSessionSettings ? { requiredSessionSettings: freezeValue(cloneValue(value.requiredSessionSettings)) } : {}),
    ...(value.sessionCommandSettings ? { sessionCommandSettings: freezeValue(cloneValue(value.sessionCommandSettings)) } : {}),
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
    ...(item.requiredSessionSettings ? { requiredSessionSettings: cloneValue(item.requiredSessionSettings) } : {}),
    ...(item.sessionCommandSettings ? { sessionCommandSettings: cloneValue(item.sessionCommandSettings) } : {}),
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

function openCodeAcpEnvironment(inherited = process.env) {
  const agentId = `cuppet-runtime-${randomUUID()}`;
  const permission = openCodeCuppetPermissions();
  const config = parseOpenCodeConfigContent(inherited.OPENCODE_CONFIG_CONTENT);
  const agents = record(config.agent);
  const previousAgent = record(agents[agentId]);

  return {
    ...inherited,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    [OPENCODE_GUARD_AGENT_ENV]: agentId,
    // Preserve every user-supplied provider/model/config field, but add a random
    // primary agent after normal global/project agent discovery. Because the id is
    // process-unique, user agent configuration cannot accidentally collide with it.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      agent: {
        ...agents,
        [agentId]: {
          ...previousAgent,
          description: 'Cuppet-managed execution boundary. Native OpenCode tools are disabled; use Cuppet MCP tools.',
          mode: 'primary',
          hidden: false,
          permission,
        },
      },
    }),
    // Defense in depth for built-in/default agents. The forced random agent above
    // is the actual boundary because OpenCode intentionally allows agent-specific
    // rules to override this global permission layer.
    OPENCODE_PERMISSION: JSON.stringify(permission),
  };
}

function openCodeCuppetPermissions() {
  return {
    '*': 'deny',
    read: 'deny',
    edit: 'deny',
    glob: 'deny',
    grep: 'deny',
    list: 'deny',
    bash: 'deny',
    task: 'deny',
    todowrite: 'deny',
    question: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    lsp: 'deny',
    skill: 'deny',
    external_directory: 'deny',
    'cuppet-runtime_*': 'allow',
    'cuppet_runtime_*': 'allow',
  };
}

function parseOpenCodeConfigContent(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return {};
  try {
    const parsed = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(source)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'invalid JSONC');
    throw new Error(`OpenCode OPENCODE_CONFIG_CONTENT could not be safely merged with Cuppet's execution guard: ${detail}`);
  }
}

function stripJsoncComments(source) {
  let output = '';
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') { lineComment = false; output += char; }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      else if (char === '\n' || char === '\r') output += char;
      continue;
    }
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') { string = true; output += char; continue; }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    output += char;
  }
  if (blockComment) throw new Error('unterminated block comment');
  return output;
}

function stripJsoncTrailingCommas(source) {
  let output = '';
  let string = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (string) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') { string = true; output += char; continue; }
    if (char === ',') {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === '}' || source[cursor] === ']') continue;
    }
    output += char;
  }
  return output;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }