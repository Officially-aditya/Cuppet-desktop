from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, value):
    Path(path).write_text(value)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"{label}: start marker missing")
    j = text.find(end, i)
    if j < 0:
        raise SystemExit(f"{label}: end marker missing")
    return text[:i] + replacement + text[j:]

# 1) ACP: advertised model + reasoning config, model/effort application, and activity events.
path = 'src/runtime/acp-cli-provider.mjs'
s = read(path)
s = replace_between(
    s,
    'export function acpModelCatalogFromSession(session = {}) {',
    'export async function discoverAcpModelCatalog(providerID, options = {}) {',
    '''export function acpModelCatalogFromSession(session = {}) {
  const source = record(session);
  const configOptions = Array.isArray(source.configOptions) ? source.configOptions : [];
  const normalizedConfigOptions = configOptions.flatMap((item) => {
    const normalized = normalizeAcpSelectOption(item);
    return normalized ? [normalized] : [];
  });
  const selector = configOptions.find((item) => String(item?.category ?? '').toLowerCase() === 'model')
    ?? configOptions.find((item) => item?.type === 'select' && /model/i.test(String(item?.id ?? item?.name ?? '')));
  const rawOptions = Array.isArray(selector?.options) ? selector.options : [];
  const models = [];
  const seen = new Set();
  for (const raw of rawOptions) {
    const option = record(raw);
    const id = text(option.value || option.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: text(option.name || option.label) || id, ...(text(option.description) ? { description: text(option.description) } : {}) });
  }

  // A few ACP agents shipped the older models object before configOptions stabilized.
  const legacy = record(source.models);
  if (!models.length) {
    const legacyModels = Array.isArray(legacy.availableModels) ? legacy.availableModels : Array.isArray(legacy.models) ? legacy.models : [];
    for (const raw of legacyModels) {
      const option = record(raw);
      const id = text(option.modelId || option.id || option.value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: text(option.name || option.label) || id, ...(text(option.description) ? { description: text(option.description) } : {}) });
    }
  }
  const currentModel = text(selector?.currentValue || legacy.currentModelId || legacy.currentModel);
  if (currentModel && !seen.has(currentModel)) models.unshift({ id: currentModel, label: currentModel });
  const reasoning = normalizedConfigOptions.find((item) => item.category === 'thought_level')
    ?? normalizedConfigOptions.find((item) => /(effort|reason|thought)/i.test(`${item.id} ${item.name}`));
  return {
    available: models.length > 0,
    source: 'acp',
    configId: text(selector?.id) || null,
    defaultModel: currentModel || null,
    currentModel: currentModel || null,
    models,
    configOptions: normalizedConfigOptions,
    reasoning: reasoning ? {
      configId: reasoning.id,
      currentValue: reasoning.currentValue || null,
      options: reasoning.options,
    } : null,
  };
}

''',
    'ACP catalog block',
)
s = replace_once(
    s,
    "    const session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);\n    return { providerID: descriptor.id, ...acpModelCatalogFromSession(session) };",
    "    let session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);\n    session = await applyAdvertisedAcpModel(rpc, descriptor, text(session?.sessionId), session, configuredAcpModel(configuration));\n    session = await applyAdvertisedAcpEffort(rpc, descriptor, text(session?.sessionId), session, configuredAcpEffort(configuration));\n    return { providerID: descriptor.id, ...acpModelCatalogFromSession(session) };",
    'ACP discovery applies config',
)
s = replace_once(
    s,
    "  async stream(messages, { signal, onDelta = async () => {}, projectRoot = null, executeTool, requestAgentPermission } = {}) {",
    "  async stream(messages, { signal, onDelta = async () => {}, onProviderEvent = async () => {}, projectRoot = null, executeTool, requestAgentPermission } = {}) {",
    'ACP stream callback',
)
s = replace_once(
    s,
    "      requestAgentPermission,\n      onDelta,\n    });",
    "      requestAgentPermission,\n      onDelta,\n      onProviderEvent,\n    });",
    'ACP runtime callback wiring',
)
s = replace_once(
    s,
    "      const session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);\n      sessionId = text(session?.sessionId);\n      if (!sessionId) throw new Error(`${this.#descriptor.label} ACP did not return a session id.`);\n      await applyAdvertisedAcpModel(rpc, this.#descriptor, sessionId, session, configuredAcpModel(this.#configuration));",
    "      let session = await rpc.request('session/new', { cwd, mcpServers: [] }, REQUEST_TIMEOUT_MS);\n      sessionId = text(session?.sessionId);\n      if (!sessionId) throw new Error(`${this.#descriptor.label} ACP did not return a session id.`);\n      session = await applyAdvertisedAcpModel(rpc, this.#descriptor, sessionId, session, configuredAcpModel(this.#configuration));\n      session = await applyAdvertisedAcpEffort(rpc, this.#descriptor, sessionId, session, configuredAcpEffort(this.#configuration));",
    'ACP prompt config application',
)
s = replace_once(
    s,
    "  #child; #descriptor; #projectRoot; #executeTool; #requestAgentPermission; #onDelta;",
    "  #child; #descriptor; #projectRoot; #executeTool; #requestAgentPermission; #onDelta; #onProviderEvent;",
    'ACP client fields',
)
s = replace_once(
    s,
    "  constructor({ child, descriptor, projectRoot, executeTool, requestAgentPermission, onDelta }) {",
    "  constructor({ child, descriptor, projectRoot, executeTool, requestAgentPermission, onDelta, onProviderEvent }) {",
    'ACP client constructor',
)
s = replace_once(
    s,
    "    this.#onDelta = typeof onDelta === 'function' ? onDelta : async () => {};\n    this.#readyPromise = new Promise((resolveReady, rejectReady) => {",
    "    this.#onDelta = typeof onDelta === 'function' ? onDelta : async () => {};\n    this.#onProviderEvent = typeof onProviderEvent === 'function' ? onProviderEvent : async () => {};\n    this.#readyPromise = new Promise((resolveReady, rejectReady) => {",
    'ACP client callback assignment',
)
s = replace_between(
    s,
    '  async #handleUpdate(update) {',
    '  async #handleServerRequest(message) {',
    '''  async #handleUpdate(update) {
    const source = record(update);
    this.#lastUpdateAt = Date.now();
    const kind = normalizeUpdateKind(source.sessionUpdate ?? source.type ?? source.kind);
    if (kind === 'agent_message_chunk') {
      const delta = contentText(source.content);
      if (!delta) return;
      this.#text += delta;
      await this.#onDelta(delta);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const reasoning = contentText(source.content);
      if (reasoning) await this.#safeProviderEvent({ type: 'reasoning', text: reasoning });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const event = acpProviderToolEvent(source);
      if (event) await this.#safeProviderEvent(event);
    }
  }

  async #safeProviderEvent(event) {
    try { await this.#onProviderEvent(event); } catch {}
  }

''',
    'ACP update handler',
)
s = replace_between(
    s,
    'async function applyAdvertisedAcpModel(rpc, descriptor, sessionId, session, requestedModel) {',
    'function sessionPromptParams(descriptor, sessionId, textValue) {',
    '''async function applyAdvertisedAcpModel(rpc, descriptor, sessionId, session, requestedModel) {
  const requested = text(requestedModel);
  if (!requested || requested === 'cli-default') return session;
  const catalog = acpModelCatalogFromSession(session);
  if (!catalog.configId) throw new Error(`${descriptor.label} does not advertise a switchable model selector; leaving its provider default unchanged.`);
  if (!catalog.models.some((item) => item.id === requested)) throw new Error(`${descriptor.label} no longer advertises model '${requested}'. Refresh the model picker.`);
  if (catalog.currentModel === requested) return session;
  const result = await rpc.request('session/set_config_option', { sessionId, configId: catalog.configId, value: requested }, REQUEST_TIMEOUT_MS);
  return sessionWithConfigOptions(session, result);
}

async function applyAdvertisedAcpEffort(rpc, descriptor, sessionId, session, requestedEffort) {
  const requested = text(requestedEffort);
  if (!requested) return session;
  const catalog = acpModelCatalogFromSession(session);
  const reasoning = catalog.reasoning;
  if (!reasoning?.configId) throw new Error(`${descriptor.label} does not advertise a reasoning-effort selector for the selected model.`);
  if (!reasoning.options.some((item) => item.id === requested)) {
    throw new Error(`${descriptor.label} no longer advertises reasoning effort '${requested}' for the selected model. Refresh the model picker.`);
  }
  if (reasoning.currentValue === requested) return session;
  const result = await rpc.request('session/set_config_option', { sessionId, configId: reasoning.configId, value: requested }, REQUEST_TIMEOUT_MS);
  return sessionWithConfigOptions(session, result);
}

function sessionWithConfigOptions(session, result) {
  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : null;
  return configOptions ? { ...record(session), configOptions } : session;
}
function configuredAcpModel(configuration) {
  return text(configuration?.primary?.modelID || configuration?.model);
}
function configuredAcpEffort(configuration) {
  return text(configuration?.primaryEffort || configuration?.primary?.variant);
}

''',
    'ACP config application helpers',
)
s = replace_once(
    s,
    "function contentText(value) {\n  if (typeof value === 'string') return value;\n  if (Array.isArray(value)) return value.map(contentText).join('');\n  return typeof value?.text === 'string' ? value.text : '';\n}\n",
    "function contentText(value) {\n  if (typeof value === 'string') return value;\n  if (Array.isArray(value)) return value.map(contentText).join('');\n  return typeof value?.text === 'string' ? value.text : '';\n}\nfunction normalizeAcpSelectOption(value) {\n  const source = record(value);\n  if (source.type !== 'select') return null;\n  const id = text(source.id);\n  if (!id) return null;\n  const options = [];\n  const seen = new Set();\n  for (const raw of Array.isArray(source.options) ? source.options : []) {\n    const option = record(raw);\n    const optionID = text(option.value || option.id);\n    if (!optionID || seen.has(optionID)) continue;\n    seen.add(optionID);\n    options.push({ id: optionID, label: text(option.name || option.label) || optionID, ...(text(option.description) ? { description: text(option.description) } : {}) });\n  }\n  return {\n    id,\n    name: text(source.name) || id,\n    category: normalizeUpdateKind(source.category),\n    currentValue: text(source.currentValue || source.current_value),\n    options,\n  };\n}\nfunction acpProviderToolEvent(source) {\n  const callId = text(source.toolCallId || source.tool_call_id || source.id);\n  if (!callId) return null;\n  const status = normalizeUpdateKind(source.status);\n  const finished = ['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled'].includes(status);\n  const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(status);\n  const tool = text(source.title) || text(source.kind) || 'agent-tool';\n  const argumentsJson = traceJson(source.rawInput ?? source.raw_input ?? source.input ?? {});\n  const detail = contentText(source.content) || traceDetail(source.rawOutput ?? source.raw_output ?? source.output);\n  return {\n    type: finished ? 'tool.finished' : 'tool.started',\n    callId,\n    tool,\n    argumentsJson,\n    ...(finished ? { success: !failed } : {}),\n    ...(detail ? { message: detail } : {}),\n  };\n}\nfunction traceJson(value) {\n  try { return JSON.stringify(value && typeof value === 'object' ? value : { value: String(value ?? '') }).slice(0, 20_000); }\n  catch { return '{}'; }\n}\nfunction traceDetail(value) {\n  if (typeof value === 'string') return value.trim().slice(0, 2000);\n  if (value == null) return '';\n  try { return JSON.stringify(value).slice(0, 2000); } catch { return ''; }\n}\n",
    'ACP activity helpers',
)
write(path, s)

