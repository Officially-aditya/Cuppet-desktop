import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Gives RuntimeService a database view that can atomically accept the current
 * command when its durable SQLite mutation commits. The underlying
 * ConversationDatabase remains the only SQL owner.
 *
 * This closes crash windows where a durable mutation could commit while its
 * command receipt remained `processing` and would become `unknown` after a
 * runtime restart.
 */
export class CommandReceiptDatabaseFacade {
  #database;
  #receipts;
  #context = new AsyncLocalStorage();
  #view;

  constructor(database, receiptStore) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('CommandReceiptDatabaseFacade requires a conversation database');
    if (!receiptStore || typeof receiptStore.accept !== 'function') throw new TypeError('CommandReceiptDatabaseFacade requires a command receipt store');
    this.#database = database;
    this.#receipts = receiptStore;
    this.#view = new Proxy(database, {
      get: (target, property) => {
        if (property === 'transaction') return (callback) => this.#transaction(callback);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  get database() {
    return this.#view;
  }

  run(command, callback) {
    if (typeof callback !== 'function') throw new TypeError('Command callback is required');
    const normalized = normalizeCommand(command);
    return this.#context.run(normalized, callback);
  }

  #transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('SQLite transaction callback is required');
    return this.#database.transaction(() => {
      const result = callback();
      if (result && typeof result.then === 'function') throw new Error('SQLite transaction callback must be synchronous');
      this.#acceptCommittedCommand(result);
      return result;
    });
  }

  #acceptCommittedCommand(result) {
    const command = this.#context.getStore();
    if (!command?.commandId) return;
    if (command.method === 'session.send') {
      const delivery = committedTurnDelivery(result);
      if (!delivery) return;
      this.#receipts.accept(command.commandId, {
        accepted: true,
        sessionId: delivery.sessionId,
        sourceSessionId: command.sourceSessionId,
        messageId: delivery.messageId,
        projectId: delivery.projectId,
        committed: true,
      });
      return;
    }
    if (command.method === 'session.create') {
      const session = committedSessionCreation(result);
      if (!session) return;
      this.#receipts.accept(command.commandId, session);
    }
  }
}

export function committedTurnDelivery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assistant = record(value.assistant);
  const user = record(value.user);
  const target = record(value.targetSession);
  const messageId = text(assistant.id);
  const sessionId = text(assistant.sessionId || user.sessionId || target.id);
  if (!messageId || !sessionId || assistant.role !== 'assistant' || assistant.status !== 'streaming') return null;
  if (!text(user.id) || user.role !== 'user') return null;
  return {
    sessionId,
    messageId,
    projectId: nullableText(target.projectId),
  };
}

export function committedSessionCreation(value) {
  const session = record(value);
  const id = text(session.id);
  if (!id || !id.startsWith('session_')) return null;
  if (typeof session.title !== 'string' || !Number.isFinite(Number(session.createdAt)) || !Number.isFinite(Number(session.updatedAt))) return null;
  return structuredClone(session);
}

function normalizeCommand(value) {
  const source = record(value);
  return Object.freeze({
    commandId: text(source.commandId),
    method: text(source.method),
    sourceSessionId: nullableText(source.sourceSessionId),
  });
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}
function nullableText(value) {
  const result = text(value);
  return result || null;
}
