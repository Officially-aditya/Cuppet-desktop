import { useCallback, useEffect, useState } from 'react';
import type { RemoteDevice, RemoteInvite, RemoteStatus } from '../types';

export function RemoteModal({ onClose, onError }: { onClose: () => void; onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<RemoteStatus>({});
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [invite, setInvite] = useState<RemoteInvite | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([window.cuppet.remote.status(), window.cuppet.remote.devices()]);
      setStatus(nextStatus);
      setDevices(nextDevices ?? []);
      if (nextStatus.running && nextStatus.connected && note.startsWith('Open Cuppet')) setNote('');
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
  }, [note, onError]);

  useEffect(() => {
    void refresh();
    return window.cuppet.onEvent((event) => {
      if (event?.type === 'remote.setup') {
        const setup = event.setup ?? {};
        const code = setup.code ? `Code ${setup.code}` : 'Setup ready';
        setNote(setup.url ? `${code} · ${setup.url}` : code);
      }
      if (event?.type === 'remote.invite') setInvite(event.invite ?? null);
      if (event?.type === 'remote.started' || event?.type === 'remote.stopped') void refresh();
    });
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); await refresh(); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const start = () => run(async () => {
    setNote('Open Cuppet on your phone to link this computer…');
    const result = await window.cuppet.remote.start({ setup: true, createInvite: true });
    setInvite(result?.invite ?? null);
  });

  const stop = () => run(async () => {
    await window.cuppet.remote.stop();
    setInvite(null);
    setNote('');
  });

  const newCode = () => run(async () => setInvite(await window.cuppet.remote.invite('trusted')));

  const statusLabel = status.running ? (status.connected ? 'Connected' : 'Connecting…') : 'Off';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2 id="remote-title">Remote</h2><p>Control Cuppet from your signed-in Cuppet app.</p></div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="remote-simple">
          <div className="remote-simple-status">{statusLabel}</div>
          <div className="inline-row">
            {!status.running ? <button type="button" className="primary-button" disabled={busy} onClick={() => void start()}>Start remote</button> : <button type="button" className="ghost-button" disabled={busy} onClick={() => void stop()}>Stop</button>}
          </div>
          {note && <div className="settings-note">{note}</div>}
          {invite?.code && <div className="settings-note">Pairing code {invite.code} · expires {Number.isFinite(invite.expiresAt) ? new Date(invite.expiresAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}</div>}
          {(status.running || devices.length > 0) && <div className="remote-devices-wrap">
            <div className="remote-devices-header"><span>Paired devices</span>{status.running && <button type="button" className="text-button" disabled={busy} onClick={() => void newCode()}>New code</button>}</div>
            <div className="repo-results">
              {!devices.length ? <div className="settings-empty">No paired devices yet.</div> : devices.map((device) => <div className="repo-result" key={device.deviceId}><strong>{device.name || 'Cuppet device'}</strong><button type="button" className="text-button" disabled={busy} onClick={() => void run(async () => { await window.cuppet.remote.revoke(device.deviceId); })}>Revoke</button></div>)}
            </div>
          </div>}
        </div>
      </section>
    </div>
  );
}
