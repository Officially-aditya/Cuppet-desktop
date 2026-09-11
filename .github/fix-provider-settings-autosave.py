from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

# Main process: only resolve a provider-owned default when the renderer explicitly asks.
path = Path('src/main/main.mjs')
s = path.read_text()
s = replace_once(s,
"""    const explicitModel = typeof source.model === 'string' && source.model.trim();
    if (!explicitModel && result.authType === 'local-cli') {
""",
"""    const explicitModel = typeof source.model === 'string' && source.model.trim();
    const resolveDefault = source.resolveDefault === true;
    if (resolveDefault && !explicitModel && result.authType === 'local-cli') {
""",
'main explicit default guard')
path.write_text(s)

# Settings UI: provider selection and credentials persist immediately. No Save/Cancel footer.
path = Path('src/renderer/react/SettingsModal.tsx')
s = path.read_text()

old_save = """  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) { setNote('Choose a provider.'); return; }
    if (isCodex && !codex.loggedIn) { setSection('account'); setNote('Connect ChatGPT before selecting Codex as the active provider.'); return; }
    if (isLocalCli && !(cliStatus?.connected ?? cliStatus?.available)) { setNote(`Connect ${selected.label || selected.id} first.`); return; }
    setBusy(true);
    try {
      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: (isCodex || isLocalCli) ? '' : apiKey });
      setCurrent(saved);
      setApiKey('');
      onSaved({ ...saved, ...(isCodex ? { credentialConfigured: codex.loggedIn, configured: codex.loggedIn && Boolean(saved.primary?.modelID) } : {}), ...(isLocalCli ? { credentialConfigured: true, configured: Boolean(cliStatus?.available && saved.primary?.modelID) } : {}) });
      notifyProviderSettingsChanged();
      setNote(isCodex ? 'Codex subscription provider saved.' : isLocalCli ? `${selected.label || selected.id} local CLI provider saved.` : `${selected.label || selected.id} saved.`);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

"""
new_save = """  const activateProvider = async (nextProviderID: string) => {
    setProviderID(nextProviderID);
    setApiKey('');
    setNote('');
    if (!nextProviderID) return;
    setBusy(true);
    try {
      const saved = await window.cuppet.settings.save({ providerID: nextProviderID, apiKey: '', resolveDefault: true });
      setCurrent(saved);
      onSaved(saved);
      notifyProviderSettingsChanged();
      setNote(`${saved.presets?.find((item) => item.id === nextProviderID)?.label || nextProviderID} selected.`);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const persistApiKey = async () => {
    const value = apiKey.trim();
    if (!selected || isCodex || isLocalCli || !value || busy) return;
    setBusy(true);
    try {
      const activeModel = current?.providerID === selected.id || current?.primary?.providerID === selected.id
        ? current?.primary?.modelID || ''
        : '';
      const saved = await window.cuppet.settings.save({
        providerID: selected.id,
        apiKey: value,
        ...(activeModel ? { model: activeModel, backgroundModel: current?.secondary?.modelID || activeModel } : {}),
      });
      setCurrent(saved);
      setApiKey('');
      onSaved(saved);
      notifyProviderSettingsChanged();
      setNote(`${selected.label || selected.id} credential updated.`);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const resetProvider = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setApiKey('');
    try {
      const resetModel = selected.model || '';
      const saved = await window.cuppet.settings.save({
        providerID: selected.id,
        apiKey: '',
        ...(resetModel ? { model: resetModel, backgroundModel: resetModel } : {}),
        primaryEffort: '',
        secondaryEffort: '',
        secondaryAuto: true,
        resolveDefault: true,
      });
      setCurrent(saved);
      onSaved(saved);
      notifyProviderSettingsChanged();
      setNote(`${selected.label || selected.id} model settings reset.`);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

"""
s = replace_once(s, old_save, new_save, 'replace save handler')\n
s = replace_once(s,
"""      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: '' });
""",
"""      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: '', resolveDefault: true });
""",
'local cli connect resolves default explicitly')

s = replace_once(s,
"""              {section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} onConnectCli={connectLocalCli} />}
""",
"""              {section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={activateProvider} onApiKey={setApiKey} onApiKeyCommit={persistApiKey} onReset={resetProvider} onModelSaved={modelSaved} onConnect={connectCodex} onDisconnect={disconnectCodex} onConnectCli={connectLocalCli} />}
""",
'platform props')

old_sig = """function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect, onConnectCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onConnectCli: () => void | Promise<void> }) {
"""
new_sig = """function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onApiKeyCommit, onReset, onModelSaved, onConnect, onDisconnect, onConnectCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void | Promise<void>; onApiKey: (value: string) => void; onApiKeyCommit: () => void | Promise<void>; onReset: () => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onConnectCli: () => void | Promise<void> }) {
"""
s = replace_once(s, old_sig, new_sig, 'platform signature')