# 2) Bridge provider-native ACP events into the existing chat trace event stream.
path = 'src/runtime/journaled-tool-runtime.mjs'
s = read(path)
s = replace_once(
    s,
    "      onPreview: (content) => {\n        if (!messageId) return;\n        this.#emit({ type: 'message.preview', sessionId: options.sessionId, messageId, content });\n      },\n    });",
    "      onPreview: (content) => {\n        if (!messageId) return;\n        this.#emit({ type: 'message.preview', sessionId: options.sessionId, messageId, content });\n      },\n      onProviderEvent: (event) => {\n        if (!messageId || !event || typeof event !== 'object') return;\n        if (event.type === 'reasoning') {\n          const segment = typeof event.text === 'string' ? event.text.trim() : '';\n          if (segment) this.#emit({ type: 'message.reasoning', sessionId: options.sessionId, messageId, segment });\n          return;\n        }\n        if (event.type === 'tool.started' || event.type === 'tool.finished') {\n          this.#emit({ ...event, sessionId: options.sessionId, messageId });\n        }\n      },\n    });",
    'Journal provider event callback',
)
s = replace_once(
    s,
    "  #journal; #sessionId; #messageId; #projectRoot; #adapter; #pending = new Map(); #calls = new Map(); #lastFinished = null; #failure = null; #onReasoning; #onPreview;\n  constructor({ journal, sessionId, messageId = '', projectRoot, adapter, onReasoning = () => {}, onPreview = () => {} }) {\n    this.#journal = journal; this.#sessionId = sessionId; this.#messageId = messageId; this.#projectRoot = projectRoot; this.#adapter = adapter; this.#onReasoning = onReasoning; this.#onPreview = onPreview;\n  }",
    "  #journal; #sessionId; #messageId; #projectRoot; #adapter; #pending = new Map(); #calls = new Map(); #lastFinished = null; #failure = null; #onReasoning; #onPreview; #onProviderEvent;\n  constructor({ journal, sessionId, messageId = '', projectRoot, adapter, onReasoning = () => {}, onPreview = () => {}, onProviderEvent = () => {} }) {\n    this.#journal = journal; this.#sessionId = sessionId; this.#messageId = messageId; this.#projectRoot = projectRoot; this.#adapter = adapter; this.#onReasoning = onReasoning; this.#onPreview = onPreview; this.#onProviderEvent = onProviderEvent;\n  }",
    'Journal capture provider fields',
)
s = replace_once(
    s,
    "      response = await this.#adapter.stream(messages, { ...options, onDelta: previewDelta, ...(executeTool ? { executeTool } : {}) });",
    "      response = await this.#adapter.stream(messages, { ...options, onDelta: previewDelta, onProviderEvent: async (event) => this.#onProviderEvent(event), ...(executeTool ? { executeTool } : {}) });",
    'Journal provider callback injection',
)
write(path, s)

