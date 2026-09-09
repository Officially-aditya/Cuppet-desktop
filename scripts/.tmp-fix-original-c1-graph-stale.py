from pathlib import Path

path = Path('src/runtime/tst-edit-batches.mjs')
text = path.read_text()
old = '''  async ensureGraphFresh(projectRoot) {
    const root = await canonicalRoot(projectRoot);
    const stale = this.#graphStale.get(root);
    if (!stale?.length) return { ready: true };
    try {
      const refresh = await this.#tst.refreshGraphPaths(stale);
      this.#graphStale.delete(root);
      return { ready: true, recovered: true, refresh };
    } catch (error) {
      return { ready: false, reason: `TST graph refresh is required before another structural operation: ${cleanError(error)}` };
    }
  }
'''
new = '''  async ensureGraphFresh(projectRoot) {
    const root = await canonicalRoot(projectRoot);
    const stale = this.#graphStale.get(root);
    if (!stale?.length) return { ready: true };
    try {
      const expected = new Map();
      for (const path of stale) {
        const target = await resolveWorkspacePath(root, path, true);
        const current = await snapshotBytes(target.absolute);
        if (!current.exists || !current.hash) {
          return { ready: false, reason: `TST graph refresh is required before another structural operation: current file is unavailable for ${path}` };
        }
        expected.set(path, current.hash);
      }
      const refresh = await this.#tst.refreshGraphPaths(stale);
      const returned = new Map((refresh?.paths ?? []).map((item) => [String(item.path), item.content_hash ?? null]));
      const mismatches = stale.filter((path) => !returned.has(path) || returned.get(path) !== expected.get(path));
      if (mismatches.length) {
        return { ready: false, reason: `TST graph refresh is required before another structural operation: refresh did not acknowledge current hashes for ${mismatches.join(', ')}` };
      }
      this.#graphStale.delete(root);
      return { ready: true, recovered: true, refresh };
    } catch (error) {
      return { ready: false, reason: `TST graph refresh is required before another structural operation: ${cleanError(error)}` };
    }
  }
'''
if old not in text:
    raise SystemExit('ensureGraphFresh block not found')
path.write_text(text.replace(old, new, 1))
