import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export class ProjectWriter {
  #tails = new Map();
  #registrationTail = Promise.resolve();

  async withProject(projectRoot, operation) {
    if (!projectRoot) throw new Error('Project mutation requires a project workspace');
    if (typeof operation !== 'function') throw new TypeError('Project mutation operation is required');

    // Canonicalization is asynchronous. Register it behind a tiny global chain so two
    // calls for the same project cannot overtake one another before they reach #tails.
    // Only registration is serialized globally; operations remain isolated per project.
    const registration = this.#registrationTail
      .catch(() => undefined)
      .then(async () => {
        const root = await realpath(projectRoot).catch(() => resolve(projectRoot));
        const prior = this.#tails.get(root) ?? Promise.resolve();
        let release;
        const turn = new Promise((resolvePromise) => { release = resolvePromise; });
        const tail = prior.catch(() => undefined).then(() => turn);
        this.#tails.set(root, tail);
        return { root, prior, release, tail };
      });
    this.#registrationTail = registration.then(() => undefined, () => undefined);

    const { root, prior, release, tail } = await registration;
    await prior.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (this.#tails.get(root) === tail) this.#tails.delete(root);
    }
  }

  get activeProjects() { return this.#tails.size; }
}
