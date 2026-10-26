export type Project = {
  id: string;
  name: string;
  path?: string;
  branch?: string | null;
  branches?: string[];
  dirty?: boolean;
  missing?: boolean;
  lastOpenedAt?: number;
};

export type Message = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  attachments?: Attachment[];
  status?: string;
  sequence?: number;
  createdAt?: number;
  updatedAt?: number;
};

export type MessageActivity = {
  sessionId: string;
  messageId: string;
  sequence: number;
  source: string;
  activity: Record<string, any>;
  createdAt?: number;
};

export type ToolExecution = {
  id: string;
  messageId?: string;
  updatedAt?: number;
  toolName?: string;
  status?: string;
  argumentsJson?: string;
  output?: string;
};

export type Session = {
  id: string;
  projectId?: string | null;
  title?: string;
  updatedAt?: number;
  lastStatus?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  purgeAt?: number | null;
  messages: Message[];
  activities?: MessageActivity[];
  toolExecutions?: ToolExecution[];
  history?: { hasMore: boolean; beforeSequence: number | null };
};

export type Attachment = {
  name: string;
  mime?: string;
  size?: number;
  path?: string;
  dataUrl?: string;
  hasData?: boolean;
};

export type QueuedTurn = {
  id: string;
  sessionId: string;
  params: {
    text?: string;
    attachments?: Attachment[];
    [key: string]: unknown;
  };
  status?: string;
  error?: string | null;
  queuedAt: number;
  updatedAt?: number;
};

export type SearchResult = {
  sessionId: string;
  projectId?: string | null;
  title?: string;
  kind?: 'session' | 'message' | string;
  role?: string;
  sequence?: number;
  snippet?: string;
  itemId?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
};

export type CommandDefinition = {
  id: string;
  slash: string | null;
  aliases: string[];
  title?: string | null;
  description: string;
  scope: string;
  authority: string;
  paletteOnly: boolean;
  requiresSession: boolean;
  takesText: boolean;
};

export type CommandResult = {
  command?: boolean;
  id?: string;
  slash?: string | null;
  sessionId?: string | null;
  result?: Record<string, unknown> | string | boolean | null;
  presentation?: string;
  /** Set when the command failed: presentation then holds the error message. */
  error?: boolean;
};

export type ProviderPresetModel = {
  id: string;
  label?: string;
  description?: string;
};

export type ProviderPreset = {
  id: string;
  label?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  models?: ProviderPresetModel[];
  authType?: 'api-key' | 'chatgpt' | 'local-cli' | string;
  authLabel?: string;
  note?: string;
};

export type ProviderCustomModel = {
  providerID: string;
  modelID: string;
};

export type ProviderSettings = {
  providerID?: string;
  configured?: boolean;
  apiKeyConfigured?: boolean;
  credentialConfigured?: boolean;
  credentialMode?: 'api-key' | 'chatgpt' | string;
  authType?: string;
  requiresChatGPTAuth?: boolean;
  requiresLocalCli?: boolean;
  presetID?: string | null;
  presets?: ProviderPreset[];
  customModels?: ProviderCustomModel[];
  customModelProbe?: { ok?: boolean; providerID?: string; modelID?: string; reply?: string };
  baseUrl?: string;
  primary?: { providerID?: string; modelID?: string; variant?: string | null } | null;
  secondary?: { providerID?: string; modelID?: string; variant?: string | null } | null;
  primaryEffort?: string | null;
  models?: Array<{ providerID?: string; modelID?: string; name?: string; variants?: string[] }>;
  catalog?: Array<{ id?: string; label?: string; integrationIds?: string[] }>;
  encryptionAvailable?: boolean;
  encryptionBackend?: string;
  encryptionUnavailableReason?: string;
};

export type TokenUsageBucket = {
  providerID: string;
  modelID: string;
  requests: number;
  trackedRequests: number;
  unreportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  firstRequestAt?: number | null;
  lastRequestAt?: number | null;
  firstTrackedAt?: number | null;
  lastTrackedAt?: number | null;
};

