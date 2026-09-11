from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor missing in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, count))

# Main process: bounded status + one-click connect IPC.
replace(
    'src/main/main.mjs',
    "import { cliAgentStatus } from './cli-agent-status.mjs';",
    "import { cliAgentConnect, cliAgentStatus } from './cli-agent-status.mjs';",
)
replace(
    'src/main/main.mjs',
    "  ipcMain.handle('cuppet:cli-agent:status', (_event, providerID) => cliAgentStatus(validateCliProviderID(providerID)));\n  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());",
    "  ipcMain.handle('cuppet:cli-agent:status', (_event, providerID) => cliAgentStatus(validateCliProviderID(providerID), { userData: app.getPath('userData') }));\n  ipcMain.handle('cuppet:cli-agent:connect', (_event, providerID) => cliAgentConnect(validateCliProviderID(providerID), { userData: app.getPath('userData') }));\n  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());",
)

# Preload: renderer gets only the bounded connect action.
replace(
    'src/preload/preload.cjs',
    "  cliAgents: {\n    status: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:status', providerID),\n  },",
    "  cliAgents: {\n    status: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:status', providerID),\n    connect: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:connect', providerID),\n  },",
)

# Renderer types: installed is not the same as authenticated/connected.
replace(
    'src/renderer/types.ts',
    "export type CliAgentStatus = {\n  providerID: string;\n  label?: string;\n  available: boolean;\n  installed?: boolean;\n  version?: string | null;\n  loginHint?: string;\n  message?: string;\n};",
    "export type CliAgentStatus = {\n  providerID: string;\n  label?: string;\n  available: boolean;\n  installed?: boolean;\n  connected?: boolean;\n  version?: string | null;\n  action?: 'connect' | 'ready' | string;\n  canAutoInstall?: boolean;\n  loginHint?: string;\n  message?: string;\n};",
)
replace(
    'src/renderer/types.ts',
    "  cliAgents: {\n    status: (providerID: string) => Promise<CliAgentStatus>;\n  };",
    "  cliAgents: {\n    status: (providerID: string) => Promise<CliAgentStatus>;\n    connect: (providerID: string) => Promise<CliAgentStatus>;\n  };",
)

# Settings: Connect owns install + provider auth + save. No Terminal instructions or manual refresh.
replace(
    'src/renderer/react/SettingsModal.tsx',
    "  const disconnectCodex = async () => {\n    setBusy(true);\n    try { setCodex(await window.cuppet.codexAuth.logout()); }\n    catch (error) { onError(error); }\n    finally { setBusy(false); }\n  };\n\n  const save = async (event: React.FormEvent) => {",
    "  const disconnectCodex = async () => {\n    setBusy(true);\n    try { setCodex(await window.cuppet.codexAuth.logout()); }\n    catch (error) { onError(error); }\n    finally { setBusy(false); }\n  };\n\n  const connectLocalCli = async () => {\n    if (!selected || !isLocalCli || !providerID) return;\n    setBusy(true);\n    setNote(`Connecting ${selected.label || selected.id}…`);\n    try {\n      setCliStatus((current) => ({ ...(current ?? { providerID }), providerID, available: false, connected: false, message: current?.installed === false ? `Installing ${selected.label || selected.id}…` : `Opening ${selected.label || selected.id} sign-in…` }));\n      const linked = await window.cuppet.cliAgents.connect(providerID);\n      setCliStatus(linked);\n      if (!(linked.connected ?? linked.available)) throw new Error(linked.message || `${selected.label || selected.id} did not finish connecting.`);\n      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: '' });\n      setCurrent(saved);\n      setApiKey('');\n      const projected = { ...saved, credentialConfigured: true, configured: Boolean(saved.primary?.modelID) };\n      onSaved(projected);\n      setNote(`${selected.label || selected.id} connected and selected.`);\n    } catch (error) {\n      setNote(error instanceof Error ? error.message : String(error));\n      onError(error);\n      try { setCliStatus(await window.cuppet.cliAgents.status(providerID)); } catch {}\n    } finally {\n      setBusy(false);\n    }\n  };\n\n  const save = async (event: React.FormEvent) => {",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "    if (isLocalCli && !cliStatus?.available) { setNote(`${selected.label || selected.id} CLI is not installed or is not available on PATH.`); return; }",
    "    if (isLocalCli && !(cliStatus?.connected ?? cliStatus?.available)) { setNote(`Connect ${selected.label || selected.id} first.`); return; }",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "{section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} onRefreshCli={refreshCliStatus} />}",
    "{section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} onConnectCli={connectLocalCli} />}",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect, onRefreshCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onRefreshCli: () => void | Promise<void> }) {\n  const activeProviderID = current?.providerID || current?.primary?.providerID || '';\n  const credentialReady = isCodex ? Boolean(codex.loggedIn) : isLocalCli ? Boolean(cliStatus?.available) : Boolean(current?.apiKeyConfigured);",
    "function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect, onConnectCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onConnectCli: () => void | Promise<void> }) {\n  const activeProviderID = current?.providerID || current?.primary?.providerID || '';\n  const cliConnected = Boolean(cliStatus?.connected ?? cliStatus?.available);\n  const credentialReady = isCodex ? Boolean(codex.loggedIn) : isLocalCli ? cliConnected : Boolean(current?.apiKeyConfigured);",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Install ${selected?.label || 'the CLI'} first so Cuppet can use it.` : 'Save an API key first to choose models.')",
    "? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Connect ${selected?.label || 'the provider'} first. Cuppet handles installation automatically.` : 'Save an API key first to choose models.')",
)
replace(
    'src/renderer/react/SettingsModal.tsx',
    "        ) : isLocalCli ? (\n          <div className=\"provider-auth-card\">\n            <div className=\"provider-auth-copy\">\n              <div className=\"provider-auth-title-row\"><strong>Local CLI</strong><span className={`settings-status-pill compact${cliStatus?.available ? '' : ' muted'}`}>{cliStatus?.available ? 'Detected' : cliStatus ? 'Not detected' : 'Checking…'}</span></div>\n              <span>{cliStatus?.message || `Checking for ${selected?.label || providerID} on this computer…`}</span>\n              {cliStatus?.loginHint && <span>{cliStatus.loginHint}</span>}\n            </div>\n            <div className=\"provider-auth-actions\"><button type=\"button\" className=\"ghost-button settings-action-button\" disabled={busy} onClick={() => void onRefreshCli()}>Refresh</button></div>\n          </div>\n",
    "        ) : isLocalCli ? (\n          <div className=\"provider-auth-card\">\n            <div className=\"provider-auth-copy\">\n              <div className=\"provider-auth-title-row\"><strong>Provider connection</strong><span className={`settings-status-pill compact${cliConnected ? '' : ' muted'}`}>{cliConnected ? 'Connected' : busy ? 'Connecting…' : cliStatus ? 'Not connected' : 'Checking…'}</span></div>\n              <span>{cliStatus?.message || `Checking ${selected?.label || providerID}…`}</span>\n              {!cliConnected && <span>Cuppet installs the official CLI when needed and opens the provider's own sign-in flow automatically. No Terminal setup is required.</span>}\n            </div>\n            <div className=\"provider-auth-actions\">{cliConnected ? <span className=\"settings-status-pill compact\">Ready</span> : <button type=\"button\" className=\"primary-button settings-action-button\" disabled={busy || cliStatus === null} onClick={() => void onConnectCli()}>{busy ? 'Connecting…' : `Connect ${selected?.label || 'provider'}`}</button>}</div>\n          </div>\n",
)

