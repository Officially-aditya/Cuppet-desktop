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

  const activeFile: ParsedFileDiff | null = parsedFiles[selectedIndex] ?? parsedFiles[0] ?? null;

  const totalAdditions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.additions, 0), [parsedFiles]);
  const totalDeletions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.deletions, 0), [parsedFiles]);

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
                title="Open in external editor"
                onClick={openInEditor}
              >
                <CodeIcon />
                <span>Open in editor</span>
              </button>
            )}
            <button
              type="button"
              className="diff-action-button"
              title="Copy diff to clipboard"
              onClick={() => void copyDiff()}
            >
              <CopyIcon />
              <span>{copied ? 'Copied!' : 'Copy diff'}</span>
            </button>
            <button
              type="button"
              className="diff-close-button"
              aria-label="Close diff viewer"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        <div className="diff-modal-body">
          <aside className="diff-files-sidebar" aria-label="Modified files">
            <div className="diff-files-sidebar-title">Files changed</div>
            {parsedFiles.map((file, index) => (
              <button
                key={file.path}
                type="button"
                className={`diff-file-item${index === selectedIndex ? ' active' : ''}`}
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
              <>
                <div className="diff-file-header">
                  <span className="diff-file-path">{activeFile.path}</span>
                  <div className="diff-stats-badge">
                    {activeFile.additions > 0 && <span className="diff-stat-add">+{activeFile.additions}</span>}
                    {activeFile.deletions > 0 && <span className="diff-stat-del">−{activeFile.deletions}</span>}
                  </div>
                </div>

                <div className="diff-lines-container">
                  {activeFile.lines.length > 0 ? (
                    activeFile.lines.map((line, lineIndex) => (
                      <div key={lineIndex} className={`diff-line ${line.type}`}>
                        <div className="diff-line-gutter">
                          <span className="diff-line-num-old">{line.oldNum ?? ''}</span>
                          <span className="diff-line-num-new">{line.newNum ?? ''}</span>
                        </div>
                        <span className="diff-line-sign">
                          {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                        </span>
                        <span className="diff-line-text">{line.text}</span>
                      </div>
                    ))
                  ) : (
                    <div className="diff-empty-state">
                      <span>No line diff available for this file.</span>
                    </div>
                  )}
                </div>
              </>
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

function parseDiff(rawDiff: string, fileList: DiffFile[]): ParsedFileDiff[] {
  const result: ParsedFileDiff[] = [];
  const raw = rawDiff.trim();

  if (raw) {
    // Standard git / unified diff chunks split by '--- '
    const chunks = raw.split(/(?=^--- )/m);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const pathMatch = chunk.match(/^--- [ab]\/(.*?)(?:\n|\r\n)\+\+\+ [ab]\/(.*?)(?:\n|\r\n)/m);
      const filePath = pathMatch ? (pathMatch[2] || pathMatch[1]) : '';
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

      result.push({
        path: filePath,
        status: dels > 0 && adds === 0 ? 'deleted' : adds > 0 && dels === 0 ? 'added' : 'modified',
        lines: parsedLines,
        additions: adds,
        deletions: dels,
        raw: chunk,
      });
    }
  }

  // Merge any files from fileList not found in the raw diff
  for (const item of fileList) {
    if (!result.some((file) => file.path === item.path)) {
      result.push({
        path: item.path,
        status: item.status || 'modified',
        lines: [],
        additions: 0,
        deletions: 0,
        raw: item.diff || '',
      });
    }
  }

  return result;
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.5 4 2 8l3.5 4M10.5 4l3.5 4-3.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 11H3a1.5 1.5 0 0 1-1.5-1.5V3.5A1.5 1.5 0 0 1 3 2h6a1.5 1.5 0 0 1 1.5 1.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
