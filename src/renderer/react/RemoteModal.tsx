import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { RemoteInvite, RemoteStatus } from '../types';

export function RemoteModal({ onClose, onError }: { onClose: () => void; onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<RemoteStatus>({});
  const [pairing, setPairing] = useState<RemoteInvite | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const applyPairing = useCallback((value: RemoteInvite | null | undefined) => {
    if (!value?.url) return;
    setPairing(value);
    setNote('');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await window.cuppet.remote.status();
      setStatus(next);
      if (next.deviceConnected || next.activeDevice) {
        setPairing(null);
        setQrCode('');
        setNote('');
      } else if (next.setup?.url) {
        applyPairing(next.setup);
      }
      return next;
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      onError(error);
      return null;
    }
  }, [applyPairing, onError]);

  const preparePairing = useCallback(async () => {
    setBusy(true);
    try {
      const current = await window.cuppet.remote.status();
      setStatus(current);
      if (current.deviceConnected || current.activeDevice) {
        setPairing(null);
        setQrCode('');
        setNote('');
        return;
      }

      if (current.setup?.url) applyPairing(current.setup);
      if (current.starting) {
        if (!current.setup?.url) setNote('Preparing pairing…');
        return;
      }

      setNote('Preparing pairing…');
      if (current.running) {
        applyPairing(await window.cuppet.remote.invite('trusted'));
      } else {
        const result = await window.cuppet.remote.start({ setup: true, createInvite: true });
        if (result?.status) setStatus(result.status);
        applyPairing(result?.invite);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      onError(error);
    } finally {
      setBusy(false);
    }
  }, [applyPairing, onError]);

  useEffect(() => {
    void preparePairing();
    return window.cuppet.onEvent((event) => {
      if (event?.type === 'remote.setup') {
        const setup = event.setup ?? {};
        if (typeof setup.url === 'string' && setup.url) applyPairing({ url: setup.url, code: setup.code, expiresAt: typeof setup.expiresAt === 'string' ? Date.parse(setup.expiresAt) : setup.expiresAt });
      }
      if (event?.type === 'remote.invite') applyPairing(event.invite ?? null);
      if (event?.type === 'remote.started' || event?.type === 'remote.stopped' || event?.type === 'remote.device') void refresh();
    });
  }, [applyPairing, preparePairing, refresh]);

  useEffect(() => {
    let cancelled = false;
    setQrCode('');
    if (!pairing?.url) return () => { cancelled = true; };
    void QRCode.toDataURL(pairing.url, { width: 232, margin: 1, errorCorrectionLevel: 'M' })
      .then((value) => { if (!cancelled) setQrCode(value); })
      .catch((error) => { if (!cancelled) { setNote(error instanceof Error ? error.message : String(error)); onError(error); } });
    return () => { cancelled = true; };
  }, [onError, pairing?.url]);

  const stop = async () => {
    setBusy(true);
    try {
      await window.cuppet.remote.stop();
      setStatus({});
      setPairing(null);
      setQrCode('');
      setNote('');
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      onError(error);
      setBusy(false);
      return;
    }
    setBusy(false);
    void preparePairing();
  };

  const activeDevice = status.activeDevice ?? status.activeDevices?.[0] ?? null;
  const connected = Boolean(status.deviceConnected || activeDevice);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-dialog remote-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2 id="remote-title">Remote</h2><p>{connected ? 'Your Cuppet session is available on this device.' : 'Scan to pair this computer with Cuppet on your device.'}</p></div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {connected ? (
          <div className="remote-active-session">
            <div className="remote-active-indicator" aria-hidden="true" />
            <div className="remote-active-copy">
              <span>Active remote session</span>
              <strong>Connected to {activeDevice?.name || 'your device'}</strong>
            </div>
            <button type="button" className="ghost-button remote-stop-button" disabled={busy} onClick={() => void stop()}>Stop</button>
          </div>
        ) : (
          <div className="remote-pairing">
            <div className="remote-qr-frame" aria-label="Remote pairing QR code">
              {qrCode ? <img src={qrCode} alt="Scan this QR code with Cuppet to pair this computer" /> : <div className="remote-qr-loading">{busy || status.starting ? 'Preparing QR…' : 'QR unavailable'}</div>}
            </div>
            <div className="remote-pairing-copy">
              <strong>Scan with Cuppet</strong>
              <span>Open Remote on your device and scan this code.</span>
              {pairing?.code && <code>{pairing.code}</code>}
              {pairing?.expiresAt && Number.isFinite(pairing.expiresAt) && <small>Expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
            </div>
          </div>
        )}

        {note && <div className="settings-note remote-note">{note}</div>}
      </section>
    </div>
  );
}
