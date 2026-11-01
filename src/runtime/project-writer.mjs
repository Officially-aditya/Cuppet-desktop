import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Serialises workspace mutations per canonical project root.
 *
 * Two properties matter for interactive use:
 *  - waiting for the lock is abortable (Stop must work even while another chat holds the lock), and
 *  - the callback receives `lock.suspend(work)` so a long human wait (a permission prompt) can run
 *    WITHOUT holding the project lock; the lock is queued again before the callback continues.
 */
export class ProjectWriter {
  #tails = new Map();
  #registrationTail = Promise.resolve();

  async withProject(projectRoot, operation, { signal } = {}) {
    if (!projectRoot) throw new Error('Project mutation requires a project workspace');
    if (typeof operation !== 'function') throw new TypeError('Project mutation operation is required');

    // Canonicalization is asynchronous. Register it behind a tiny global chain so two
    // calls for the same project cannot overtake one another before they reach #tails.
    // Only registration is serialized globally; operations remain isolated per project.
    const registration = this.#registrationTail
      .catch(() => undefined)
      .then(async () => {
        const root = await realpath(projectRoot).catch(() => resolve(projectRoot));
        return { root, ticket: this.#enqueue(root) };
      });
    this.#registrationTail = registration.then(() => undefined, () => undefined);

    const { root, ticket: first } = await registration;
    let ticket = first;
    await this.#waitForTurn(root, ticket, signal);
    const lock = {
      suspend: async (work) => {
        this.#surrender(root, ticket);
        try { return await work(); }
        finally { ticket = this.#enqueue(root); await this.#waitForTurn(root, ticket, signal); }
      },
    };
    try { return await operation(lock); }
    finally { this.#surrender(root, ticket); }
  }

  get activeProjects() { return this.#tails.size; }

  #enqueue(root) {
    const prior = this.#tails.get(root) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolvePromise) => { release = resolvePromise; });
    const tail = prior.catch(() => undefined).then(() => turn);
    this.#tails.set(root, tail);
    return { prior, release, tail, done: false };
  }

  async #waitForTurn(root, ticket, signal) {
    try { await abortable(ticket.prior.catch(() => undefined), signal); }
    catch (error) { this.#surrender(root, ticket); throw error; }
  }

  #surrender(root, ticket) {
    if (ticket.done) return;
    ticket.done = true;
    ticket.release();
    if (this.#tails.get(root) === ticket.tail) this.#tails.delete(root);
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value); },
      (error) => { signal.removeEventListener('abort', onAbort); rejectPromise(error); },
    );
  });
}
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
