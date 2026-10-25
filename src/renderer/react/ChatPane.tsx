import { useCallback, useRef, useState } from 'react';
import { ChatComposer, type ChatComposerHandle } from './ChatComposer';
import { ChatTranscript, type ChatTranscriptHandle } from './ChatTranscript';
import { ProjectTerminal } from './ProjectTerminal';
import { DiffViewerModal, type DiffFile } from './DiffViewerModal';
import { ImageLightboxModal } from './ImageLightboxModal';
import { ChatLinkPreview } from './ChatLinkPreview';
import { useClientTranscript } from './client-transcript';
import { usePendingUserMessages } from './client-session-state';
import type { Attachment, CommandDefinition, CommandResult, PermissionRequest, Project, QueuedTurn, QuestionRequest, Session } from '../types';

export type DeliveryMode = 'queue' | 'steer';
export type ComposerMode = 'build' | 'plan' | 'orchestrate';
export type ActivityEntry = {
  id: string;
  kind: 'tool' | 'queue' | 'validation' | string;
  status: 'running' | 'complete' | 'error' | 'queued' | string;
  label: string;
  details?: string;
};

type Draft = { projectId: string | null; mode: 'plan' | 'build' } | null;

export type ChatPaneProps = {
  session: Session | null;
  loading?: boolean;
  draft: Draft;
  project: Project | null;
  mode: 'plan' | 'build';
  activeMode: ComposerMode;
  running: boolean;
  commands: CommandDefinition[];
  activity: ActivityEntry[];
  terminalOpen?: boolean;
  queuedTurns?: QueuedTurn[];
  onCancelQueued?: (queueId: string) => void | Promise<void>;
  onSteerQueued?: (turn: QueuedTurn) => void | Promise<void>;
  onTerminalOpenChange?: (open: boolean) => void;
  onSend: (text: string, deliveryMode: DeliveryMode, attachments: Attachment[]) => Promise<{ clear: boolean; commandResult?: CommandResult }>;
  onOpenFolder?: () => void;
  onCloneRepository?: () => void;
  onConfigureProvider?: () => void;
  onStop: () => void | Promise<void>;
  onModeChange: (mode: ComposerMode) => void | Promise<void>;
  question?: QuestionRequest | null;
  onAnswerQuestion?: (answers: string[][] | null) => void | Promise<void>;
  permission?: PermissionRequest | null;
  onResolvePermission?: (reply: 'once' | 'always' | 'reject', enableAuto?: boolean) => void | Promise<void>;
};

export function ChatPane(props: ChatPaneProps) {
  const { session, project, running, terminalOpen, onTerminalOpenChange } = props;
  const paneRef = useRef<HTMLElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const transcriptRef = useRef<ChatTranscriptHandle>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [diffModal, setDiffModal] = useState<{ files: DiffFile[]; rawDiff?: string } | null>(null);
  const onInspectDiff = useCallback((files: DiffFile[], rawDiff?: string) => setDiffModal({ files, rawDiff }), []);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; name?: string } | null>(null);
  const transcript = useClientTranscript(session);
  const pending = usePendingUserMessages(session?.id);
  const latestAssistant = [...(session?.messages ?? [])].reverse().find((message) => message.role === 'assistant' && transcript[message.id]?.contextUsage);
  const contextUsage = latestAssistant ? transcript[latestAssistant.id]?.contextUsage : undefined;
  const linkProjectId = project?.id ?? session?.projectId ?? null;

  return (
    <main ref={paneRef} className={`main-pane react-main-pane${isDraggingOver ? ' dropzone-active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes('Files')) setIsDraggingOver(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDraggingOver(false);
        void composerRef.current?.ingestFiles(Array.from(event.dataTransfer.files));
      }}>
      {isDraggingOver && <div className="chat-dropzone-overlay" aria-hidden="true"><div className="chat-dropzone-indicator">Drop images or files to attach</div></div>}
      <ChatTranscript ref={transcriptRef} session={session} loading={props.loading} project={project} running={running} transcript={transcript} pending={pending}
        onInspectDiff={onInspectDiff} onOpenLightbox={setLightboxImage}
        onOpenFolder={props.onOpenFolder} onCloneRepository={props.onCloneRepository} onConfigureProvider={props.onConfigureProvider} />
      <ChatComposer {...props} ref={composerRef} paneRef={paneRef} contextUsage={contextUsage}
        onSubmitStart={() => transcriptRef.current?.followLatest()} onOpenLightbox={setLightboxImage} />
      <ProjectTerminal project={project} open={terminalOpen} onOpenChange={onTerminalOpenChange} />
      {diffModal && <DiffViewerModal files={diffModal.files} rawDiff={diffModal.rawDiff} projectId={project?.id} onClose={() => setDiffModal(null)} />}
      {lightboxImage && <ImageLightboxModal src={lightboxImage.src} name={lightboxImage.name} onClose={() => setLightboxImage(null)} />}
      <ChatLinkPreview projectId={linkProjectId} />
    </main>
  );
}
