export type Project = {
  id: string;
  name: string;
  path?: string;
  branch?: string | null;
  dirty?: boolean;
  missing?: boolean;
  lastOpenedAt?: number;
};

export type Message = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  status?: string;
  sequence?: number;
};

export type ToolExecution = {
  id: string;
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
  messages: Message[];
  toolExecutions?: ToolExecution[];
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
};

export type ProviderPreset = {
  id: string;
  label?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  authType?: 'api-key' | 'chatgpt' | string;
};

export type ProviderSettings = {
  providerID?: string;
  configured?: boolean;
  apiKeyConfigured?: boolean;
  credentialConfigured?: boolean;
  credentialMode?: 'api-key' | 'chatgpt' | string;
  authType?: string;
  requiresChatGPTAuth?: boolean;
  presetID?: string | null;
  presets?: ProviderPreset[];
  baseUrl?: string;
  primary?: { providerID?: string; modelID?: string; variant?: string | null } | null;
  secondary?: { providerID?: string; modelID?: string; variant?: string | null } | null;
  models?: Array<{ providerID?: string; modelID?: string; variants?: string[] }>;
  catalog?: Array<{ id?: string; label?: string; integrationIds?: string[] }>;
  encryptionAvailable?: boolean;
  encryptionBackend?: string;
  encryptionUnavailableReason?: string;
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

export type RemoteStatus = {
  running?: boolean;
  connected?: boolean;
  deviceConnected?: boolean;
  activeDevice?: RemoteDevice | null;
  activeDevices?: RemoteDevice[];
};

export type RemoteInvite = {
  code?: string;
  expiresAt?: number;
  url?: string | null;
  role?: string;
};

export type PermissionRequest = {
  id: string;
  sessionId?: string;
  action?: string;
  description?: string;
  resources?: string[];
  autoEligible?: boolean;
};

export type QuestionRequest = {
  id: string;
  questions?: Array<{
    header?: string;
    question?: string;
    multiple?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
};

export type RuntimeEvent = Record<string, any> & { type?: string };

export type CuppetApi = {
  health: () => Promise<any>;
  cognitive: {
    status: () => Promise<CognitiveStatus>;
    modeGet: (sessionId: string) => Promise<{ mode?: 'plan' | 'build' }>;
    modeSet: (sessionId: string, mode: 'plan' | 'build') => Promise<any>;
    orchestratorSet: (enabled: boolean) => Promise<any>;
    backgroundStatus: () => Promise<any>;
    backgroundPause: () => Promise<any>;
    backgroundResume: () => Promise<any>;
    backgroundFlush: (sessionId: string) => Promise<any>;
    planGet: (sessionId: string, request?: any) => Promise<any>;
    memoryQuery: (sessionId: string, query: any) => Promise<any>;
  };
  commands: {
    list: () => Promise<CommandDefinition[]>;
    execute: (sessionId: string | null, value: string | { id: string; input?: Record<string, unknown> }) => Promise<CommandResult>;
  };
  permissions: {
    list: (sessionId?: string | null) => Promise<PermissionRequest[]>;
    reply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<any>;
    autoGet: (sessionId: string) => Promise<any>;
    autoSet: (sessionId: string, enabled: boolean) => Promise<any>;
  };
  questions: {
    list: (sessionId?: string | null) => Promise<QuestionRequest[]>;
    reply: (requestId: string, answers: string[][]) => Promise<any>;
    reject: (requestId: string) => Promise<any>;
  };
  remote: {
    status: () => Promise<RemoteStatus>;
    start: (value?: Record<string, unknown>) => Promise<{ status?: RemoteStatus; invite?: RemoteInvite | null }>;
    stop: () => Promise<any>;
    invite: (role?: string) => Promise<RemoteInvite>;
    devices: () => Promise<RemoteDevice[]>;
    revoke: (deviceId: string) => Promise<any>;
  };
  codexAuth: {
    status: () => Promise<any>;
    login: () => Promise<any>;
    logout: () => Promise<any>;
  };
  pe3: {
    status: (sessionId: string) => Promise<any>;
    observePaths: (sessionId: string, paths: string[]) => Promise<any>;
    workspaceMutation: (sessionId: string, paths: string[]) => Promise<any>;
  };
  sessions: {
    list: (projectId?: string) => Promise<Session[]>;
    create: (projectId?: string | null) => Promise<Session>;
    get: (sessionId: string) => Promise<Session>;
    search: (query: string, options?: Record<string, unknown>) => Promise<SearchResult[]>;
    rename: (sessionId: string, title: string) => Promise<any>;
    archive: (sessionId: string) => Promise<any>;
    restore: (sessionId: string) => Promise<any>;
    delete: (sessionId: string) => Promise<any>;
    send: (sessionId: string, text: string, attachments?: unknown[]) => Promise<any>;
    stop: (sessionId: string) => Promise<any>;
    undoStatus: (sessionId: string) => Promise<any>;
    undo: (sessionId: string) => Promise<any>;
  };
  projects: {
    list: () => Promise<Project[]>;
    get: (projectId: string) => Promise<Project>;
    open: (projectId: string) => Promise<any>;
    rename: (projectId: string, name: string) => Promise<any>;
    addLocal: (value: Record<string, unknown>) => Promise<Project>;
    cloneUrl: (value: Record<string, unknown>) => Promise<Project>;
    githubList: (query?: string) => Promise<Array<{ nameWithOwner: string; isPrivate?: boolean; defaultBranch?: string }>>;
    githubClone: (value: Record<string, unknown>) => Promise<Project>;
    relocate: (projectId: string, path: string) => Promise<Project>;
    remove: (projectId: string) => Promise<any>;
  };
  native: { chooseFolder: (options?: Record<string, unknown>) => Promise<string | null> };
  settings: {
    get: () => Promise<ProviderSettings>;
    save: (value: Record<string, unknown>) => Promise<ProviderSettings>;
  };
  onEvent: (callback: (event: RuntimeEvent) => void) => () => void;
};

declare global {
  interface Window {
    cuppet: CuppetApi;
  }
}

export {};
