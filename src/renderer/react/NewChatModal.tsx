import { useState } from 'react';
import type { Project } from '../types';

export function NewChatModal({ projects, selectedProjectId, onClose, onStart }: { projects: Project[]; selectedProjectId: string | null; onClose: () => void; onStart: (projectId: string | null) => void }) {
  const [projectId, setProjectId] = useState(selectedProjectId ?? '');
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><h2 id="new-chat-title">New chat</h2><p>Choose a project or start a general chat without filesystem access.</p></div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <label>Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} autoFocus>
            <option value="">General chat</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.missing ? ' (folder missing)' : ''}</option>)}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-button" onClick={() => onStart(projectId || null)}>Start chat</button>
        </div>
      </section>
    </div>
  );
}
