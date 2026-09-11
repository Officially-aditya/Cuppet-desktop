const { contextBridge, ipcRenderer } = require('electron');

const LEGACY_ACTIVITY_EVENTS = new Set(['message.reasoning', 'tool.started', 'tool.finished']);

contextBridge.exposeInMainWorld('cuppet', {
  health: () => ipcRenderer.invoke('cuppet:health'),
  usage: {
    summary: () => ipcRenderer.invoke('cuppet:usage:summary'),
  },
  integrations: {
    browserControl: {
      status: () => ipcRenderer.invoke('cuppet:browser-control:status'),
      connect: () => ipcRenderer.invoke('cuppet:browser-control:connect'),
      disconnect: () => ipcRenderer.invoke('cuppet:browser-control:disconnect'),
    },
  },
  cognitive: {
    status: () => ipcRenderer.invoke('cuppet:cognitive:status'),
    modeGet: (sessionId) => ipcRenderer.invoke('cuppet:session:mode:get', sessionId),
    modeSet: (sessionId, mode) => ipcRenderer.invoke('cuppet:session:mode:set', sessionId, mode),
    orchestratorSet: (enabled) => ipcRenderer.invoke('cuppet:orchestrator:set', enabled),
    backgroundStatus: () => ipcRenderer.invoke('cuppet:background:status'),
    backgroundPause: () => ipcRenderer.invoke('cuppet:background:pause'),
    backgroundResume: () => ipcRenderer.invoke('cuppet:background:resume'),
    backgroundFlush: (sessionId) => ipcRenderer.invoke('cuppet:background:flush', sessionId),
    planGet: (sessionId, request = { action: 'overview' }) => ipcRenderer.invoke('cuppet:plan:get', sessionId, request),
    memoryQuery: (sessionId, query) => ipcRenderer.invoke('cuppet:memory:query', sessionId, query),
  },
  commands: {
    list: () => ipcRenderer.invoke('cuppet:command:list'),
    execute: (sessionId, value) => ipcRenderer.invoke('cuppet:command:execute', sessionId, value),
  },
  permissions: {
    list: (sessionId = null) => ipcRenderer.invoke('cuppet:permission:list', sessionId),
    reply: (requestId, reply) => ipcRenderer.invoke('cuppet:permission:reply', requestId, reply),
    autoGet: (sessionId) => ipcRenderer.invoke('cuppet:session:auto:get', sessionId),
    autoSet: (sessionId, enabled) => ipcRenderer.invoke('cuppet:session:auto:set', sessionId, enabled),
  },
  questions: {
    list: (sessionId = null) => ipcRenderer.invoke('cuppet:question:list', sessionId),
    reply: (requestId, answers) => ipcRenderer.invoke('cuppet:question:reply', requestId, answers),
    reject: (requestId) => ipcRenderer.invoke('cuppet:question:reject', requestId),
  },
  remote: {
    status: () => ipcRenderer.invoke('cuppet:remote:status'),
    start: (value = {}) => ipcRenderer.invoke('cuppet:remote:start', value),
    stop: () => ipcRenderer.invoke('cuppet:remote:stop'),
    invite: (role = 'trusted') => ipcRenderer.invoke('cuppet:remote:invite', role),
    devices: () => ipcRenderer.invoke('cuppet:remote:devices'),
    revoke: (deviceId) => ipcRenderer.invoke('cuppet:remote:revoke', deviceId),
  },
  cliAgents: {
    status: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:status', providerID),
    connect: (providerID) => ipcRenderer.invoke('cuppet:cli-agent:connect', providerID),
  },
  codexAuth: {
    status: () => ipcRenderer.invoke('cuppet:codex-auth:status'),
    models: () => ipcRenderer.invoke('cuppet:codex-auth:models'),
    login: () => ipcRenderer.invoke('cuppet:codex-auth:login'),
    logout: () => ipcRenderer.invoke('cuppet:codex-auth:logout'),
  },
  pe3: {
    status: (sessionId) => ipcRenderer.invoke('cuppet:pe3:status', sessionId),
    observePaths: (sessionId, paths) => ipcRenderer.invoke('cuppet:pe3:observe-paths', sessionId, paths),
    workspaceMutation: (sessionId, paths) => ipcRenderer.invoke('cuppet:pe3:workspace-mutation', sessionId, paths),
  },
  sessions: {
    list: (projectId) => ipcRenderer.invoke('cuppet:session:list', projectId),
    deleted: () => ipcRenderer.invoke('cuppet:session:deleted:list'),
    editedFiles: (sessionId) => ipcRenderer.invoke('cuppet:session:edited-files', sessionId),
    create: (projectId = null) => ipcRenderer.invoke('cuppet:session:create', projectId),
    get: (sessionId) => ipcRenderer.invoke('cuppet:session:get', sessionId),
    search: (query, options = {}) => ipcRenderer.invoke('cuppet:session:search', query, options),
    rename: (sessionId, title) => ipcRenderer.invoke('cuppet:session:rename', sessionId, title),
    archive: (sessionId) => ipcRenderer.invoke('cuppet:session:archive', sessionId),
    restore: (sessionId) => ipcRenderer.invoke('cuppet:session:restore', sessionId),
    delete: (sessionId) => ipcRenderer.invoke('cuppet:session:delete', sessionId),
    send: (sessionId, text, attachments = []) => ipcRenderer.invoke('cuppet:session:send', sessionId, text, attachments),
    stop: (sessionId) => ipcRenderer.invoke('cuppet:session:stop', sessionId),
    undoStatus: (sessionId) => ipcRenderer.invoke('cuppet:session:undo:status', sessionId),
    undo: (sessionId) => ipcRenderer.invoke('cuppet:session:undo', sessionId),
  },
  projects: {
    list: () => ipcRenderer.invoke('cuppet:project:list'),
    get: (projectId) => ipcRenderer.invoke('cuppet:project:get', projectId),
    open: (projectId) => ipcRenderer.invoke('cuppet:project:open', projectId),
    rename: (projectId, name) => ipcRenderer.invoke('cuppet:project:rename', projectId, name),
    addLocal: (value) => ipcRenderer.invoke('cuppet:project:add-local', value),
    cloneUrl: (value) => ipcRenderer.invoke('cuppet:project:clone-url', value),
    githubList: (query = '') => ipcRenderer.invoke('cuppet:project:github-list', query),
    githubClone: (value) => ipcRenderer.invoke('cuppet:project:github-clone', value),
    relocate: (projectId, path) => ipcRenderer.invoke('cuppet:project:relocate', projectId, path),
    remove: (projectId) => ipcRenderer.invoke('cuppet:project:remove', projectId),
  },
  native: {
    platform: process.platform,
    chooseFolder: (options) => ipcRenderer.invoke('cuppet:native:choose-folder', options),
    openProjectFile: (projectId, path) => ipcRenderer.invoke('cuppet:native:open-project-file', projectId, path),
    openExternal: (url) => ipcRenderer.invoke('cuppet:native:open-external', url),
    copyText: (text) => ipcRenderer.invoke('cuppet:native:copy-text', text),
  },
  settings: { get: () => ipcRenderer.invoke('cuppet:settings:get'), models: () => ipcRenderer.invoke('cuppet:settings:models'), save: (value) => ipcRenderer.invoke('cuppet:settings:save', value) },
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      if (payload?.type === 'runtime.activity') {
        // Activity is the renderer authority. Deliver the canonical envelope for
        // new consumers, then a temporary UI projection for existing ChatPane.
        callback(payload);
        const projected = projectActivityForLegacyUi(payload);
        if (projected) callback(projected);
        return;
      }
      // Main/remote compatibility events remain available outside the renderer,
      // but React must not receive a second legacy copy of Activity-backed work.
      if (LEGACY_ACTIVITY_EVENTS.has(String(payload?.type ?? ''))) return;
      callback(payload);
    };
    ipcRenderer.on('cuppet:event', listener);
    return () => ipcRenderer.removeListener('cuppet:event', listener);
  },
});

function projectActivityForLegacyUi(payload) {
  const activity = payload?.activity;
  if (!activity || typeof activity !== 'object') return null;
  const type = String(activity.type ?? '');
  if (payload.source === 'provider' && type === 'activity.reasoning.delta') {
    const segment = typeof activity.text === 'string' ? activity.text.trim() : '';
    return segment ? {
      type: 'message.reasoning',
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      segment,
    } : null;
  }
  if (payload.source !== 'execution' || !type.startsWith('activity.tool.')) return null;
  const base = {
    sessionId: payload.sessionId,
    messageId: payload.messageId,
    executionId: activity.executionId,
    callId: activity.callId,
    tool: activity.tool,
    argumentsJson: activity.argumentsJson,
    message: activity.details,
    paths: activity.paths,
    mutation: activity.mutation,
  };
  if (type === 'activity.tool.closed') {
    return {
      ...base,
      type: 'tool.finished',
      success: activity.status === 'success',
      rejected: activity.status === 'cancelled',
    };
  }
  if (type === 'activity.tool.opened' || type === 'activity.tool.updated') {
    return { ...base, type: 'tool.started' };
  }
  return null;
}
