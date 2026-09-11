import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CliAgentStatus, ProviderPreset, ProviderSettings, RemoteDevice, Session, TokenUsageSummary } from '../types';
import { SelectControl } from './SelectControl';
import { ModelPicker } from './ModelPicker';
import { GeneralPanel } from './GeneralPanel';
import { CUPPET_LOGO_URL } from './brand';

const SECTION_META: Record<string, [string, string]> = {
  general: ['General', 'Choose how Cuppet handles permissions and messages while it is working.'],
  account: ['Account', 'Manage account connections used by Cuppet on this computer.'],
  platform: ['Platform', 'Choose the model provider Cuppet uses on this computer.'],
  personalisation: ['Personalisation', 'Adjust local interface preferences.'],
  usage: ['Token usage', 'Review exact token counts reported by your model providers.'],
  devices: ['Connected devices', 'Review devices paired through Cuppet Remote.'],
  privacy: ['Data & privacy', 'Understand where desktop data and credentials live.'],
  about: ['About', 'Desktop runtime and build information.'],
};

const PREF_COMPACT = 'cuppet.desktop.pref.compact-sidebar';
const PREF_MOTION = 'cuppet.desktop.pref.reduce-motion';

type Props = {
  provider: ProviderSettings | null;
  initialSection: string;
  onClose: () => void;
  onSaved: (provider: ProviderSettings) => void;
  onOpenRemote: () => void;
  onError: (error: unknown) => void;
};

