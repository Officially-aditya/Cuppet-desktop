export class SessionCommandSerializer {
  #tails = new Map();

  get activeSessions() {
    return this.#tails.size;
  }

  run(sessionId, work) {
    const key = requiredSessionId(sessionId);
    if (typeof work !== 'function') throw new TypeError('SessionCommandSerializer requires a work function');

    const previous = this.#tails.get(key) ?? Promise.resolve();
    const execution = previous.then(() => work());
    const barrier = execution.then(() => undefined, () => undefined);
    this.#tails.set(key, barrier);

    return execution.finally(() => {
      if (this.#tails.get(key) === barrier) this.#tails.delete(key);
    });
  }
}

function requiredSessionId(value) {
  const sessionId = typeof value === 'string' ? value.trim().slice(0, 256) : '';
  if (!sessionId) throw new Error('sessionId is required');
  return sessionId;
}
