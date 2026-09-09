import { useState } from 'react';
import type { Project } from '../types';

type GithubRepo = { nameWithOwner: string; isPrivate?: boolean; defaultBranch?: string };

export function AddProjectModal({ onClose, onAdded, onError }: { onClose: () => void; onAdded: (project: Project) => void | Promise<void>; onError: (error: unknown) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true);
    setNote(message);
    try { await action(); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); onError(error); }
    finally { setBusy(false); }
  };

  const addLocal = () => run(async () => {
    const path = await window.cuppet.native.chooseFolder({ title: 'Choose project folder', buttonLabel: 'Add project' });
    if (!path) return;
    const project = await window.cuppet.projects.addLocal({ path, name });
    await onAdded(project);
  });

  const cloneUrl = () => run(async () => {
    if (!url.trim()) throw new Error('Enter a GitHub repository URL.');
    const destinationParent = await window.cuppet.native.chooseFolder({ title: 'Choose clone destination', buttonLabel: 'Clone here' });
    if (!destinationParent) return;
    const project = await window.cuppet.projects.cloneUrl({ url: url.trim(), destinationParent });
    await onAdded(project);
  }, 'Cloning repository…');

  const loadRepos = () => run(async () => {
    const values = await window.cuppet.projects.githubList(query);
    setRepos(values);
    setNote(values.length ? `${values.length} repositories available.` : 'No matching repositories found.');
  }, 'Loading repositories from existing GitHub CLI authentication…');

  const cloneRepo = (repo: GithubRepo) => run(async () => {
    const destinationParent = await window.cuppet.native.chooseFolder({ title: `Clone ${repo.nameWithOwner}`, buttonLabel: 'Clone here' });
    if (!destinationParent) return;
    const project = await window.cuppet.projects.githubClone({ nameWithOwner: repo.nameWithOwner, destinationParent });
    await onAdded(project);
  }, `Cloning ${repo.nameWithOwner}…`);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-dialog wide-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2 id="add-project-title">Add project</h2><p>Register a folder or clone an explicitly chosen GitHub repository.</p></div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="add-project-grid">
          <section className="project-method">
            <h3>Local folder</h3><p>Add an existing folder. Its Git root and origin are detected when present.</p>
            <input type="text" placeholder="Project name (optional)" value={name} onChange={(event) => setName(event.target.value)} />
            <button type="button" className="ghost-button" disabled={busy} onClick={() => void addLocal()}>Choose folder</button>
          </section>
          <section className="project-method">
            <h3>GitHub URL</h3><p>HTTPS and SSH github.com repository URLs are supported. Embedded credentials are rejected.</p>
            <input type="text" placeholder="https://github.com/owner/repo.git" value={url} onChange={(event) => setUrl(event.target.value)} />
            <button type="button" className="ghost-button" disabled={busy} onClick={() => void cloneUrl()}>Choose destination & clone</button>
          </section>
          <section className="project-method picker-method">
            <h3>GitHub repositories</h3><p>Uses an existing authenticated GitHub CLI session; no second OAuth app is created.</p>
            <div className="inline-row">
              <input type="search" placeholder="Filter repositories" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void loadRepos(); } }} />
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void loadRepos()}>Load</button>
            </div>
            <div className="repo-results">
              {repos.map((repo) => <button type="button" className="repo-result react-repo-result" key={repo.nameWithOwner} disabled={busy} onClick={() => void cloneRepo(repo)}><strong>{repo.nameWithOwner}</strong><span>{[repo.isPrivate ? 'Private' : 'Public', repo.defaultBranch].filter(Boolean).join(' · ')}</span></button>)}
            </div>
          </section>
        </div>
        {note && <div className="dialog-note">{note}</div>}
      </section>
    </div>
  );
}