# 3) Main-process advertised catalog preserves ACP reasoning choices and discovers against selected model/effort.
path = 'src/main/provider-model-catalog.mjs'
s = read(path)
s = replace_once(
    s,
    "        const catalog = await discover(providerID);",
    "        const catalog = await discover(providerID, { configuration });",
    'Catalog discovery configuration',
)
s = replace_once(
    s,
    "  const declaredDefault = text(input.defaultModel || input.currentModel || input.currentValue);\n  const exactDefault = declaredDefault && models.some((item) => item.id === declaredDefault) ? declaredDefault : null;\n  const configured = text(configuredModel);\n  return {\n    providerID,\n    available: models.length > 0,\n    source,\n    models,\n    defaultModel: exactDefault,\n    configuredModel: configured || null,\n    fetchedAt: Date.now(),\n    ...(text(input.error) ? { error: text(input.error) } : {}),\n  };",
    "  const declaredDefault = text(input.defaultModel || input.currentModel || input.currentValue);\n  const exactDefault = declaredDefault && models.some((item) => item.id === declaredDefault) ? declaredDefault : null;\n  const configured = text(configuredModel);\n  const reasoningSource = record(input.reasoning);\n  const reasoningOptions = array(reasoningSource.options).flatMap((raw) => {\n    const item = record(raw);\n    const id = text(item.id || item.value);\n    return id ? [{ id, label: text(item.label || item.name) || id, ...(text(item.description) ? { description: text(item.description) } : {}) }] : [];\n  });\n  const reasoningConfigId = text(reasoningSource.configId || reasoningSource.id);\n  const reasoning = reasoningConfigId && reasoningOptions.length ? {\n    configId: reasoningConfigId,\n    currentValue: text(reasoningSource.currentValue) || null,\n    options: reasoningOptions,\n  } : null;\n  return {\n    providerID,\n    available: models.length > 0,\n    source,\n    models,\n    defaultModel: exactDefault,\n    configuredModel: configured || null,\n    fetchedAt: Date.now(),\n    ...(reasoning ? { reasoning } : {}),\n    ...(text(input.error) ? { error: text(input.error) } : {}),\n  };",
    'Catalog reasoning normalization',
)
write(path, s)

