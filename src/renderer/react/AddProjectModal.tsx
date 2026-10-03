import { useState } from 'react';
import type { Project } from '../types';
import { SelectControl } from './SelectControl';

export function AddProjectModal({ onClose, onAdded, onError }: { onClose: () => void; onAdded: (project: Project) => void | Promise<void>; onError: (error: unknown) => void }) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('local');
  const [localPath, setLocalPath] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true);
    setNote(message);
    try { await action(); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const chooseFolder = () => run(async () => {
    const path = await window.cuppet.native.chooseFolder({ title: 'Choose project folder', buttonLabel: 'Select folder' });
    if (path) setLocalPath(path);
  });

  const addLocal = () => run(async () => {
    if (!localPath.trim()) throw new Error('Enter a project folder path.');
    const project = await window.cuppet.projects.addLocal({ path: localPath.trim(), name });
    await onAdded(project);
  });

  const cloneUrl = () => run(async () => {
    if (!url.trim()) throw new Error('Enter a GitHub repository URL.');
    const destinationParent = await window.cuppet.native.chooseFolder({ title: 'Choose clone destination', buttonLabel: 'Clone here' });
    if (!destinationParent) return;
    const project = await window.cuppet.projects.cloneUrl({ url: url.trim(), destinationParent, name });
    await onAdded(project);
  }, 'Cloning repository…');

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 id="add-project-title">Add project</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (!busy) void (source === 'local' ? addLocal() : cloneUrl()); }}>
          <ul className="add-project-list">
            <li className="add-project-row">
              <label htmlFor="project-name">Name</label>
              <input id="project-name" type="text" placeholder="Project name (optional)" value={name} disabled={busy} autoFocus onChange={(event) => setName(event.target.value)} />
            </li>
            <li className="add-project-row">
              <span>Source</span>
              <div className="project-source-fields">
                <SelectControl
                  value={source}
                  onChange={(value) => { setSource(value); setNote(''); }}
                  ariaLabel="Select the source"
                  disabled={busy}
                  options={[
                    { value: 'local', label: 'Local' },
                    { value: 'github', label: 'GitHub' },
                  ]}
                />
                {source === 'local' ? (
                  <div className="inline-row">
                    <input type="text" aria-label="Local folder path" placeholder="/path/to/project" value={localPath} disabled={busy} onChange={(event) => setLocalPath(event.target.value)} />
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => void chooseFolder()}>Browse</button>
                  </div>
                ) : (
                  <input type="text" aria-label="GitHub repository URL" placeholder="https://github.com/owner/repo.git" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
                )}
              </div>
            </li>
          </ul>
          {note && <div className="dialog-note" role="status">{note}</div>}
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !(source === 'local' ? localPath.trim() : url.trim())}>Add project</button>
          </div>
        </form>
      </section>
    </div>
  );
}
