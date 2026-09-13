const DURABLE_MUTATION_EVENTS = new Set([
  'edit.batch.prepared',
  'edit.batch.applied',
  'mutation.recovered',
  'mutation.recovery.conflict',
  'mutation.undone',
]);

export function durableRuntimeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = text(event.type, 160);
  const sessionId = text(event.sessionId, 2000);
  if (!type || !sessionId || !DURABLE_MUTATION_EVENTS.has(type)) return null;

  switch (type) {
    case 'edit.batch.prepared':
      return record(sessionId, type, {
        batchId: text(event.batchId, 240),
        paths: paths(event.paths),
        diffDigest: digest(event.diffDigest),
      });
    case 'edit.batch.applied':
      return record(sessionId, type, {
        batchId: text(event.batchId, 240),
        paths: paths(event.paths),
        diffDigest: digest(event.diffDigest),
        graphReady: event.graphReady === true,
        graphError: optionalMessage(event.graphError),
      });
    case 'mutation.recovered':
      return record(sessionId, type, {
        mutationId: text(event.mutationId, 240),
        restoredFiles: integer(event.restoredFiles),
      });
    case 'mutation.recovery.conflict':
      return record(sessionId, type, {
        mutationId: text(event.mutationId, 240),
        path: optionalPath(event.path),
        message: optionalMessage(event.message),
      });
    case 'mutation.undone':
      return record(sessionId, type, {
        mutationId: text(event.mutationId, 240),
        projectId: text(event.projectId, 240),
        tool: text(event.tool, 240),
        paths: paths(event.paths ?? (event.path ? [event.path] : [])),
      });
    default:
      return null;
  }
}

export function persistDurableRuntimeEvent(event, store) {
  const durable = durableRuntimeEvent(event);
  if (!durable) return { required: false, persisted: false, durable: null };
  if (!store || typeof store.recordEvent !== 'function') throw new TypeError('durable runtime events require a recordEvent-capable store');
  store.recordEvent(durable);
  return { required: true, persisted: true, durable };
}

function record(sessionId, type, payload) {
  return { sessionId, type, payload: compact(payload) };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && !(Array.isArray(item) && item.length === 0)));
}

function paths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => optionalPath(item)).filter(Boolean))].slice(0, 64);
}

function optionalPath(value) {
  return text(value, 512);
}

function optionalMessage(value) {
  const result = text(value, 1000);
  return result ? result.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]') : null;
}

function digest(value) {
  const result = text(value, 128)?.toLowerCase() ?? null;
  return result && /^[a-f0-9]{32,128}$/.test(result) ? result : null;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function text(value, limit) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result ? result.slice(0, limit) : null;
}