# 4) Persist exact advertised ACP effort instead of dropping it for preset/local providers.
path = 'src/main/provider-settings.mjs'
s = read(path)
s = replace_once(
    s,
    "      this.#primaryEffort = this.#value.providerID === 'codex' ? effortID(parsed.primaryEffort) : '';",
    "      this.#primaryEffort = effortID(parsed.primaryEffort);",
    'Load persisted effort',
)
s = replace_once(
    s,
    "      primaryEffort: projection.providerID === 'codex' ? (this.#primaryEffort || null) : (projection.primary?.variant ?? null),",
    "      primaryEffort: this.#primaryEffort || projection.primary?.variant || null,",
    'Renderer effort projection',
)
s = replace_once(
    s,
    "    return effective.providerID === 'codex' && this.#primaryEffort\n      ? { ...normalized, primaryEffort: this.#primaryEffort }\n      : normalized;",
    "    return this.#primaryEffort ? { ...normalized, primaryEffort: this.#primaryEffort } : normalized;",
    'Runtime effort projection',
)
old = """    const primaryEffort = preset ? '' : (typeof source.primaryEffort === 'string' ? source.primaryEffort.trim() : '');
    const secondaryEffort = secondaryAuto ? '' : preset ? '' : (typeof source.secondaryEffort === 'string' ? source.secondaryEffort.trim() : '');
    const chatGPTProvider = preset?.authType === 'chatgpt';
    const localCliProvider = preset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    const codexEffortProvided = providerID === 'codex' && Object.prototype.hasOwnProperty.call(source, 'primaryEffort');
    const codexEffort = providerID === 'codex'
      ? (codexEffortProvided ? effortID(source.primaryEffort) : (!providerChanged ? this.#primaryEffort : ''))
      : '';
"""
new = """    const chatGPTProvider = preset?.authType === 'chatgpt';
    const localCliProvider = preset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    const persistentEffortProvider = providerID === 'codex' || localCliProvider;
    const primaryEffortProvided = Object.prototype.hasOwnProperty.call(source, 'primaryEffort');
    const persistedPrimaryEffort = persistentEffortProvider
      ? (primaryEffortProvided ? effortID(source.primaryEffort) : (!providerChanged ? this.#primaryEffort : ''))
      : '';
    const primaryEffort = preset ? '' : (typeof source.primaryEffort === 'string' ? source.primaryEffort.trim() : '');
    const secondaryEffort = secondaryAuto ? '' : preset ? '' : (typeof source.secondaryEffort === 'string' ? source.secondaryEffort.trim() : '');
"""
s = replace_once(s, old, new, 'Persisted local CLI effort logic')
s = replace_once(s, "    this.#primaryEffort = codexEffort;", "    this.#primaryEffort = persistedPrimaryEffort;", 'Save persisted effort')
write(path, s)