export type TokenUsageSummary = {
  version: number;
  requests: number;
  trackedRequests: number;
  unreportedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  firstRequestAt?: number | null;
  lastRequestAt?: number | null;
  firstTrackedAt?: number | null;
  lastTrackedAt?: number | null;
  byModel: TokenUsageBucket[];
};

export type ProviderModelCatalog = {
  providerID: string;
  available: boolean;
  source: 'api' | 'acp' | 'cli' | 'codex' | 'none' | string;
  defaultModel?: string | null;
  configuredModel?: string | null;
  modelDependentSettings?: boolean;
  fetchedAt?: number;
  error?: string;
  reasoning?: {
    configId: string;
    currentValue?: string | null;
    options: Array<{ id: string; label?: string; description?: string }>;
  };
  models: Array<{
    id: string;
    label?: string;
    description?: string;
    context?: number;
    outputLimit?: number;
    isDefault?: boolean;
  }>;
};

export type CliAgentStatus = {
  providerID: string;
  label?: string;
  available: boolean;
  installed?: boolean;
  connected?: boolean;
  version?: string | null;
  action?: 'connect' | 'ready' | string;
  canAutoInstall?: boolean;
  loginHint?: string;
  message?: string;
  error?: string | null;
  missingAdapter?: string;
};

export type BrowserControlStatus = {
  id?: string;
  available?: boolean;
  running?: boolean;
  connected?: boolean;
  extensionConnected?: boolean;
  toolCount?: number;
  port?: number;
  message?: string;
};

export type CognitiveStatus = {
  orchestratorEnabled?: boolean;
  backgroundPaused?: boolean;
  tst?: { configured?: boolean; connected?: boolean };
};

export type RemoteDevice = {
  deviceId: string;
  name?: string;
  scopes?: string[];
};

export type RemoteInvite = {
  code?: string;
  expiresAt?: number;
  url?: string | null;
  role?: string;
};

export type RemoteStatus = {
  running?: boolean;
  starting?: boolean;
  connected?: boolean;
  deviceConnected?: boolean;
  activeDevice?: RemoteDevice | null;
  activeDevices?: RemoteDevice[];
  setup?: RemoteInvite | null;
};

export type { PermissionRequest } from '../shared/runtime-contracts';
import type { PermissionRequest } from '../shared/runtime-contracts';

export type QuestionRequest = {
  id: string;
  sessionId?: string;
  questions?: Array<{
    header?: string;
    question?: string;
    multiple?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
};

// Additional projection events remain compatible while checked core contracts migrate.
export type RuntimeEvent = Record<string, any> & { type?: string; delta?: import('../shared/runtime-contracts').MessageDeltaEvent['delta']; seq?: import('../shared/runtime-contracts').MessageDeltaEvent['seq'] };

export type { CuppetApi } from './ipc-api';
import type { CuppetApi } from './ipc-api';

export type MemoryGraph = {
      available?: boolean;
      reason?: string;
      root?: string;
      graph?: { files?: number; modules?: number; symbols?: number; edges?: number; progress?: { discovered?: number; indexed?: number; skipped?: number; complete?: boolean } };
      files?: string[];
      editedFiles?: Array<{ path: string; tool?: string; updatedAt?: number; mutationId?: string | null; executionId?: string | null }>;
    };
export type EditedFiles = Array<{ path: string; tool: string; updatedAt: number; mutationId: string | null; executionId: string | null }>;

export type TerminalSession = {
  sessionId: string;
  projectId: string;
  cwd: string;
  shell: string;
  startedAt: number;
};

export type TerminalEvent = {
  sessionId: string;
  projectId: string;
  type: 'output' | 'exit' | 'error';
  stream?: 'stdout' | 'stderr';
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
};


export type SandboxStatus = {
  available: boolean;
  driverName: string;
  platform: string;
  networkIsolation: boolean;
  credentialProtection: boolean;
};

declare global { interface Window { cuppet: CuppetApi } }

export {};
