import { useEffect, useState } from 'react';
import type { Project, SearchResult } from '../types';

export function SearchModal({ projects, onClose, onOpen, onChanged, onError }: { projects: Project[]; onClose: () => void; onOpen: (sessionId: string) => void | Promise<void>; onChanged: () => void | Promise<unknown>; onError: (error: unknown) => void }) {
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState('Search local conversation titles and message text.');

  useEffect(() => {
    const value = query.trim();
    if (!value) { setResults([]); setState('Search local conversation titles and message text.'); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setState('Searching…');
      void window.cuppet.sessions.search(value, { limit: 60, includeArchived }).then((items) => {
        if (cancelled) return;
        setResults(items);
        setSelected(0);
        setState(items.length ? '' : 'No matching local conversations found.');
      }).catch((error) => {
        if (cancelled) return;
        setResults([]);
        setState(error instanceof Error ? error.message : String(error));
        onError(error);
      });
    }, 110);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [includeArchived, onError, query]);

  const openResult = async (result: SearchResult) => {
    try {
      if (result.archivedAt) {
        await window.cuppet.sessions.restore(result.sessionId);
        await onChanged();
      }
      await onOpen(result.sessionId);
      if (result.kind === 'message' && result.itemId) focusMessage(result.itemId);
    } catch (error) { onError(error); }
  };

  const restore = async (result: SearchResult) => {
    try {
      await window.cuppet.sessions.restore(result.sessionId);
      await onChanged();
      setResults((current) => current.map((item) => item.sessionId === result.sessionId ? { ...item, archivedAt: null } : item));
    } catch (error) { onError(error); }
  };

  return (
    <div className="modal-backdrop search-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="react-modal search-dialog react-search-dialog" role="dialog" aria-modal="true" aria-label="Search chats" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-shell">
          <div className="search-header">
            <div className="search-input-wrap"><span aria-hidden="true">⌕</span><input autoFocus className="search-input" type="search" maxLength={512} autoComplete="off" placeholder="Search chats and messages…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setSelected((value) => (value + 1) % results.length); }
              else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setSelected((value) => (value - 1 + results.length) % results.length); }
              else if (event.key === 'Enter' && results[selected]) { event.preventDefault(); void openResult(results[selected]); }
              else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            }} /></div>
            <button className="search-close" type="button" aria-label="Close" onClick={onClose}>×</button>
          </div>
          <div className="search-options"><label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Include archived</label><span className="search-shortcut">↑↓ navigate · Enter open</span></div>
          <div className="search-results">
            {state && <div className="search-state">{state}</div>}
            {results.map((result, index) => {
              const project = projects.find((item) => item.id === result.projectId);
              return (
                <article key={`${result.sessionId}-${result.itemId || result.kind || index}`} className={`search-result${index === selected ? ' selected' : ''}`}>
                  <button type="button" className="search-result-main" onClick={() => void openResult(result)}>
                    <div className="search-result-title">{result.title || 'New chat'}{result.archivedAt ? <span className="archive-badge">Archived</span> : null}</div>
                    <div className="search-result-meta">{[project?.name || (result.projectId ? 'Project' : 'General'), result.kind === 'message' ? `${result.role || 'message'}${result.sequence ? ` · #${result.sequence}` : ''}` : 'chat title'].join(' · ')}</div>
                    <div className="search-result-snippet">{result.snippet || (result.kind === 'session' ? 'Title match' : '')}</div>
                  </button>
                  {result.archivedAt ? <button type="button" className="search-result-action" onClick={() => void restore(result)}>Restore</button> : null}
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function focusMessage(messageId: string) {
  const safeId = String(messageId).slice(0, 256);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const selector = `[data-message-id="${cssEscape(safeId)}"]`;
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: document.body.classList.contains('reduce-motion') ? 'auto' : 'smooth' });
    node.classList.remove('search-hit');
    void node.offsetWidth;
    node.classList.add('search-hit');
  }));
}

function cssEscape(value: string) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
