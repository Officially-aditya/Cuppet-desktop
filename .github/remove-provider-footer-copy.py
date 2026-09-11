from pathlib import Path

path = Path('src/renderer/react/SettingsModal.tsx')
text = path.read_text()
old = '''      <div className="settings-form-footer">
        <div className="settings-note">{note || (current?.encryptionAvailable ? 'Changes apply immediately. API keys are encrypted with the operating system credential store.' : current?.encryptionUnavailableReason || 'Changes apply immediately. Secure credential storage is unavailable.')}</div>
        <div className="dialog-actions"><button type="button" className="ghost-button settings-action-button" disabled={busy || !selected} onClick={() => void onReset()}>{busy ? 'Applying…' : 'Reset'}</button></div>
      </div>
'''
new = '''      <div className="settings-form-footer">
        <div className="dialog-actions"><button type="button" className="ghost-button settings-action-button" disabled={busy || !selected} onClick={() => void onReset()}>{busy ? 'Applying…' : 'Reset'}</button></div>
      </div>
'''
if text.count(old) != 1:
    raise SystemExit(f'expected footer block once, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