# Renderer verifier: one-click local provider linking must remain bounded and terminal-free for users.
verify = Path('scripts/verify-renderer.mjs').read_text()
anchor = "assert.match(preload, /cuppet:usage:summary/, 'bounded preload does not expose token usage summary');"
if anchor not in verify:
    raise SystemExit('verify-renderer preload anchor missing')
verify = verify.replace(anchor, anchor + "\nassert.match(main, /cuppet:cli-agent:connect/, 'Electron main does not expose automatic local provider linking');\nassert.match(preload, /cuppet:cli-agent:connect/, 'bounded preload does not expose automatic local provider linking');\nassert.match(settings, /window\\.cuppet\\.cliAgents\\.connect/, 'Provider settings does not use one-click local provider linking');\nassert.match(settings, /Cuppet installs the official CLI when needed/, 'Provider settings does not explain automatic CLI installation');\nassert.doesNotMatch(settings, /cliStatus\\?\\.loginHint/, 'Provider settings still exposes manual Terminal login instructions');\nassert.doesNotMatch(settings, /onRefreshCli/, 'Provider settings still exposes a manual CLI refresh/link step');", 1)
Path('scripts/verify-renderer.mjs').write_text(verify)

# Small host-level contract test: every local provider has automatic macOS install; only provider-owned auth remains.
Path('test/cli-agent-linking.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';

const providers = ['opencode', 'grok-build', 'github-copilot', 'mistral-vibe', 'kiro', 'antigravity'];

test('all local providers have automatic macOS installers', () => {
  for (const providerID of providers) {
    const spec = installSpec(providerID, 'darwin');
    assert.ok(spec, `missing automatic installer for ${providerID}`);
    assert.equal(spec.command, '/bin/bash');
    assert.deepEqual(spec.args.slice(0, 1), ['-lc']);
  }
});

test('provider-owned login flows need no copied Terminal command', () => {
  assert.equal(loginSpec('opencode', 'opencode'), null);
  assert.deepEqual(loginSpec('grok-build', 'grok').args, ['login']);
  assert.deepEqual(loginSpec('github-copilot', 'copilot').args, ['login', '--web-flow']);
  assert.deepEqual(loginSpec('kiro', 'kiro-cli').args, ['login', '--license', 'free']);
  const vibe = loginSpec('mistral-vibe', '/tmp/vibe-acp');
  assert.equal(vibe.command, '/tmp/vibe');
  assert.deepEqual(vibe.args, ['--setup']);
  const antigravity = loginSpec('antigravity', 'agy');
  assert.ok(antigravity.args.includes('--mode=plan'));
  assert.ok(antigravity.args.includes('--sandbox'));
  assert.ok(!antigravity.args.includes('--dangerously-skip-permissions'));
});
''')
