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

type SplitCell = {
  num?: number;
  text: string;
  type: 'del' | 'add' | 'ctx' | 'empty';
};

type SplitRow = {
  type: 'hunk' | 'line';
  hunkText?: string;
  left?: SplitCell;
  right?: SplitCell;
};

export function DiffViewerModal({ files, rawDiff = '', projectId, onClose }: Props) {
  const parsedFiles = useMemo(() => parseDiff(rawDiff, files), [rawDiff, files]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const [copied, setCopied] = useState(false);

  const activeFile: ParsedFileDiff | null = parsedFiles[selectedIndex] ?? parsedFiles[0] ?? null;

  const totalAdditions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.additions, 0), [parsedFiles]);
  const totalDeletions = useMemo(() => parsedFiles.reduce((sum, file) => sum + file.deletions, 0), [parsedFiles]);

  const splitRows = useMemo(() => (activeFile ? buildSplitRows(activeFile.lines) : []), [activeFile]);

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
            <div className="diff-view-mode-toggle" role="radiogroup" aria-label="Diff view mode">
              <button
                type="button"
                className={`diff-toggle-btn${viewMode === 'split' ? ' active' : ''}`}
                role="radio"
                aria-checked={viewMode === 'split'}
                onClick={() => setViewMode('split')}
              >
                Split
              </button>
              <button
                type="button"
                className={`diff-toggle-btn${viewMode === 'unified' ? ' active' : ''}`}
                role="radio"
                aria-checked={viewMode === 'unified'}
                onClick={() => setViewMode('unified')}
              >
                Unified
              </button>
            </div>

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

                {activeFile.lines.length === 0 ? (
                  <EmptyFileDiffState file={activeFile} onOpenInEditor={projectId ? openInEditor : undefined} />
                ) : viewMode === 'split' ? (
                  <div className="diff-split-container">
                    <div className="diff-split-header-row">
                      <div className="diff-split-col-header diff-split-left-header">Base (Original)</div>
                      <div className="diff-split-col-header diff-split-right-header">Modified (Current)</div>
                    </div>
                    <div className="diff-split-lines">
                      {splitRows.map((row, rowIdx) => {
                        if (row.type === 'hunk') {
                          return (
                            <div key={rowIdx} className="diff-split-hunk-row">
                              <span className="diff-split-hunk-text">{row.hunkText}</span>
                            </div>
                          );
                        }
                        return (
                          <div key={rowIdx} className="diff-split-row">
                            <div className={`diff-split-cell diff-split-left ${row.left?.type || 'empty'}`}>
                              <span className="diff-split-num">{row.left?.num ?? ''}</span>
                              <span className="diff-split-sign">{row.left?.type === 'del' ? '−' : ''}</span>
                              <span className="diff-split-code">{row.left?.text ?? ''}</span>
                            </div>
                            <div className={`diff-split-cell diff-split-right ${row.right?.type || 'empty'}`}>
                              <span className="diff-split-num">{row.right?.num ?? ''}</span>
                              <span className="diff-split-sign">{row.right?.type === 'add' ? '+' : ''}</span>
                              <span className="diff-split-code">{row.right?.text ?? ''}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="diff-lines-container">
                    {activeFile.lines.map((line, lineIndex) => (
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
                    ))}
                  </div>
                )}
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

function EmptyFileDiffState({ file, onOpenInEditor }: { file: ParsedFileDiff; onOpenInEditor?: () => void }) {
  return (
    <div className="diff-empty-state">
      <div style={{ textAlign: 'center', padding: '32px 20px', maxWidth: '640px' }}>
        <div style={{ fontSize: '15px', fontWeight: 600, color: '#f0f6fc', marginBottom: '8px' }}>
          {file.status === 'added' ? 'New file created' : file.status === 'deleted' ? 'File deleted' : 'File modified'}
        </div>
        <p style={{ fontSize: '12px', color: '#8b949e', lineHeight: '1.6', margin: '0 0 16px' }}>
          {file.raw
            ? 'Detailed unified diff lines were not formatted, but raw content is shown below.'
            : 'This file was modified in this turn. You can open it in your code editor to view the full file.'}
        </p>
        {file.raw && (
          <div style={{ textAlign: 'left', background: '#090d12', border: '1px solid #21262d', borderRadius: '6px', padding: '10px 12px', overflow: 'auto', maxHeight: '300px', marginBottom: '16px' }}>
            <pre style={{ margin: 0, fontSize: '11px', fontFamily: 'monospace', color: '#c9d1d9', whiteSpace: 'pre-wrap' }}>{file.raw}</pre>
          </div>
        )}
        {onOpenInEditor && (
          <button type="button" className="diff-action-button" onClick={onOpenInEditor}>
            <CodeIcon />
            <span>Open {file.path.split('/').pop()} in editor</span>
          </button>
        )}
      </div>
    </div>
  );
}

function buildSplitRows(lines: ParsedDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let delBuffer: ParsedDiffLine[] = [];
  let addBuffer: ParsedDiffLine[] = [];

  const flushBuffers = () => {
    if (delBuffer.length === 0 && addBuffer.length === 0) return;
    const count = Math.max(delBuffer.length, addBuffer.length);
    for (let i = 0; i < count; i++) {
      const del = delBuffer[i];
      const add = addBuffer[i];
      rows.push({
        type: 'line',
        left: del
          ? { num: del.oldNum, text: del.text, type: 'del' }
          : { text: '', type: 'empty' },
        right: add
          ? { num: add.newNum, text: add.text, type: 'add' }
          : { text: '', type: 'empty' },
      });
    }
    delBuffer = [];
    addBuffer = [];
  };

  for (const line of lines) {
    if (line.type === 'hunk') {
      flushBuffers();
      rows.push({ type: 'hunk', hunkText: line.text });
    } else if (line.type === 'del') {
      delBuffer.push(line);
    } else if (line.type === 'add') {
      addBuffer.push(line);
    } else if (line.type === 'ctx') {
      flushBuffers();
      rows.push({
        type: 'line',
        left: { num: line.oldNum, text: line.text, type: 'ctx' },
        right: { num: line.newNum, text: line.text, type: 'ctx' },
      });
    }
  }

  flushBuffers();
  return rows;
}

function parseDiff(rawDiff: string, fileList: DiffFile[]): ParsedFileDiff[] {
  const result: ParsedFileDiff[] = [];
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

  for (const item of fileList) {
    const existing = result.find((file) => file.path === item.path);
    if (!existing) {
      if (item.diff) {
        const sub = parseDiff(item.diff, []);
        if (sub.length > 0 && sub[0].lines.length > 0) {
          result.push({
            ...sub[0],
            path: item.path,
            status: item.status || sub[0].status,
          });
          continue;
        }
      }
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
