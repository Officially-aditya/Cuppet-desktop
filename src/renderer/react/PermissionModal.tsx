import { useState } from 'react';
import type { PermissionRequest } from '../types';

export function PermissionModal({ request, onResolve }: { request: PermissionRequest; onResolve: (reply: 'once' | 'always' | 'reject', enableAuto?: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    setBusy(true);
    try { await onResolve(reply, enableAuto); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop modal-priority" role="presentation">
      <section className="react-modal settings-dialog" role="alertdialog" aria-modal="true" aria-labelledby="permission-title">
        <div className="dialog-header"><div><h2 id="permission-title">Tool permission</h2><p>Cuppet is waiting for approval before the model can continue.</p></div></div>
        <div className="dialog-note">{request.action || 'tool'} · session {String(request.sessionId || '').slice(0, 24)}</div>
        <p>{request.description || 'The model requested a protected tool operation.'}</p>
        <pre className="permission-resources">{(request.resources || []).map((value) => `• ${value}`).join('\n') || 'No resource details were supplied.'}</pre>
        <p className="settings-note">{request.autoEligible ? 'Guarded auto only approves ordinary workspace reads/edits/writes. Sensitive files, shell commands, and path escapes still require approval.' : 'This request is not eligible for guarded auto approval.'}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void run('reject')}>Reject</button>
          {request.autoEligible && <button type="button" className="ghost-button" disabled={busy} onClick={() => void run('once', true)}>Enable guarded auto</button>}
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void run('always')}>Always this exact request</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void run('once')}>Allow once</button>
        </div>
      </section>
    </div>
  );
}
