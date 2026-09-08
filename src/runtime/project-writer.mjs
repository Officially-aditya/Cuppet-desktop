import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export class ProjectWriter {
  #tails = new Map();

  async withProject(projectRoot, operation) {
    if (!projectRoot) throw new Error('Project mutation requires a project workspace');
    const root = await realpath(projectRoot).catch(() => resolve(projectRoot));
    const prior = this.#tails.get(root) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolvePromise) => { release = resolvePromise; });
    const tail = prior.catch(() => undefined).then(() => turn);
    this.#tails.set(root, tail);
    await prior.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (this.#tails.get(root) === tail) this.#tails.delete(root);
    }
  }

  get activeProjects() { return this.#tails.size; }
}
