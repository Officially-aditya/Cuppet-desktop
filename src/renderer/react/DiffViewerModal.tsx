import { useCallback, useEffect, useMemo, useState } from 'react';

export type DiffFile = {
  path: string;
  status?: 'modified' | 'added' | 'deleted';
  diff?: string;
};

type Props = {
  files: DiffFile[];
  rawDiff?: string;
  projectId?: string | null;
  onClose: () => void;
};

type ParsedDiffLine = {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  oldNum?: number;
  newNum?: number;
  text: string;
};

type ParsedFileDiff = {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  lines: ParsedDiffLine[];
  additions: number;
  deletions: number;
  raw: string;
};

export function DiffViewerModal({ files, rawDiff = '', projectId, onClose }: Props) {
  const parsedFiles = useMemo(() => parseDiff(rawDiff, files), [rawDiff, files]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [editor, setEditor] = useState<{ name: string; icon: string | null } | null>(null);

  const activeFile: ParsedFileDiff | null = parsedFiles[selectedIndex] ?? parsedFiles[0] ?? null;

  const totalAdditions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.additions, 0), [parsedFiles]);
  const totalDeletions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.deletions, 0), [parsedFiles]);

  useEffect(() => {
    let cancelled = false;
    setEditor(null);
    const lookup = window.cuppet.native.projectFileEditor;
    if (projectId && activeFile?.path && lookup) {
      void lookup(projectId, activeFile.path).then((info) => {
        if (!cancelled) setEditor(info);
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [projectId, activeFile?.path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'j') {
        if (parsedFiles.length > 1) {
          event.preventDefault();
          setSelectedIndex((current) => (current + 1) % parsedFiles.length);
        }
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'k') {
        if (parsedFiles.length > 1) {
          event.preventDefault();
          setSelectedIndex((current) => (current - 1 + parsedFiles.length) % parsedFiles.length);
        }
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, parsedFiles.length]);

  const copyDiff = useCallback(async () => {
    const text = activeFile?.raw || rawDiff || files.map((file) => file.path).join('\n');
    if (!text) return;
    try {
      await window.cuppet.native.copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }, [activeFile, files, rawDiff]);

  const openInEditor = useCallback(() => {
    if (!activeFile?.path || !projectId) return;
    void (window.cuppet.native as any).openProjectFile(projectId, activeFile.path).catch(() => undefined);
  }, [activeFile, projectId]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="diff-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Code changes diff viewer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="diff-modal-header">
          <div className="diff-modal-title-group">
            <h2 className="diff-modal-title">Code changes</h2>
            <div className="diff-stats-badge" title="Total line changes">
              <span>{parsedFiles.length} {parsedFiles.length === 1 ? 'file' : 'files'}</span>
              {totalAdditions > 0 && <span className="diff-stat-add">+{totalAdditions}</span>}
              {totalDeletions > 0 && <span className="diff-stat-del">−{totalDeletions}</span>}
            </div>
          </div>

          <div className="diff-modal-actions">
            {projectId && activeFile && (
              <button
                type="button"
                className="diff-action-button"
                title={`Open in ${editor?.name || 'default editor'}`}
                aria-label="Open in editor"
                onClick={openInEditor}
              >
                {editor?.icon ? <img src={editor.icon} alt="" aria-hidden="true" /> : <CodeIcon />}
              </button>
            )}
            <button
              type="button"
              className={`diff-action-button${copied ? ' copied' : ''}`}
              title={copied ? 'Copied!' : 'Copy diff to clipboard'}
              aria-label={copied ? 'Copied!' : 'Copy diff'}
              onClick={() => void copyDiff()}
            >
              <span className="copy-icon-wrapper" aria-hidden="true">
                {copied ? <CheckIcon /> : <CopyIcon />}
              </span>
            </button>
            <button
              type="button"
              className="diff-action-button"
              title="Close diff viewer"
              aria-label="Close diff viewer"
              onClick={onClose}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="diff-modal-body">
          <aside className="diff-files-sidebar" aria-label="Changed files">
            <div className="diff-files-sidebar-title">Files changed</div>
            {parsedFiles.map((file, index) => (
              <button
                key={file.path}
                type="button"
                className={`diff-file-item${file === activeFile ? ' active' : ''}`}
                aria-current={file === activeFile ? 'true' : undefined}
                onClick={() => setSelectedIndex(index)}
              >
                <span className={`diff-file-status-badge ${file.status}`}>
                  {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
                </span>
                <span className="diff-file-name" title={file.path}>
                  {file.path}
                </span>
              </button>
            ))}
          </aside>

          <section className="diff-content-pane">
            {activeFile ? (
              <div className="diff-file-panel" key={activeFile.path}>
                <div className="diff-file-header">
                  <span className="diff-file-heading">
                    <span className={`diff-file-status-badge ${activeFile.status}`}>
                      {activeFile.status === 'added' ? 'A' : activeFile.status === 'deleted' ? 'D' : 'M'}
                    </span>
                    <span className="diff-file-path">{activeFile.path}</span>
                  </span>
                  <div className="diff-stats-badge">
                    {activeFile.additions > 0 && <span className="diff-stat-add">+{activeFile.additions}</span>}
                    {activeFile.deletions > 0 && <span className="diff-stat-del">−{activeFile.deletions}</span>}
                  </div>
                </div>

                {activeFile.lines.length === 0 ? (
                  <EmptyFileDiffState file={activeFile} />
                ) : (
                  <div className="diff-lines-container">
                    {activeFile.lines.map((line, lineIndex) => {
                      if (line.type === 'hunk') {
                        const formatted = formatHunkText(line.text);
                        if (!formatted) return null;
                        return (
                          <div key={lineIndex} className="diff-line hunk">
                            <div className="diff-line-gutter" aria-hidden="true" />
                            <span className="diff-line-sign" aria-hidden="true">⋯</span>
                            <span className="diff-line-text">{formatted}</span>
                          </div>
                        );
                      }
                      return (
                        <div key={lineIndex} className={`diff-line ${line.type}`}>
                          <div className="diff-line-gutter" aria-hidden="true">
                            <span className="diff-line-num-old">{line.oldNum ?? ''}</span>
                            <span className="diff-line-num-new">{line.newNum ?? ''}</span>
                          </div>
                          <span className="diff-line-sign" aria-hidden="true">
                            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ''}
                          </span>
                          <span className="diff-line-text">{line.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="diff-empty-state">
                <span>Select a file to view changes.</span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyFileDiffState({ file }: { file: ParsedFileDiff }) {
  return (
    <div className="diff-empty-state">
      <div className="diff-empty-copy">
        <div className="diff-empty-title">
          {file.status === 'added' ? 'New file created' : file.status === 'deleted' ? 'File deleted' : 'File modified'}
        </div>
        <p className="diff-empty-description">
          {file.raw
            ? 'Detailed unified diff lines were not formatted, but raw content is shown below.'
            : 'This file was modified in this turn. You can open it in your code editor to view the full file.'}
        </p>
        {file.raw && (
          <div className="diff-raw-content">
            <pre>{file.raw}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function formatHunkText(text: string): string | null {
  if (!text) return null;
  // Match standard hunk header: @@ -A,B +C,D @@ context
  const match = text.match(/^@@\s*-(?:\d+)(?:,\d+)?\s*\+(?:\d+)(?:,\d+)?\s*@@(?:\s*(.+))?$/);
  if (match) return text;
  // If it's something like "@@ edit @@" or "@@ replace_node @@" or "@@ -1 +1 @@"
  const clean = text.replace(/^@@\s*|\s*@@$/g, '').trim();
  if (!clean || clean === '-1 +1' || clean === 'edit' || clean === 'apply' || clean === 'checked whole-file projection' || /^-?\d+.*$/.test(clean)) {
    return null;
  }
  return clean;
}

function parseDiff(rawDiff: string, fileList: DiffFile[]): ParsedFileDiff[] {
  const fileMap = new Map<string, ParsedFileDiff>();
  const raw = rawDiff.trim();

  if (raw) {
    const chunks = raw.split(/(?=^--- )/m);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const pathMatch = chunk.match(/--- (?:[ab]\/)?(\S+)[^\n\r]*[\r\n]+\+\+\+ (?:[ab]\/)?(\S+)/);
      const rawPath = pathMatch ? (pathMatch[2] === '/dev/null' ? pathMatch[1] : pathMatch[2]) : '';
      const filePath = rawPath.replace(/^[ab]\//, '');
      if (!filePath) continue;

      const lines = chunk.split(/\r?\n/);
      const parsedLines: ParsedDiffLine[] = [];
      let oldNum = 0;
      let newNum = 0;
      let adds = 0;
      let dels = 0;

      for (const line of lines) {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (match) {
            oldNum = parseInt(match[1], 10);
            newNum = parseInt(match[2], 10);
          } else {
            if (oldNum === 0) oldNum = 1;
            if (newNum === 0) newNum = 1;
          }
          parsedLines.push({ type: 'hunk', text: line });
        } else if (line.startsWith('+')) {
          adds++;
          parsedLines.push({ type: 'add', newNum: newNum++, text: line.slice(1) });
        } else if (line.startsWith('-')) {
          dels++;
          parsedLines.push({ type: 'del', oldNum: oldNum++, text: line.slice(1) });
        } else if (line.startsWith(' ')) {
          parsedLines.push({ type: 'ctx', oldNum: oldNum++, newNum: newNum++, text: line.slice(1) });
        }
      }

      const chunkStatus = dels > 0 && adds === 0 ? 'deleted' : adds > 0 && dels === 0 ? 'added' : 'modified';

      if (fileMap.has(filePath)) {
        const existing = fileMap.get(filePath)!;
        existing.lines.push(...parsedLines);
        existing.additions += adds;
        existing.deletions += dels;
        existing.raw += '\n' + chunk;
        if (existing.status !== 'modified' && chunkStatus !== existing.status) {
          existing.status = 'modified';
        }
      } else {
        fileMap.set(filePath, {
          path: filePath,
          status: chunkStatus,
          lines: parsedLines,
          additions: adds,
          deletions: dels,
          raw: chunk,
        });
      }
    }
  }

  for (const item of fileList) {
    if (!item.path) continue;
    const existing = fileMap.get(item.path);
    if (!existing) {
      if (item.diff) {
        const sub = parseDiff(item.diff, []);
        if (sub.length > 0 && sub[0].lines.length > 0) {
          fileMap.set(item.path, {
            ...sub[0],
            path: item.path,
            status: item.status || sub[0].status,
          });
          continue;
        }
      }
      fileMap.set(item.path, {
        path: item.path,
        status: item.status || 'modified',
        lines: [],
        additions: 0,
        deletions: 0,
        raw: item.diff || '',
      });
    } else if (item.status && item.status !== 'modified' && existing.status === 'modified' && existing.lines.length === 0) {
      existing.status = item.status;
    }
  }

  return Array.from(fileMap.values());
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4 2 8l3.5 4M10.5 4l3.5 4-3.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CopyIcon({ className = 'copy-icon-svg copy' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3.5A1.5 1.5 0 0 1 3 2h5.5A1.5 1.5 0 0 1 10 3.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ className = 'copy-icon-svg check' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
