import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'package.json',
  'src/runtime/tst-client.mjs',
  'src/runtime/tst-edit-batches.mjs',
  'src/runtime/project-writer.mjs',
  'src/runtime/tool-runtime.mjs',
  'src/runtime/journaled-tool-runtime.mjs',
  'src/runtime/mutation-journal.mjs',
  'src/runtime/permissions.mjs',
  'src/runtime/service.mjs',
  'migration/original-c1-contract.json',
  'docs/original-c1-completion.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const dense = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, value.replace(/\s+/g, '')]));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(text['package.json']);
expect(pkg.scripts?.['original-c1:verify'] === 'node scripts/verify-original-c1.mjs', 'original C1 verifier script is not registered');

const client = text['src/runtime/tst-client.mjs'];
for (const capability of ['edit.resolve_targets', 'edit.parse_staged', 'graph.refresh_paths']) expect(client.includes(capability), `TST C1 capability missing: ${capability}`);
expect(client.includes("export const TST_PROTOCOL_VERSION = 'cuppet.tst.v3'"), 'TST protocol boundary changed');
expect(client.includes('supports(capability)') && client.includes('Connected TST daemon does not support'), 'TST capability negotiation is not fail-closed');

const batches = text['src/runtime/tst-edit-batches.mjs']; const batchesDense = dense['src/runtime/tst-edit-batches.mjs'];
for (const operation of ['replace_node','insert_before_node','insert_after_node','delete_node','replace_text','create_file']) expect(batches.includes(operation), `batch operation missing: ${operation}`);
expect(batches.includes('expected_source') && batches.includes('base_hash') && batches.includes('start_byte') && batches.includes('end_byte'), 'revision-bound target validation is incomplete');
expect(batches.includes('introduced_syntax_errors') && batches.includes('parseStaged'), 'staged Tree-sitter parse gate is missing');
expect(batches.includes('Batch target validation failed; nothing was written.') && batches.includes('Batch became stale before apply; nothing was written.'), 'zero-write conflict boundary is missing');
expect(batches.includes('beginBatch') && batches.includes("tool: 'tst_edit_batch'"), 'multi-file batch undo checkpoint is missing');
expect(batches.includes('fingerprintKey: `tst-batch:${batchId}:${freshBatch.diffDigest}`'), 'permission is not bound to the prepared batch/diff digest');
expect(batches.includes('atomicPublish') && batches.includes('post-write hash mismatch'), 'checked atomic file publication is missing');
expect(batches.includes('refreshGraphPaths(paths)') && batches.includes('!returned.has(file.path) || returned.get(file.path) !== file.afterHash'), 'graph refresh receipt must cover every final file hash');
expect(batches.includes('this.#writer?.withProject') && !batches.includes('#projectLocks'), 'batch publication does not use the shared project writer');

const writer = text['src/runtime/project-writer.mjs'];
expect(writer.includes('withProject(projectRoot, operation)') && writer.includes('#queues'), 'shared per-project writer is missing');

const tools = text['src/runtime/tool-runtime.mjs']; const toolsDense = dense['src/runtime/tool-runtime.mjs'];
for (const name of ['tst_explore','tst_read','tst_edit_batch','tst_validate']) expect(tools.includes(`'${name}'`), `model-facing original C1 tool missing: ${name}`);
expect(tools.includes('REVISION-BOUND EDIT TARGETS') && tools.includes('validateReadTarget'), 'explore/read revision-ref flow is missing');
expect(tools.includes('PREPARED (no files written)') && tools.includes('details: { prepared: true'), 'prepare is not explicitly write-free');
expect(tools.includes("if (result.details?.prepared !== true) await this.#recordToolObservation"), 'prepared batches can leak into durable action observations');
expect(tools.includes('mutatedDuringValidation') && tools.includes('fileHashes: postHashes'), 'validation is not bound to stable post-edit hashes');
expect(tools.includes('safeShellEnvironment()') && tools.includes('^CUPPET_.*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)'), 'child shell secret scrubbing is missing');
expect(toolsDense.includes('details:{graphHandled:true,graphReady:result.graphReady'), 'batch graph-refresh receipt is not propagated to the runtime');

const wrapper = text['src/runtime/journaled-tool-runtime.mjs'];
expect(wrapper.includes('onPaths: async (paths, mutation, details = null)') && wrapper.includes('options.onPaths?.(paths, mutation, details)'), 'journal wrapper drops graph receipt metadata');

const journal = text['src/runtime/mutation-journal.mjs'];
expect(journal.includes("kind: 'batch'") && journal.includes('beginBatch(') && journal.includes('commitBatch('), 'multi-file mutation journal entries are missing');
expect(journal.includes('for (const file of entry.files)') && journal.includes('snapshotMatches(current, file.after)'), 'batch undo does not precheck every current postimage');
expect(journal.includes('contentBase64') && !/git\s+(?:reset|checkout|clean|restore)\b/i.test(journal), 'undo must remain byte-exact and non-destructive');

const permissions = text['src/runtime/permissions.mjs'];
expect(permissions.includes('fingerprintKey') && permissions.includes('permissionFingerprint(action, normalized, fingerprintKey)'), 'exact batch/diff permission fingerprinting is missing');

const service = text['src/runtime/service.mjs']; const serviceDense = dense['src/runtime/service.mjs'];
expect(service.includes('new ProjectWriter()'), 'runtime does not own shared project writer');
expect(service.includes('new TstBatchEditManager({ tst: this.#tst, journal: this.#journal, writer: this.#writer'), 'batch manager does not share runtime project writer');
expect(service.includes('writer: this.#writer') && service.includes('new JournaledToolRuntime'), 'tool runtime does not share runtime project writer');
expect(service.includes('details?.graphHandled !== true') && service.includes('#refreshMutationGraph'), 'runtime duplicates or skips the graph-refresh barrier incorrectly');
expect(service.includes("provenance: 'verifier'") && service.includes("'command_success'") && service.includes("'content_hash'"), 'validation evidence does not satisfy TST verifier promotion policy');
expect(serviceDense.includes('this.#writer.withProject(project.canonicalPath,()=>this.#journal.undoLatest'), 'Undo does not share project mutation serialization');

const contract = JSON.parse(text['migration/original-c1-contract.json']);
expect(contract.phase === 'original-C1' && contract.requirements?.prepareWritesFilesystem === false, 'original C1 machine contract identity/write-free prepare invalid');
expect(contract.requirements?.sharedProjectWriter === true && contract.requirements?.graphRefreshReceiptRequired === true && contract.requirements?.validationBoundToPostEditHashes === true, 'original C1 machine contract invariants incomplete');
expect(contract.requirements?.genericTextMutationIsFallback === true && contract.requirements?.preparedBatchCreatesMutationEvidence === false, 'original C1 fallback/evidence contract invalid');

expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /@opencode|opencode-ai|OpenCode-derived controller/i.test(value)), 'legacy OpenCode production dependency leaked into original C1');

for (const script of ['src/runtime/tst-client.mjs','src/runtime/tst-edit-batches.mjs','src/runtime/tool-runtime.mjs','src/runtime/service.mjs']) {
  const checked = spawnSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}
const tests = ['test/original-c1-batch-edit.test.mjs','test/original-c1-tool-loop.test.mjs'];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Original C1 gate passed: revision-bound structural discovery/read, staged multi-file prepare/apply, shared mutation serialization, graph receipts, verifier evidence, and conflict-safe undo verified.');