# 5) Renderer type carries advertised ACP reasoning selector.
path = 'src/renderer/types.ts'
s = read(path)
s = replace_once(
    s,
    "  error?: string;\n  models: Array<{",
    "  error?: string;\n  reasoning?: {\n    configId: string;\n    currentValue?: string | null;\n    options: Array<{ id: string; label?: string; description?: string }>;\n  };\n  models: Array<{",
    'ProviderModelCatalog reasoning type',
)
write(path, s)

# 6) Model picker uses provider-advertised effort values for ACP providers.
path = 'src/renderer/react/ModelPicker.tsx'
s = read(path)
s = s.replace('modelEffortState(providerID, configuredModel, settings, codex)', 'modelEffortState(providerID, configuredModel, settings, codex, advertised)')
s = s.replace('modelEffortState(currentProvider, id, current, codex)', 'modelEffortState(currentProvider, id, current, codex, advertised)')
s = s.replace('effortForModel(slot, currentProvider, id, current, codex)', 'effortForModel(slot, currentProvider, id, current, codex, advertised)')
s = replace_once(
    s,
    "function modelEffortState(providerID: string, modelID: string, settings: ProviderSettings | null, codex: CodexModelCatalog) {\n  if (providerID === 'codex') {",
    "function modelEffortState(providerID: string, modelID: string, settings: ProviderSettings | null, codex: CodexModelCatalog, advertised: ProviderModelCatalog) {\n  if (providerID === 'codex') {",
    'Model effort signature',
)
s = replace_once(
    s,
    "  const model = settings?.models?.find((item) => item.providerID === providerID && item.modelID === modelID);\n  return {\n    options: model?.variants ?? [],\n    defaultEffort: '',\n  };",
    "  const advertisedReasoning = advertised.providerID === providerID\n    && advertised.source === 'acp'\n    && advertised.configuredModel === modelID\n    ? advertised.reasoning\n    : null;\n  if (advertisedReasoning?.options?.length) {\n    return {\n      options: advertisedReasoning.options.map((item) => item.id),\n      defaultEffort: advertisedReasoning.currentValue || '',\n    };\n  }\n  const model = settings?.models?.find((item) => item.providerID === providerID && item.modelID === modelID);\n  return {\n    options: model?.variants ?? [],\n    defaultEffort: '',\n  };",
    'Advertised effort state',
)
s = replace_once(
    s,
    "function selectedEffort(slot: ModelSlot, providerID: string, settings: ProviderSettings | null) {\n  if (slot === 'primary' && providerID === 'codex') return String(settings?.primaryEffort ?? '').trim();",
    "function selectedEffort(slot: ModelSlot, providerID: string, settings: ProviderSettings | null) {\n  if (slot === 'primary' && settings?.primaryEffort) return String(settings.primaryEffort).trim();",
    'Selected effort persistence',
)
s = replace_once(
    s,
    "function effortForModel(slot: ModelSlot, providerID: string, modelID: string, settings: ProviderSettings, codex: CodexModelCatalog) {\n  const currentEffort = selectedEffort(slot, providerID, settings);\n  const state = modelEffortState(providerID, modelID, settings, codex);",
    "function effortForModel(slot: ModelSlot, providerID: string, modelID: string, settings: ProviderSettings, codex: CodexModelCatalog, advertised: ProviderModelCatalog) {\n  const currentEffort = selectedEffort(slot, providerID, settings);\n  const state = modelEffortState(providerID, modelID, settings, codex, advertised);",
    'Effort selection helper',
)
write(path, s)