export function SettingsModal({ provider, initialSection, onClose, onSaved, onOpenRemote, onError }: Props) {
  const [section, setSection] = useState(SECTION_META[initialSection] ? initialSection : 'account');
  const [current, setCurrent] = useState<ProviderSettings | null>(provider);
  const [providerID, setProviderID] = useState(provider?.providerID || provider?.primary?.providerID || provider?.presetID || 'openai');
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [codex, setCodex] = useState<any>({ available: false, loggedIn: false, loginRunning: false, message: 'Checking…' });
  const [cliStatus, setCliStatus] = useState<CliAgentStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [usage, setUsage] = useState<TokenUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [compact, setCompact] = useState(localStorage.getItem(PREF_COMPACT) === '1');
  const [reduceMotion, setReduceMotion] = useState(localStorage.getItem(PREF_MOTION) === '1');

  const presets = current?.presets ?? provider?.presets ?? [];
  const selected = useMemo(() => presets.find((item) => item.id === providerID) ?? null, [presets, providerID]);
  const isCodex = selected?.authType === 'chatgpt' || providerID === 'codex';
  const isLocalCli = selected?.authType === 'local-cli';

  const refresh = useCallback(async () => {
    try {
      const next = await window.cuppet.settings.get();
      setCurrent(next);
      if (!providerID) setProviderID(next.providerID || next.presetID || 'openai');
    } catch (error) { onError(error); }
  }, [onError, providerID]);

  const refreshCodex = useCallback(async () => {
    try { setCodex(await window.cuppet.codexAuth.status()); }
    catch (error) { setCodex({ available: false, loggedIn: false, loginRunning: false, message: error instanceof Error ? error.message : String(error) }); }
  }, []);

  const refreshCliStatus = useCallback(async () => {
    if (!isLocalCli || !providerID) { setCliStatus(null); return; }
    setCliStatus((current) => current?.providerID === providerID ? current : { providerID, available: false, message: 'Checking local CLI…' });
    try { setCliStatus(await window.cuppet.cliAgents.status(providerID)); }
    catch (error) { setCliStatus({ providerID, available: false, message: error instanceof Error ? error.message : String(error) }); }
  }, [isLocalCli, providerID]);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await window.cuppet.remote.devices()); }
    catch { setDevices([]); }
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    try { setUsage(await window.cuppet.usage.summary()); }
    catch (error) { onError(error); }
    finally { setUsageLoading(false); }
  }, [onError]);

  useEffect(() => { void refresh(); void refreshCodex(); void refreshDevices(); }, [refresh, refreshCodex, refreshDevices]);
  useEffect(() => { void refreshCliStatus(); }, [refreshCliStatus]);
  useEffect(() => { if (section === 'usage') void refreshUsage(); }, [refreshUsage, section]);

  useEffect(() => {
    document.body.classList.toggle('compact-sidebar', compact);
    localStorage.setItem(PREF_COMPACT, compact ? '1' : '0');
  }, [compact]);
  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduceMotion);
    localStorage.setItem(PREF_MOTION, reduceMotion ? '1' : '0');
  }, [reduceMotion]);

  const connectCodex = async () => {
    setBusy(true);
    try {
      await window.cuppet.codexAuth.login();
      await refreshCodex();
      setNote('Complete ChatGPT sign-in in the browser. Cuppet never receives the OAuth credentials.');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const disconnectCodex = async () => {
    setBusy(true);
    try { setCodex(await window.cuppet.codexAuth.logout()); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const connectLocalCli = async () => {
    if (!selected || !isLocalCli || !providerID) return;
    setBusy(true);
    setNote(`Connecting ${selected.label || selected.id}…`);
    try {
      setCliStatus((current) => ({ ...(current ?? { providerID }), providerID, available: false, connected: false, message: current?.installed === false ? `Installing ${selected.label || selected.id}…` : `Opening ${selected.label || selected.id} sign-in…` }));
      const linked = await window.cuppet.cliAgents.connect(providerID);
      setCliStatus(linked);
      if (!(linked.connected ?? linked.available)) throw new Error(linked.message || `${selected.label || selected.id} did not finish connecting.`);
      const saved = await window.cuppet.settings.save({ providerID: selected.id, apiKey: '' });
      setCurrent(saved);
      setApiKey('');
      const projected = { ...saved, credentialConfigured: true, configured: Boolean(saved.primary?.modelID) };
      onSaved(projected);
      setNote(`${selected.label || selected.id} connected and selected.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      onError(error);
      try { setCliStatus(await window.cuppet.cliAgents.status(providerID)); } catch {}
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
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
      setNote(isCodex ? 'Codex subscription provider saved.' : isLocalCli ? `${selected.label || selected.id} local CLI provider saved.` : `${selected.label || selected.id} saved.`);
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const modelSaved = useCallback((saved: ProviderSettings) => {
    setCurrent(saved);
    onSaved(saved);
  }, [onSaved]);

  const [title, description] = SECTION_META[section] ?? SECTION_META.account;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-hub-dialog react-settings-hub" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-hub-shell">
          <aside className="settings-hub-sidebar">
            <div className="settings-hub-brand"><img className="settings-hub-mark" src={CUPPET_LOGO_URL} alt="" aria-hidden="true" /><div><strong>Settings</strong><span>Cuppet</span></div></div>
            <nav className="settings-hub-nav" aria-label="Settings sections">
              {Object.entries(SECTION_META).map(([id, [label]]) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{label}</button>)}
            </nav>
          </aside>
          <div className="settings-hub-main">
            <header className="settings-hub-header"><div><h2 id="settings-title">{title}</h2><p>{description}</p></div><button type="button" className="icon-button settings-close-button" aria-label="Close" onClick={onClose}>×</button></header>
            <div className="settings-hub-content">
              {section === 'general' && <GeneralPanel />}
              {section === 'account' && <AccountPanel codex={codex} busy={busy} onConnect={connectCodex} onDisconnect={disconnectCodex} onError={onError} />}
              {section === 'platform' && <PlatformPanel current={current} presets={presets} selected={selected} providerID={providerID} apiKey={apiKey} isCodex={isCodex} isLocalCli={isLocalCli} cliStatus={cliStatus} codex={codex} note={note} busy={busy} onProvider={setProviderID} onApiKey={setApiKey} onSave={save} onModelSaved={modelSaved} onClose={onClose} onConnect={connectCodex} onDisconnect={disconnectCodex} onConnectCli={connectLocalCli} />}
              {section === 'personalisation' && <PersonalisationPanel compact={compact} reduceMotion={reduceMotion} onCompact={setCompact} onReduceMotion={setReduceMotion} />}
              {section === 'usage' && <UsagePanel current={current} usage={usage} loading={usageLoading} onRefresh={refreshUsage} />}
              {section === 'devices' && <DevicesPanel devices={devices} onOpenRemote={onOpenRemote} />}
              {section === 'privacy' && <PrivacyPanel />}
              {section === 'about' && <AboutPanel />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function AccountPanel({ codex, busy, onConnect, onDisconnect, onError }: { codex: any; busy: boolean; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onError: (error: unknown) => void }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<Session[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());

  const refreshDeleted = useCallback(async () => {
    setDeletedLoading(true);
    try { setDeleted(await window.cuppet.sessions.deleted()); }
    catch (error) { onError(error); }
    finally { setDeletedLoading(false); }
  }, [onError]);

  useEffect(() => {
    if (!showDeleted) return;
    void refreshDeleted();
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    const unsubscribe = window.cuppet.onEvent((event) => {
      if (['session.deleted', 'session.restored', 'session.purged'].includes(String(event?.type))) void refreshDeleted();
    });
    return () => { window.clearInterval(timer); unsubscribe(); };
  }, [refreshDeleted, showDeleted]);

  const restoreDeleted = async (sessionId: string) => {
    setRestoring(sessionId);
    try {
      await window.cuppet.sessions.restore(sessionId);
      await refreshDeleted();
    } catch (error) { onError(error); }
    finally { setRestoring(null); }
  };

  return <>
    <div className="settings-card"><div className="settings-card-heading"><div><h3>Cuppet account</h3><p>Your Cuppet account will connect desktop identity, Agents, and synced services.</p></div><span className="settings-status-pill">Not connected</span></div><div className="settings-row"><div><strong>Desktop mode</strong><span>Projects and conversations remain local in this build.</span></div><span className="settings-value">Local</span></div></div>
    <div className="settings-card"><div className="settings-card-heading"><div><h3>ChatGPT / Codex</h3><p>Uses the official OpenAI Codex app-server. Codex owns and refreshes the OAuth credentials; Cuppet never reads or copies them.</p></div><span className={`settings-status-pill${codex.loggedIn ? '' : ' muted'}`}>{codex.loggedIn ? 'Connected' : codex.loginRunning ? 'Connecting…' : 'Not connected'}</span></div>
      <div className="settings-row codex-auth-row"><div><strong>{codex.email || 'Official Codex OAuth'}</strong><span>{codex.message || 'Use your existing ChatGPT Codex subscription.'}{codex.planType ? ` · ${codex.planType}` : ''}</span></div><div className="codex-auth-actions">{codex.loggedIn ? <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={() => void onDisconnect()}>Sign out</button> : <button type="button" className="primary-button settings-action-button" disabled={busy || codex.loginRunning || codex.available === false} onClick={() => void onConnect()}>Continue with ChatGPT</button>}</div></div>
    </div>
    <div className="settings-card deleted-chats-card">
      <div className="settings-row">
        <div><strong>Deleted chats</strong><span>Chats deleted from the sidebar remain recoverable for 7 days before permanent cleanup.</span></div>
        <button type="button" className="ghost-button settings-action-button" aria-expanded={showDeleted} onClick={() => setShowDeleted((value) => !value)}>{showDeleted ? 'Hide' : 'Deleted chats'}</button>
      </div>
      {showDeleted && <div className="settings-device-list deleted-chat-list" aria-label="Deleted chats">
        {deletedLoading && !deleted.length ? <div className="settings-empty">Loading deleted chats…</div> : deleted.length ? deleted.map((session) => <div className="settings-row deleted-chat-row" key={session.id}>
          <div><strong>{session.title || 'New chat'}</strong><span>{session.projectId ? 'Project chat' : 'General chat'} · {deletedRecoveryLabel(session, clock)}</span></div>
          <button type="button" className="ghost-button settings-action-button" disabled={restoring === session.id} onClick={() => void restoreDeleted(session.id)}>{restoring === session.id ? 'Restoring…' : 'Restore'}</button>
        </div>) : <div className="settings-empty">No deleted chats in the 7-day recovery window.</div>}
      </div>}
    </div>
  </>;
}

function PlatformPanel({ current, presets, selected, providerID, apiKey, isCodex, isLocalCli, cliStatus, codex, note, busy, onProvider, onApiKey, onSave, onModelSaved, onClose, onConnect, onDisconnect, onConnectCli }: { current: ProviderSettings | null; presets: ProviderPreset[]; selected: ProviderPreset | null; providerID: string; apiKey: string; isCodex: boolean; isLocalCli: boolean; cliStatus: CliAgentStatus | null; codex: any; note: string; busy: boolean; onProvider: (id: string) => void; onApiKey: (value: string) => void; onSave: (event: React.FormEvent) => void | Promise<void>; onModelSaved: (settings: ProviderSettings) => void; onClose: () => void; onConnect: () => void | Promise<void>; onDisconnect: () => void | Promise<void>; onConnectCli: () => void | Promise<void> }) {
  const activeProviderID = current?.providerID || current?.primary?.providerID || '';
  const cliConnected = Boolean(cliStatus?.connected ?? cliStatus?.available);
  const credentialReady = isCodex ? Boolean(codex.loggedIn) : isLocalCli ? cliConnected : Boolean(current?.apiKeyConfigured);
  const modelsReady = Boolean(selected && activeProviderID === providerID && credentialReady && !apiKey.trim());
  const modelHint = activeProviderID !== providerID
    ? `Save ${selected?.label || providerID} first to choose its models.`
    : apiKey.trim()
      ? 'Save the API key change first so model selection uses the saved credential.'
      : !credentialReady
        ? (isCodex ? 'Connect ChatGPT first to choose Codex models.' : isLocalCli ? `Connect ${selected?.label || 'the provider'} first. Cuppet handles installation automatically.` : 'Save an API key first to choose models.')
        : '';

  return <form className="platform-settings-form" onSubmit={(event) => void onSave(event)}>
    <div className="settings-card platform-provider-card">
      <div className="settings-card-heading"><div><h3>AI provider</h3><p>Select the backend Cuppet uses. API providers use local secure keys; agent providers use their own installed CLI authentication.</p></div></div>
      <div className="provider-simple-form">
        <label>Provider<SelectControl ariaLabel="Provider" value={providerID} onChange={onProvider} options={[{ value: '', label: 'Choose provider' }, ...presets.map((preset) => ({ value: preset.id, label: preset.label || preset.id }))]} /></label>
        {selected && <div className="provider-preset-note"><strong>{selected.label || selected.id}</strong><span>{selected.note || (isCodex ? 'Uses your existing ChatGPT Codex subscription through the official OpenAI Codex app-server. Cuppet never reads or stores Codex OAuth credentials.' : 'Official endpoint and default coding model are configured automatically.')}</span></div>}
        {isCodex ? (
          <div className="provider-auth-card">
            <div className="provider-auth-copy">
              <div className="provider-auth-title-row"><strong>ChatGPT subscription</strong><span className={`settings-status-pill compact${codex.loggedIn ? '' : ' muted'}`}>{codex.loggedIn ? 'Connected' : codex.loginRunning ? 'Connecting…' : 'Not connected'}</span></div>
              <span>{codex.loggedIn ? `Connected${codex.email ? ` as ${codex.email}` : ' with ChatGPT'}${codex.planType ? ` · ${codex.planType}` : ''}. Codex owns and refreshes your subscription credentials.` : 'Connect ChatGPT to use Codex without storing OAuth credentials in Cuppet.'}</span>
            </div>
            <div className="provider-auth-actions">
              {codex.loggedIn ? <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={() => void onDisconnect()}>Sign out</button> : <button type="button" className="primary-button settings-action-button" disabled={busy || codex.loginRunning || codex.available === false} onClick={() => void onConnect()}>Continue with ChatGPT</button>}
            </div>
          </div>
        ) : isLocalCli ? (
          <div className="provider-auth-card">
            <div className="provider-auth-copy">
              <div className="provider-auth-title-row"><strong>Provider connection</strong><span className={`settings-status-pill compact${cliConnected ? '' : ' muted'}`}>{cliConnected ? 'Connected' : busy ? 'Connecting…' : cliStatus ? 'Not connected' : 'Checking…'}</span></div>
              <span>{cliStatus?.message || `Checking ${selected?.label || providerID}…`}</span>
              {!cliConnected && <span>Cuppet installs the official CLI when needed and opens the provider's own sign-in flow automatically. No Terminal setup is required.</span>}
            </div>
            <div className="provider-auth-actions">{cliConnected ? <span className="settings-status-pill compact">Ready</span> : <button type="button" className="primary-button settings-action-button" disabled={busy || cliStatus === null} onClick={() => void onConnectCli()}>{busy ? 'Connecting…' : `Connect ${selected?.label || 'provider'}`}</button>}</div>
          </div>
        ) : <label>API key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder={current?.apiKeyConfigured && current?.providerID === providerID ? 'Saved securely · leave blank to keep it' : 'Enter API key'} /></label>}
        {selected && <div className="platform-model-section">
          <div className="platform-model-grid">
            <div className="platform-model-field">
              <div className="platform-model-copy"><strong>Primary model</strong><span>Foreground work</span></div>
              <ModelPicker slot="primary" surface="settings" disabled={busy || !modelsReady} onChange={onModelSaved} />
            </div>
            <div className="platform-model-field">
              <div className="platform-model-copy"><strong>Secondary model</strong><span>Context Memory</span></div>
              <ModelPicker slot="secondary" surface="settings" disabled={busy || !modelsReady} onChange={onModelSaved} />
            </div>
          </div>
          {modelHint && <div className="platform-model-hint">{modelHint}</div>}
        </div>}
        {selected && !isLocalCli && <CustomModelField current={current} providerID={providerID} providerLabel={selected.label || selected.id} apiKey={apiKey} isCodex={isCodex} codex={codex} />}
      </div>
      <div className="settings-form-footer">
        <div className="settings-note">{note || (current?.encryptionAvailable ? 'API keys are encrypted with the operating system credential store. Primary drives foreground work; secondary drives Context Memory.' : current?.encryptionUnavailableReason || 'Secure credential storage is unavailable.')}</div>
        <div className="dialog-actions"><button type="button" className="ghost-button settings-action-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button settings-action-button" disabled={busy || !selected}>Save</button></div>
      </div>
    </div>
  </form>;
}

function CustomModelField({ current, providerID, providerLabel, apiKey, isCodex, codex }: { current: ProviderSettings | null; providerID: string; providerLabel: string; apiKey: string; isCodex: boolean; codex: any }) {
  const [modelID, setModelID] = useState('');
  const [snapshot, setSnapshot] = useState<ProviderSettings | null>(current);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => { if (current) setSnapshot(current); }, [current]);
  useEffect(() => { setModelID(''); setStatus(''); }, [providerID]);

  const activeProviderID = snapshot?.providerID || snapshot?.primary?.providerID || '';
  const savedModels = (snapshot?.customModels ?? []).filter((item) => item.providerID === providerID).map((item) => item.modelID);
  const credentialReady = isCodex ? Boolean(codex.loggedIn) : Boolean(snapshot?.apiKeyConfigured);
  const providerReady = activeProviderID === providerID && credentialReady && !apiKey.trim();

  const add = async () => {
    const value = modelID.trim();
    if (!value || !providerReady || testing) return;
    setTesting(true);
    setStatus('Testing model…');
    try {
      const next = await window.cuppet.settings.save({ providerID, customModel: value });
      setSnapshot(next);
      setModelID('');
      setStatus(`${value} validated and added to ${providerLabel}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const blockedReason = activeProviderID !== providerID
    ? `Save ${providerLabel} first, then add a custom model.`
    : apiKey.trim()
      ? 'Save the API key change first so the validation uses the saved provider credential.'
      : !credentialReady
        ? (isCodex ? 'Connect ChatGPT first so Cuppet can validate this Codex model.' : 'Save an API key first so Cuppet can validate this model.')
        : 'Cuppet sends one tiny tool-free request before saving the model ID.';

  return <div className="provider-auth-card custom-model-card">
    <div className="provider-auth-copy">
      <div className="provider-auth-title-row"><strong>Custom model ID</strong>{savedModels.length > 0 && <span className="settings-status-pill compact">{savedModels.length} saved</span>}</div>
      <span>{status || blockedReason}</span>
      {savedModels.length > 0 && <span>Saved: {savedModels.join(' · ')}</span>}
    </div>
    <div className="provider-auth-actions">
      <input
        aria-label="Custom model ID"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={modelID}
        disabled={!providerReady || testing}
        placeholder="provider/model-id"
        onChange={(event) => { setModelID(event.target.value); if (status) setStatus(''); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void add();
        }}
      />
      <button type="button" className="ghost-button settings-action-button" disabled={!providerReady || testing || !modelID.trim()} onClick={() => void add()}>{testing ? 'Adding…' : 'Add'}</button>
    </div>
  </div>;
}

function PersonalisationPanel({ compact, reduceMotion, onCompact, onReduceMotion }: { compact: boolean; reduceMotion: boolean; onCompact: (value: boolean) => void; onReduceMotion: (value: boolean) => void }) {
  return <div className="settings-card"><div className="settings-card-heading"><div><h3>Interface</h3><p>These preferences are stored only on this computer.</p></div></div>
    <label className="settings-toggle-row"><div><strong>Compact sidebar</strong><span>Reduce vertical spacing for projects and conversations.</span></div><input type="checkbox" checked={compact} onChange={(event) => onCompact(event.target.checked)} /></label>
    <label className="settings-toggle-row"><div><strong>Reduce motion</strong><span>Minimise interface animations and smooth scrolling.</span></div><input type="checkbox" checked={reduceMotion} onChange={(event) => onReduceMotion(event.target.checked)} /></label>
  </div>;
}

function UsagePanel({ current, usage, loading, onRefresh }: { current: ProviderSettings | null; usage: TokenUsageSummary | null; loading: boolean; onRefresh: () => void | Promise<void> }) {
  const providerLabel = (providerID: string) => current?.presets?.find((item) => item.id === providerID)?.label || providerID;
  const tracked = usage?.trackedRequests ?? 0;
  const requests = usage?.requests ?? 0;
  const unreported = usage?.unreportedRequests ?? 0;

  return <div className="settings-card usage-card">
    <div className="settings-card-heading">
      <div><h3>Token usage</h3><p>Exact counts returned by model providers across local Cuppet model calls.</p></div>
      <div className="usage-heading-actions"><span className={`settings-status-pill${tracked ? '' : ' muted'}`}>{tracked ? `${tracked}/${requests} tracked` : requests ? 'No token telemetry' : 'No usage yet'}</span><button type="button" className="ghost-button settings-action-button" disabled={loading} onClick={() => void onRefresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    </div>
    {!usage || !requests ? (
      <div className="usage-placeholder"><strong>No provider calls tracked yet</strong><span>Counts begin with this build. Cuppet records provider-reported usage only and never estimates tokens for older conversations.</span></div>
    ) : <>
      <div className="usage-stats" aria-label="Token usage totals">
        <UsageStat label="Total tokens" value={formatTokens(usage.totalTokens)} strong />
        <UsageStat label="Input" value={formatTokens(usage.inputTokens)} />
        <UsageStat label="Output" value={formatTokens(usage.outputTokens)} />
        <UsageStat label="API calls" value={formatInteger(requests)} />
        {usage.cachedInputTokens > 0 && <UsageStat label="Cached input" value={formatTokens(usage.cachedInputTokens)} />}
        {usage.reasoningTokens > 0 && <UsageStat label="Reasoning" value={formatTokens(usage.reasoningTokens)} />}
      </div>
      <div className="usage-model-list">
        {usage.byModel.map((item) => <div className="usage-model-row" key={`${item.providerID}:${item.modelID}`}>
          <div className="usage-model-copy"><strong>{item.modelID}</strong><span>{providerLabel(item.providerID)} · {item.trackedRequests}/{item.requests} calls reported tokens</span></div>
          <div className="usage-model-values"><strong>{formatTokens(item.totalTokens)}</strong><span>{formatTokens(item.inputTokens)} in · {formatTokens(item.outputTokens)} out</span></div>
        </div>)}
      </div>
      <div className="usage-footnote">
        <span>{unreported ? `${unreported} successful provider call${unreported === 1 ? '' : 's'} did not return token telemetry and are excluded from token totals. ` : ''}Cached-input and reasoning counts are shown only when a provider reports them.</span>
        {usage.lastTrackedAt && <span>Last exact report {formatUsageTime(usage.lastTrackedAt)}.</span>}
      </div>
    </>}
  </div>;
}

function UsageStat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`usage-stat${strong ? ' primary' : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function DevicesPanel({ devices, onOpenRemote }: { devices: RemoteDevice[]; onOpenRemote: () => void }) {
  return <div className="settings-card"><div className="settings-card-heading"><div><h3>Connected devices</h3><p>Devices paired through Cuppet Remote.</p></div><button type="button" className="ghost-button settings-action-button" onClick={onOpenRemote}>Open Remote</button></div><div className="settings-device-list">{devices.length ? devices.map((device) => <div className="settings-row" key={device.deviceId}><div><strong>{device.name || 'Cuppet device'}</strong><span>{device.deviceId.slice(0, 18)}</span></div></div>) : <div className="settings-empty">No paired devices.</div>}</div></div>;
}

function PrivacyPanel() {
  return <div className="settings-card"><div className="settings-card-heading"><div><h3>Data & privacy</h3><p>Local-first controls for desktop data and credentials.</p></div></div>
    <div className="settings-row"><div><strong>Conversation storage</strong><span>Desktop conversations and project state are stored locally.</span></div><span className="settings-value">Local</span></div>
    <div className="settings-row"><div><strong>Provider credentials</strong><span>API keys use the operating system secure credential store when available. Codex OAuth remains owned by Codex.</span></div><span className="settings-value">On device</span></div>
    <div className="settings-row"><div><strong>Remote control</strong><span>The desktop remains authoritative; provider credentials are not sent to paired devices.</span></div><span className="settings-value">Opt-in</span></div>
  </div>;
}

function AboutPanel() {
  return <div className="settings-card about-card"><div className="about-brand"><img src={CUPPET_LOGO_URL} alt="Cuppet" /><div><h3>Cuppet Desktop</h3><p>Independent local agent runtime for projects, conversations, tools, and Remote.</p></div></div><div className="settings-row"><div><strong>Renderer</strong><span>React + TypeScript, compiled with Vite.</span></div><span className="settings-value">React</span></div><div className="settings-row"><div><strong>Runtime</strong><span>Electron host with the independent Cuppet runtime.</span></div><span className="settings-value">Desktop</span></div></div>;
}

function deletedRecoveryLabel(session: Session, now = Date.now()) {
  const purgeAt = Number(session.purgeAt || (Number(session.deletedAt) + 7 * 24 * 60 * 60 * 1000));
  const remaining = Math.max(0, purgeAt - now);
  if (remaining <= 0) return 'Recovery window expired';
  const hours = Math.max(1, Math.ceil(remaining / (60 * 60 * 1000)));
  if (hours < 24) return `${hours}h left to restore`;
  const days = Math.ceil(hours / 24);
  return `${days}d left to restore`;
}

function formatTokens(value: number) {
  if (!Number.isFinite(value)) return '0';
  const amount = Math.max(0, Math.trunc(value));
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 1 : 2).replace(/\.0+$/, '')}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return amount.toLocaleString();
}
function formatInteger(value: number) { return Math.max(0, Math.trunc(Number(value) || 0)).toLocaleString(); }
function formatUsageTime(value: number) {
  try { return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return 'recently'; }
}
