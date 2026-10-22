export type PermissionReply = 'once' | 'always' | 'reject';
export interface PermissionRequest {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  description: string;
  createdAt: number;
  autoEligible: boolean;
}
export interface PermissionOutcome {
  allowed: true;
  source: string;
  requestId?: string;
}
export interface AuthorizationInput {
  sessionId: string;
  action: string;
  resources?: unknown[];
  projectRoot?: string | null;
  description?: string;
  planMode?: boolean;
  signal?: AbortSignal;
  fingerprintKey?: string;
}
export type PermissionEvent =
  | { type: 'permission.requested'; request: PermissionRequest }
  | { type: 'permission.resolved'; sessionId: string; requestId: string; reply: PermissionReply; allowed: boolean };
export type MessageDeltaEvent = {
  type: 'message.delta';
  sessionId: string;
  messageId: string;
  delta: string;
  /** UTF-16 end offset; the snapshot content length is a compatible resync cursor. */
  seq: number;
};
export interface RuntimeMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  status?: string;
  sequence?: number;
  createdAt?: number;
  updatedAt?: number;
}
export type RuntimeEvent = PermissionEvent | MessageDeltaEvent
  | { type: 'message.created' | 'message.completed'; message: RuntimeMessage }
  | { type: 'run.started' | 'run.finished'; sessionId: string; messageId: string; projectId?: string | null }
  | { type: 'runtime.activity'; sessionId: string; messageId: string; sequence: number; activity: ProviderActivity };

export type ProviderActivity =
  | { type: 'activity.text.delta' | 'activity.reasoning.delta'; text: string }
  | { type: 'activity.tool.opened' | 'activity.tool.updated'; callId: string; tool: string; argumentsJson?: string; label?: string; details?: string }
  | { type: 'activity.tool.closed'; callId: string; tool: string; status: 'success' | 'error' | 'cancelled'; argumentsJson?: string; details?: string }
  | { type: 'activity.plan.updated'; entries: Array<{ content: string; status: string; priority?: string }> }
  | { type: 'activity.permission.requested' | 'activity.permission.resolved'; requestId?: string }
  | { type: 'activity.usage'; usage?: Record<string, number>; contextUsage?: { usedTokens: number; windowTokens: number; estimated?: boolean } }
  | { type: 'activity.status' | 'activity.warning' | 'activity.error'; message: string; code?: string };

export interface ProviderMessage { role: string; content: string }
export interface ProviderCapabilities {
  models?: Array<{ id: string; label?: string; variants?: string[] }>;
  settings?: Array<{ id: string; type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface ProviderHooks {
  signal?: AbortSignal;
  onText?: (delta: string) => void | Promise<void>;
  onActivity?: (activity: ProviderActivity) => void | Promise<void>;
  executeTool?: (call: { id: string; name: string; arguments: string }) => Promise<unknown>;
  requestAgentPermission?: (request: Record<string, unknown>) => Promise<unknown>;
}
export interface ProviderTurnResult {
  text: string;
  toolCalls?: unknown[];
  usage?: Record<string, number> | null;
  stopReason?: string | null;
}
export interface ProviderRuntime {
  start(options?: Record<string, unknown>): Promise<unknown>;
  capabilities(): ProviderCapabilities;
  runTurn(input?: { messages?: ProviderMessage[] }, hooks?: ProviderHooks): Promise<ProviderTurnResult>;
  cancel(): unknown;
  close(): unknown;
}