# 7) Tests: generic ACP activity -> chat trace mapping.
path = 'test/reasoning-segmentation.test.mjs'
s = read(path)
s += '''\n\ntest('provider-native ACP reasoning and tool lifecycle are bridged into the chat trace', async () => {\n  const adapter = {\n    async stream(_messages, options) {\n      await options.onProviderEvent({ type: 'reasoning', text: 'Inspecting the repository.' });\n      await options.onProviderEvent({ type: 'tool.started', callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}' });\n      await options.onProviderEvent({ type: 'tool.finished', callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}', success: true, message: '2 matches' });\n      options.onDelta('Final answer.');\n      return { text: 'Final answer.', toolCalls: [] };\n    },\n  };\n  const h = harness(adapter);\n  await h.run();\n  assert.deepEqual(h.final, ['Final answer.']);\n  assert.ok(h.events.some((event) => event.type === 'message.reasoning' && event.messageId === 'msg_assistant' && event.segment === 'Inspecting the repository.'));\n  const started = h.events.find((event) => event.type === 'tool.started' && event.callId === 'acp_tool_1');\n  const finished = h.events.find((event) => event.type === 'tool.finished' && event.callId === 'acp_tool_1');\n  assert.equal(started?.messageId, 'msg_assistant');\n  assert.equal(started?.tool, 'search');\n  assert.equal(finished?.success, true);\n  assert.equal(finished?.message, '2 matches');\n});\n'''
write(path, s)