s = replace_once(s,
"""  const modelHint = activeProviderID !== providerID
    ? `Save ${selected?.label || providerID} first to choose its models.`
    : apiKey.trim()
      ? 'Save the API key change first so model selection uses the saved credential.'
      : !credentialReady
        ? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Connect ${selected?.label || 'the provider'} first. Cuppet handles installation automatically.` : 'Save an API key first to choose models.')
        : '';

  return <form className=\"platform-settings-form\" onSubmit={(event) => void onSave(event)}>
""",
"""  const modelHint = activeProviderID !== providerID
    ? `Selecting ${selected?.label || providerID}…`
    : apiKey.trim()
      ? 'Finish the API key field to apply the credential before choosing models.'
      : !credentialReady
        ? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Connect ${selected?.label || 'the provider'} first. Cuppet handles installation automatically.` : 'Enter an API key first to choose models.')
        : '';

  return <div className=\"platform-settings-form\">
""",
'platform wrapper/hints')

s = replace_once(s,
"""        <label>Provider<SelectControl ariaLabel=\"Provider\" value={providerID} onChange={onProvider} options={[{ value: '', label: 'Choose provider' }, ...presets.map((preset) => ({ value: preset.id, label: preset.label || preset.id }))]} /></label>
""",
"""        <label>Provider<SelectControl ariaLabel=\"Provider\" value={providerID} onChange={(id) => void onProvider(id)} options={[{ value: '', label: 'Choose provider' }, ...presets.map((preset) => ({ value: preset.id, label: preset.label || preset.id }))]} /></label>
""",
'provider select autosave')

s = replace_once(s,
"""        ) : <label>API key<input type=\"password\" autoComplete=\"new-password\" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder={current?.apiKeyConfigured && current?.providerID === providerID ? 'Saved securely · leave blank to keep it' : 'Enter API key'} /></label>}
""",
"""        ) : <label>API key<input type=\"password\" autoComplete=\"new-password\" value={apiKey} onChange={(event) => onApiKey(event.target.value)} onBlur={() => void onApiKeyCommit()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void onApiKeyCommit(); } }} placeholder={current?.apiKeyConfigured && current?.providerID === providerID ? 'Saved securely · leave blank to keep it' : 'Enter API key'} /></label>}
""",
'api key commit')

s = replace_once(s,
"""      <div className=\"settings-form-footer\">
        <div className=\"settings-note\">{note || (current?.encryptionAvailable ? 'API keys are encrypted with the operating system credential store. Primary drives foreground work; secondary drives Context Memory.' : current?.encryptionUnavailableReason || 'Secure credential storage is unavailable.')}</div>
        <div className=\"dialog-actions\"><button type=\"button\" className=\"ghost-button settings-action-button\" onClick={onClose}>Cancel</button><button type=\"submit\" className=\"primary-button settings-action-button\" disabled={busy || !selected}>Save</button></div>
      </div>
    </div>
  </form>;
""",
"""      <div className=\"settings-form-footer\">
        <div className=\"settings-note\">{note || (current?.encryptionAvailable ? 'Changes apply immediately. API keys are encrypted with the operating system credential store.' : current?.encryptionUnavailableReason || 'Changes apply immediately. Secure credential storage is unavailable.')}</div>
        <div className=\"dialog-actions\"><button type=\"button\" className=\"ghost-button settings-action-button\" disabled={busy || !selected} onClick={() => void onReset()}>{busy ? 'Applying…' : 'Reset'}</button></div>
      </div>
    </div>
  </div>;
""",
'footer reset only')

s = s.replace('Save this provider first, then add its custom model.', 'Select this provider first, then add its custom model.')
s = s.replace('Save the API key change first so the validation uses the saved provider credential.', 'Finish the API key field first so validation uses the updated credential.')
s = s.replace('Save an API key first so Cuppet can validate this model.', 'Enter an API key first so Cuppet can validate this model.')
path.write_text(s)

# Regression test: no Save/Cancel controls, immediate apply, and no implicit model reset.
path = Path('test/provider-settings-autosave.test.mjs')
path.write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('provider settings apply changes immediately and expose Reset instead of Save/Cancel', async () => {
  const source = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /const activateProvider = async/);
  assert.match(source, /onBlur=\{\(\) => void onApiKeyCommit\(\)\}/);
  assert.match(source, />\{busy \? 'Applying…' : 'Reset'\}<\/button>/);
  assert.doesNotMatch(source, />Cancel<\/button><button type=\"submit\"[^>]*>Save<\/button>/);
  assert.doesNotMatch(source, /const save = async \(event: React\.FormEvent\)/);
});

test('local CLI default resolution is explicit, so unrelated saves cannot overwrite model selection', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /const resolveDefault = source\.resolveDefault === true/);
  assert.match(source, /if \(resolveDefault && !explicitModel && result\.authType === 'local-cli'\)/);
});
""")
