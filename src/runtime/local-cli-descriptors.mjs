const DESCRIPTORS = Object.freeze({
  opencode: descriptor({
    id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use.',
  }),
  'grok-build': descriptor({
    id: 'grok-build', label: 'Grok Build', transport: 'acp', command: 'grok', args: ['--no-auto-update', 'agent', 'stdio'], versionArgs: ['version'], envOverride: 'CUPPET_GROK_BIN',
    loginHint: 'Run `grok login` in Terminal once, then retry.',
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
  }),
  antigravity: descriptor({
    id: 'antigravity', label: 'Google Antigravity', transport: 'headless-plan', command: 'agy', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_ANTIGRAVITY_BIN',
    loginHint: 'Run `agy` in Terminal once and complete Google sign-in, then retry.',
  }),
});

export function localCliDescriptor(value) {
  const item = DESCRIPTORS[String(value ?? '').trim().toLowerCase()];
  return item ? { ...item, args: [...item.args], versionArgs: [...item.versionArgs] } : null;
}

export function isLocalCliProvider(value) { return Boolean(localCliDescriptor(value)); }
export function localCliProviderIDs() { return Object.keys(DESCRIPTORS); }

function descriptor(value) { return Object.freeze({ ...value, args: Object.freeze([...value.args]), versionArgs: Object.freeze([...value.versionArgs]) }); }