# 8) Tests: catalog exposes exact advertised thought-level values.
path = 'test/provider-model-catalog.test.mjs'
s = read(path)
s += '''\n\ntest('ACP catalog exposes provider-advertised reasoning levels without guessing', () => {\n  const catalog = acpModelCatalogFromSession({\n    configOptions: [\n      { id: 'model', category: 'model', type: 'select', currentValue: 'provider/model-x', options: [{ value: 'provider/model-x', name: 'Model X' }] },\n      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [\n        { value: 'minimal', name: 'Minimal' }, { value: 'medium', name: 'Medium' }, { value: 'xhigh', name: 'Extra High' },\n      ] },\n    ],\n  });\n  assert.equal(catalog.reasoning.configId, 'effort');\n  assert.equal(catalog.reasoning.currentValue, 'medium');\n  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['minimal', 'medium', 'xhigh']);\n});\n\ntest('provider model catalog preserves ACP reasoning metadata', async () => {\n  const catalog = await fetchProviderModelCatalog({ providerID: 'opencode', model: 'provider/model-x' }, {\n    acpDiscover: async (_providerID, options) => {\n      assert.equal(options.configuration.model, 'provider/model-x');\n      return {\n        models: [{ id: 'provider/model-x', label: 'Model X' }],\n        currentModel: 'provider/model-x',\n        reasoning: { configId: 'effort', currentValue: 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },\n      };\n    },\n  });\n  assert.equal(catalog.reasoning.configId, 'effort');\n  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['low', 'high']);\n});\n'''
write(path, s)

# 9) Integration fixture: changing model refreshes effort config; selected effort is applied before prompt; ACP activity is surfaced.
write('test/fixtures/fake-acp-config-agent.mjs', r'''import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let model = 'provider/model-a';
let effort = 'low';

function effortValues() {
  return model === 'provider/model-b' ? ['medium', 'max'] : ['low', 'high'];
}
function options() {
  const values = effortValues();
  if (!values.includes(effort)) effort = values[0];
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
      { value: 'provider/model-a', name: 'Model A' }, { value: 'provider/model-b', name: 'Model B' },
    ] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: values.map((value) => ({ value, name: value })) },
  ];
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'config-session', configOptions: options() } });
    return;
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') model = message.params.value;
    if (message.params.configId === 'effort') effort = message.params.value;
    write({ jsonrpc: '2.0', id: message.id, result: { configOptions: options() } });
    return;
  }
  if (message.method === 'session/prompt') {
    if (model !== 'provider/model-b' || effort !== 'max') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `wrong config ${model}/${effort}` } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting project.' } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', status: 'pending', kind: 'search', title: 'Search files', rawInput: { query: 'TODO' } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', kind: 'search', title: 'Search files', rawInput: { query: 'TODO' }, rawOutput: { matches: 2 } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
''')

path = 'test/acp-cli-provider.test.mjs'
s = read(path)
s += '''\n\ntest('ACP provider applies advertised model and reasoning effort and surfaces native activity', async () => {\n  const configFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));\n  const provider = new AcpCliAgentProvider({\n    providerID: 'opencode',\n    cliCommand: process.execPath,\n    cliArgs: [configFixture],\n    primary: { providerID: 'opencode', modelID: 'provider/model-b' },\n    primaryEffort: 'max',\n  });\n  const activity = [];\n  let streamed = '';\n  const result = await provider.stream([{ role: 'user', content: 'Inspect.' }], {\n    projectRoot: tmpdir(),\n    onDelta: async (delta) => { streamed += delta; },\n    onProviderEvent: async (event) => { activity.push(event); },\n  });\n  assert.equal(result.text, 'Done.');\n  assert.equal(streamed, 'Done.');\n  assert.deepEqual(activity.map((event) => event.type), ['reasoning', 'tool.started', 'tool.finished']);\n  assert.equal(activity[0].text, 'Inspecting project.');\n  assert.equal(activity[1].callId, 'tool-1');\n  assert.equal(activity[1].tool, 'Search files');\n  assert.equal(activity[2].success, true);\n});\n'''
write(path, s)

# 10) Renderer contract catches regressions where ACP advertised effort is ignored.
path = 'test/provider-model-renderer-sync.test.mjs'
s = read(path)
s += '''\n\ntest('ModelPicker reads ACP-advertised reasoning options', async () => {\n  const source = await readFile(join(root, 'src/renderer/react/ModelPicker.tsx'), 'utf8');\n  assert.match(source, /advertised\.reasoning/);\n  assert.match(source, /settings\?\.primaryEffort/);\n});\n'''
write(path, s)

print('patched ACP activity + advertised effort pipeline')
