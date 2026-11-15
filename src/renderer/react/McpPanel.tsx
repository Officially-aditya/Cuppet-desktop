import { useCallback, useEffect, useState } from 'react';
import type { McpImportResult, McpServer, McpSettings } from '../types';
import {
  cleanErrorMessage,
  commandLine,
  emptyForm,
  formFromServer,
  mergeStatuses,
  newEnvRow,
  payloadFromForm,
  statusPresentation,
  type McpForm,
} from './mcp-form';

export function McpPanel() {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [form, setForm] = useState<McpForm | null>(null);
  const [formError, setFormError] = useState('');
  const [importText, setImportText] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<McpImportResult | null>(null);
  const [importError, setImportError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSettings(await window.cuppet.mcp.list()); }
    catch (error) { setNote(cleanErrorMessage(error)); }
  }, []);

  useEffect(() => {
    void refresh();
    // Server state changes (starting, running, crashed, tool list changed) arrive as runtime events.
    return window.cuppet.onEvent((event) => {
      if (event?.type === 'integration.mcp.updated' && Array.isArray(event.servers)) {
        setSettings((current) => (current ? { ...current, servers: mergeStatuses(current.servers, event.servers) } : current));
      }
    });
  }, [refresh]);

  const act = async (key: string, action: () => Promise<McpSettings>, done = '') => {
    setBusy(key);
    setNote('');
    try {
      setSettings(await action());
      if (done) setNote(done);
    } catch (error) {
      setNote(cleanErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy('save');
    setFormError('');
    try {
      setSettings(await window.cuppet.mcp.save(payloadFromForm(form)));
      setNote(`${form.name.trim()} saved.`);
      setForm(null);
    } catch (error) {
      setFormError(cleanErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (importText === null) return;
    setBusy('import');
    setImportError('');
    setImportResult(null);
    try {
      const result = await window.cuppet.mcp.import({ json: importText });
      setSettings(result.settings);
      setImportResult(result);
      if (result.imported.length) setImportText('');
    } catch (error) {
      setImportError(cleanErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const openForm = (next: McpForm) => { setImportText(null); setFormError(''); setNote(''); setForm(next); };
  const openImport = () => { setForm(null); setImportResult(null); setImportError(''); setNote(''); setImportText(''); };
  const patchForm = (patch: Partial<McpForm>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const servers = settings?.servers ?? [];
  const atLimit = Boolean(settings && servers.length >= settings.limit);
  const encryptionOff = settings?.encryptionAvailable === false;

  return <div className="general-settings-stack mcp-settings">
    <div className="settings-card general-settings-card">
      <div className="settings-card-heading">
        <div>
          <h3>MCP servers</h3>
          <p>Model Context Protocol servers give Cuppet extra tools, such as databases, issue trackers or documentation. Cuppet asks before every tool call.</p>
        </div>
        <div className="mcp-heading-actions">
          <button type="button" className="ghost-button settings-action-button" disabled={!settings || atLimit} onClick={openImport}>Import JSON</button>
          <button type="button" className="primary-button settings-action-button" disabled={!settings || atLimit} onClick={() => openForm(emptyForm())}>Add server</button>
        </div>
      </div>

      {settings === null ? <div className="settings-empty">Loading…</div>
        : servers.length === 0 ? <div className="settings-empty">No MCP servers yet. Add one, or import the <code>mcpServers</code> JSON from a server's documentation.</div>
        : servers.map((server) => <ServerRow
          key={server.id}
          server={server}
          busy={busy === server.id}
          confirming={confirmRemove === server.id}
          onToggle={() => void act(server.id, () => window.cuppet.mcp.setEnabled(server.id, !server.enabled))}
          onRestart={() => void act(server.id, () => window.cuppet.mcp.restart(server.id), `${server.name} restarted.`)}
          onEdit={() => openForm(formFromServer(server))}
          onAskRemove={() => setConfirmRemove(server.id)}
          onCancelRemove={() => setConfirmRemove(null)}
          onRemove={() => { setConfirmRemove(null); void act(server.id, () => window.cuppet.mcp.remove(server.id), `${server.name} removed.`); }}
        />)}

      {note && <p className="general-settings-note" role="status">{note}</p>}
      <p className="general-settings-note">MCP servers are programs that run on this computer with your permissions, outside the command sandbox. Only add servers you trust. Plan mode blocks tools that do not declare themselves read-only.</p>
      {encryptionOff && <p className="general-settings-note mcp-error" role="note">Environment variables can't be saved because OS credential encryption is unavailable{settings?.encryptionUnavailableReason ? `: ${settings.encryptionUnavailableReason}` : ''}. Cuppet never stores them in plaintext.</p>}
    </div>

    {form && <div className="settings-card general-settings-card mcp-form-card">
      <div className="settings-card-heading"><div><h3>{form.id ? 'Edit server' : 'Add server'}</h3><p>Cuppet runs this command and talks to it over standard input and output.</p></div></div>
      <div className="provider-simple-form">
        <label>Name<input type="text" autoComplete="off" spellCheck={false} value={form.name} placeholder="filesystem" onChange={(event) => patchForm({ name: event.target.value })} /></label>
        <label>Command<input type="text" autoComplete="off" spellCheck={false} value={form.command} placeholder="npx" onChange={(event) => patchForm({ command: event.target.value })} /></label>
        <label>Arguments (one per line)<textarea className="mcp-args" rows={4} spellCheck={false} value={form.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'} onChange={(event) => patchForm({ args: event.target.value })} /></label>
        <fieldset className="mcp-env">
          <legend>Environment variables</legend>
          {form.env.length === 0 && <span className="mcp-env-empty">None. Use these for API keys and tokens; values are stored encrypted and are never shown again.</span>}
          {form.env.map((row) => <div className="mcp-env-row" key={row.key}>
            <input aria-label="Variable name" type="text" autoComplete="off" spellCheck={false} readOnly={row.saved} value={row.name} placeholder="NAME" onChange={(event) => patchForm({ env: form.env.map((item) => (item.key === row.key ? { ...item, name: event.target.value } : item)) })} />
            <input aria-label={`Value for ${row.name || 'variable'}`} type="password" autoComplete="new-password" value={row.value} placeholder={row.saved ? 'Saved · leave blank to keep' : 'Value'} onChange={(event) => patchForm({ env: form.env.map((item) => (item.key === row.key ? { ...item, value: event.target.value } : item)) })} />
            <button type="button" className="ghost-button settings-action-button" aria-label={`Remove ${row.name || 'variable'}`} onClick={() => patchForm({ env: form.env.filter((item) => item.key !== row.key) })}>Remove</button>
          </div>)}
          <button type="button" className="ghost-button settings-action-button mcp-add-env" disabled={encryptionOff || form.env.length >= 64} onClick={() => patchForm({ env: [...form.env, newEnvRow()] })}>Add variable</button>
        </fieldset>
      </div>
      {formError && <p className="general-settings-note mcp-error" role="alert">{formError}</p>}
      <div className="settings-form-footer">
        <div className="dialog-actions">
          <button type="button" className="ghost-button settings-action-button" disabled={busy === 'save'} onClick={() => setForm(null)}>Cancel</button>
          <button type="button" className="primary-button settings-action-button" disabled={busy === 'save' || !form.name.trim() || !form.command.trim()} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      {form.id && <p className="general-settings-note">The server restarts when its command, arguments or environment change.</p>}
    </div>}

    {importText !== null && <div className="settings-card general-settings-card mcp-form-card">
      <div className="settings-card-heading"><div><h3>Import from JSON</h3><p>Paste the <code>mcpServers</code> block from a server's documentation, Claude Desktop or Cursor. Imported servers start disabled so you can review each command first.</p></div></div>
      <div className="provider-simple-form">
        <label>MCP server JSON<textarea className="mcp-args" rows={8} spellCheck={false} value={importText} placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "package"] }\n  }\n}'} onChange={(event) => setImportText(event.target.value)} /></label>
      </div>
      {importError && <p className="general-settings-note mcp-error" role="alert">{importError}</p>}
      {importResult && <div className="general-settings-note" role="status">
        {importResult.imported.length > 0 && <p>Imported {importResult.imported.join(', ')}. Review and enable {importResult.imported.length === 1 ? 'it' : 'them'} in the list above.</p>}
        {importResult.skipped.map((item) => <p key={item.name} className="mcp-error">Skipped {item.name}: {item.reason}</p>)}
      </div>}
      <div className="settings-form-footer">
        <div className="dialog-actions">
          <button type="button" className="ghost-button settings-action-button" disabled={busy === 'import'} onClick={() => { setImportText(null); setImportResult(null); }}>Close</button>
          <button type="button" className="primary-button settings-action-button" disabled={busy === 'import' || !importText.trim()} onClick={() => void runImport()}>{busy === 'import' ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>}
  </div>;
}

type RowProps = {
  server: McpServer;
  busy: boolean;
  confirming: boolean;
  onToggle: () => void;
  onRestart: () => void;
  onEdit: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
};

function ServerRow({ server, busy, confirming, onToggle, onRestart, onEdit, onAskRemove, onCancelRemove, onRemove }: RowProps) {
  const presentation = statusPresentation(server);
  const tools = server.status?.state === 'ready' ? server.status.tools : [];
  return <div className="settings-row general-settings-row integration-row mcp-server-row">
    <div className="mcp-server-copy">
      <div className="integration-title-row">
        <strong>{server.name}</strong>
        <span className={`settings-status-pill compact${presentation.tone === 'ready' ? '' : ' muted'}${presentation.tone === 'warning' ? ' mcp-pill-error' : ''}`}>{presentation.label}</span>
      </div>
      <code className="mcp-command" title={commandLine(server)}>{commandLine(server)}</code>
      {presentation.detail && <span className={`mcp-detail${presentation.tone === 'warning' ? ' mcp-error' : ''}`}>{presentation.detail}</span>}
      {server.envKeys.length > 0 && <span>Environment: {server.envKeys.join(', ')}</span>}
      {tools.length > 0 && <details className="mcp-tools">
        <summary>{tools.length === 1 ? '1 tool' : `${tools.length} tools`}</summary>
        <ul>{tools.map((tool) => <li key={tool.name}>{tool.name}{tool.readOnly ? ' · read-only' : ''}</li>)}</ul>
      </details>}
    </div>
    <div className="integration-actions mcp-actions">
      {confirming ? <>
        <button type="button" className="ghost-button settings-action-button" onClick={onCancelRemove}>Cancel</button>
        <button type="button" className="primary-button settings-action-button" disabled={busy} onClick={onRemove}>Remove {server.name}</button>
      </> : <>
        <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={onToggle}>{server.enabled ? 'Disable' : 'Enable'}</button>
        {server.enabled && <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={onRestart}>Restart</button>}
        <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={onEdit}>Edit</button>
        <button type="button" className="ghost-button settings-action-button" disabled={busy} onClick={onAskRemove}>Remove</button>
      </>}
    </div>
  </div>;
}
