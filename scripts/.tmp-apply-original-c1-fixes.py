from pathlib import Path


def patch(path, replacements):
    file = Path(path)
    text = file.read_text()
    for before, after, label in replacements:
        if before not in text:
            raise RuntimeError(f"missing replacement {label} in {path}")
        text = text.replace(before, after, 1)
    file.write_text(text)


patch('src/runtime/service.mjs', [
    (
        "this.#batchEdits = batchEdits ?? new TstBatchEditManager({ tst: this.#tst, journal: this.#journal, emit: this.#emit });",
        "this.#batchEdits = batchEdits ?? new TstBatchEditManager({ tst: this.#tst, journal: this.#journal, writer: this.#writer, emit: this.#emit });",
        'shared batch writer',
    ),
    (
'''    const observed = await this.#tst.observeMemory(sessionId, {
      key: `validation:${Object.keys(fileHashes).sort().join(',').slice(0, 120)}`,
      value: `Validation passed for current workspace hashes using: ${commandText}`,
      kind: 'behavioral_claim', scope: 'session', provenance: 'tool', file_hashes: fileHashes,
    });
    const memoryId = observed?.id;
    if (!memoryId) return { recorded: false };
    for (const [path, hash] of Object.entries(fileHashes)) {
      await this.#tst.recordEvidence(sessionId, memoryId, 'content_hash', `validation:${path}:${commandText}`, true, hash).catch(() => undefined);
    }
    return { recorded: true, memoryId };''',
'''    const observed = await this.#tst.observeMemory(sessionId, {
      key: `validation:${Object.keys(fileHashes).sort().join(',').slice(0, 120)}`,
      value: `Validation passed for current workspace hashes using: ${commandText}`,
      kind: 'behavioral_claim', scope: 'session', provenance: 'verifier', file_hashes: fileHashes,
    });
    const memoryId = observed?.id;
    if (!memoryId) return { recorded: false };
    for (const item of validation.commands ?? []) {
      if (item?.exitCode === 0 && item?.command) {
        await this.#tst.recordEvidence(sessionId, memoryId, 'command_success', `validation:${String(item.command).slice(0, 420)}`, true).catch(() => undefined);
      }
    }
    for (const [path, hash] of Object.entries(fileHashes)) {
      await this.#tst.recordEvidence(sessionId, memoryId, 'content_hash', `validation:${path}:${commandText}`, true, hash).catch(() => undefined);
    }
    return { recorded: true, memoryId };''',
        'verifier promotion evidence',
    ),
    (
'''        onPaths: async (paths, mutation) => {
          if (mutation) await this.#refreshMutationGraph(paths);
          if (!projectId || process.env.CUPPET_PE3 === '0') return;
          await this.#pe3Observe(sessionId, paths, mutation);
        },''',
'''        onPaths: async (paths, mutation, details = null) => {
          if (mutation && details?.graphHandled !== true) await this.#refreshMutationGraph(paths);
          if (!projectId || process.env.CUPPET_PE3 === '0') return;
          await this.#pe3Observe(sessionId, paths, mutation);
        },''',
        'single graph barrier',
    ),
])

patch('src/runtime/tool-runtime.mjs', [
    (
        "if (result.success && result.paths.length) await onPaths(result.paths, result.mutation).catch(() => undefined);",
        "if (result.success && result.paths.length) await onPaths(result.paths, result.mutation, result.details ?? null).catch(() => undefined);",
        'path metadata callback',
    ),
    (
'''      await this.#recordToolObservation(sessionId, call.name, result.paths?.[0] ?? '').catch(() => undefined);
      return { output, success: true, paths: result.paths ?? [], mutation: Boolean(result.mutation), validation: result.validation ?? null };''',
'''      if (result.details?.prepared !== true) await this.#recordToolObservation(sessionId, call.name, result.paths?.[0] ?? '').catch(() => undefined);
      return { output, success: true, paths: result.paths ?? [], mutation: Boolean(result.mutation), validation: result.validation ?? null, details: result.details ?? null };''',
        'prepare is not durable observation',
    ),
    (
        "return { output: `TST EDIT BATCH PREPARED (no files written)\\nbatch_id: ${batch.id}\\ndiff_digest: ${batch.diffDigest}\\npaths: ${batch.paths.join(', ')}\\n\\n${batch.diff}`, paths: [], mutation: false };",
        "return { output: `TST EDIT BATCH PREPARED (no files written)\\nbatch_id: ${batch.id}\\ndiff_digest: ${batch.diffDigest}\\npaths: ${batch.paths.join(', ')}\\n\\n${batch.diff}`, paths: [], mutation: false, details: { prepared: true, batchId: batch.id, diffDigest: batch.diffDigest } };",
        'prepare metadata',
    ),
    (
'''      paths: result.paths, mutation: true,
    };''',
'''      paths: result.paths, mutation: true,
      details: { graphHandled: true, graphReady: result.graphReady, batchId: result.id, diffDigest: result.diffDigest },
    };''',
        'batch graph receipt metadata',
    ),
])

patch('src/runtime/journaled-tool-runtime.mjs', [
    (
'''        onPaths: async (paths, mutation) => {
          await capture.onPaths(paths, mutation);
          await options.onPaths?.(paths, mutation);
        },''',
'''        onPaths: async (paths, mutation, details = null) => {
          await capture.onPaths(paths, mutation);
          await options.onPaths?.(paths, mutation, details);
        },''',
        'forward graph metadata',
    ),
])

patch('src/runtime/tst-edit-batches.mjs', [
    (
        "const mismatches = freshBatch.files.filter((file) => returned.has(file.path) && returned.get(file.path) !== file.afterHash).map((file) => file.path);",
        "const mismatches = freshBatch.files.filter((file) => !returned.has(file.path) || returned.get(file.path) !== file.afterHash).map((file) => file.path);",
        'missing refresh path is stale',
    ),
])
