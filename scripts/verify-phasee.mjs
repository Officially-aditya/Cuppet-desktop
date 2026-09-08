import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'package.json',
  'src/runtime/database.mjs','src/runtime/lossless-plan.mjs','src/runtime/diagnostics.mjs','src/runtime/questions.mjs','src/runtime/mutation-journal.mjs','src/runtime/journaled-tool-runtime.mjs','src/runtime/service.mjs',
  'src/runtime/remote/protocol.mjs','src/runtime/remote/commands.mjs','src/cli/main.mjs','src/main/main.mjs','src/preload/preload.cjs','src/renderer/index.html','src/renderer/questions.js','src/renderer/undo.js','src/remote-app/index.html','src/remote-app/app.js','src/remote-app/sw.js',
  'migration/phase-e-contract.json','docs/phase-e-session-control.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const dense = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, value.replace(/\s+/g, '')]));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(text['package.json']);
expect(pkg.version === '0.8.0-alpha.1', 'Phase E package version is not 0.8.0-alpha.1');
expect(pkg.scripts?.['phasee:verify'] === 'node scripts/verify-phasee.mjs', 'Phase E verifier script is not registered');

const database = text['src/runtime/database.mjs'];
expect(database.includes('forkSession({ sourceSessionId') && database.includes('this.transaction(() =>'), 'transactional session fork is missing');
expect(database.includes('projectId: source.projectId') && database.includes('messageMap[message.id]'), 'fork no longer preserves project/transcript identity mapping');
const forkBlock = database.split('forkSession(')[1]?.split('createToolExecution(')[0] ?? '';
expect(!forkBlock.includes('tool_executions') && !forkBlock.includes('listToolExecutions'), 'session fork appears to clone historical tool audit');

const plans = text['src/runtime/lossless-plan.mjs'];
expect(plans.includes('async fork(sourceSessionID, targetSessionID, messageMap') && plans.includes('sourceMessageID: mapID(item.sourceMessageID)') && plans.includes('messageID: mapID(item.messageID)'), 'lossless plan fork/remapping missing');

const questions = text['src/runtime/questions.mjs']; const questionsDense = dense['src/runtime/questions.mjs'];
expect(questions.includes('MAX_QUESTIONS = 8') && questions.includes('MAX_OPTIONS = 12') && questions.includes('MAX_ANSWER_VALUES = 12') && questionsDense.includes('clean(item,512)'), 'question bounds changed');
expect(questions.includes('QuestionInteractionRequiredError') && questions.includes('QuestionRejectedError'), 'question fail-closed/rejection errors missing');
expect(questionsDense.includes('if(!this.#interactive)thrownewQuestionInteractionRequiredError'), 'noninteractive question path no longer fails closed');
expect(questions.includes("type: 'question.requested'") && questions.includes("type: 'question.resolved'"), 'question lifecycle events missing');

const journal = text['src/runtime/mutation-journal.mjs']; const journalDense = dense['src/runtime/mutation-journal.mjs'];
expect(journal.includes("createHash('sha256')") && journal.includes('UndoConflictError') && journal.includes('snapshotMatches(current, entry.after)'), 'hash-checked undo conflict boundary missing');
expect(journal.includes("kind: 'barrier'") && journal.includes("entry.kind !== 'file'"), 'opaque mutation barrier missing');
expect(journal.includes('mode: 0o700') && journal.includes('mode: 0o600') && journal.includes('rename(temporary, target)'), 'private atomic journal persistence missing');
expect(journal.includes('MAX_SNAPSHOT_BYTES = 1024 * 1024') && journal.includes('MAX_ENTRIES = 256'), 'mutation journal bounds changed');
expect(journal.includes('contentBase64') && journal.includes("Buffer.from(entry.before.contentBase64, 'base64')") && journal.includes('const content = await readFile(path);'), 'mutation journal no longer preserves raw preimage bytes');
expect(journalDense.includes('if(entry.projectRoot!==currentRoot)thrownewUndoConflictError'), 'undo is not bound to the original canonical workspace');
expect(!/git\s+(?:reset|checkout|clean|restore)\b/i.test(journal), 'mutation journal contains a destructive Git restoration path');

const wrapper = text['src/runtime/journaled-tool-runtime.mjs'];
expect(wrapper.includes("call?.name === 'workspace_edit' || call?.name === 'workspace_write'") && wrapper.includes('this.#journal.beginFile'), 'pre-mutation file snapshot hook missing');
expect(wrapper.includes("call?.name === 'bash'") && wrapper.includes('recordBarrier'), 'opaque shell mutation barrier hook missing');
expect(wrapper.includes('finished.event.executionId') && wrapper.includes('finished.pending.token.executionId'), 'journal entries are not bound to durable tool execution ids');

const service = text['src/runtime/service.mjs'];
expect(service.includes("new QuestionBroker({ emit: this.#emit, interactive })") && service.includes("new MutationJournal(join(dataDir, 'mutation-journal'))") && service.includes('new JournaledToolRuntime'), 'runtime does not own question/journal authorities');
for (const method of ['question.list','question.reply','question.reject','session.undo.status','session.undo']) expect(service.includes(`case '${method}'`), `runtime method missing: ${method}`);
expect(service.includes("if (this.#runs.has(session.id)) throw new Error('Cannot undo while this session is generating. Stop it first.')"), 'undo no longer rejects an active generation');

const protocol = dense['src/runtime/remote/protocol.mjs'];
expect(protocol.includes("'question.list':'session.read'") && protocol.includes("'question.reply':'question.write'") && protocol.includes("'question.reject':'question.write'"), 'Remote question scopes changed');
expect(protocol.includes("'session.undo':'session.write'") && protocol.includes("'status':'session.read'") && protocol.includes("'doctor':'session.read'"), 'Remote undo/diagnostic scopes changed');

const remote = dense['src/runtime/remote/commands.mjs'];
expect(remote.includes("case'session.undo':returnthis.#call('session.undo'") && remote.includes("case'question.list':returnthis.#call('question.list'"), 'Remote no longer delegates session/question authority to runtime');
expect(remote.includes("this.#call('question.reply'") && remote.includes("this.#call('question.reject'"), 'Remote question write delegation missing');

const cli = text['src/cli/main.mjs'];
expect(cli.includes("command==='undo'") && cli.includes("command==='status'") && cli.includes("command==='doctor'") && cli.includes("command==='sessions'"), 'headless E commands missing');
expect(cli.includes('flags.continue===true') && cli.includes('flags.fork===true') && cli.includes('db.forkSession') && cli.includes('pendingPlanFork.plans.fork'), 'headless continuation/fork semantics missing');

const main = text['src/main/main.mjs']; const preload = text['src/preload/preload.cjs'];
for (const ipc of ['cuppet:question:list','cuppet:question:reply','cuppet:question:reject','cuppet:session:undo:status','cuppet:session:undo']) expect(main.includes(ipc), `Electron privileged bridge missing: ${ipc}`);
expect(main.includes('validateQuestionAnswers') && main.includes('boundedId'), 'Electron question/undo payload bounding missing');
expect(preload.includes('questions:') && preload.includes('undoStatus:') && preload.includes('undo:'), 'preload E API missing');
expect(!preload.includes('runtime.request'), 'preload exposes an arbitrary runtime request path');

const desktopHtml = text['src/renderer/index.html'];
expect(desktopHtml.includes('id="undo-button"') && desktopHtml.includes('questions.js') && desktopHtml.includes('undo.js'), 'Desktop E controls are not loaded');
expect(text['src/renderer/questions.js'].includes('window.cuppet.questions.reply') && text['src/renderer/questions.js'].includes('window.cuppet.questions.reject') && text['src/renderer/questions.js'].includes('showNext'), 'Desktop question recovery/response path missing');
expect(text['src/renderer/undo.js'].includes('window.cuppet.sessions.undo') && text['src/renderer/undo.js'].includes('state.runningSessions'), 'Desktop undo controller missing active-run guard');

const remoteApp = text['src/remote-app/app.js'];
expect(text['src/remote-app/index.html'].includes('id="undo"') && remoteApp.includes("command('session.undo')"), 'browser Remote undo control missing');
expect(remoteApp.includes("case 'question.requested'") && remoteApp.includes("command('question.reply'") && remoteApp.includes("command('question.reject'") && remoteApp.includes("command('question.list')"), 'browser Remote question lifecycle/recovery missing');
expect(text['src/remote-app/sw.js'].includes("CACHE='cuppet-remote-v3'"), 'Remote PWA cache generation was not advanced for E');

const contract = JSON.parse(text['migration/phase-e-contract.json']);
expect(contract.phase === 'E' && contract.version === '0.8.0-alpha.1', 'E machine contract identity invalid');
expect(contract.requirements?.sessionForkCopiesToolAudit === false && contract.requirements?.questionsNoninteractiveFailClosed === true && contract.requirements?.undoHashChecked === true && contract.requirements?.undoRestoresRawBytes === true && contract.requirements?.undoRequiresOriginalWorkspace === true && contract.requirements?.undoCrossesOpaqueShellBarrier === false && contract.requirements?.undoOverwritesExternalEdits === false, 'E machine contract safety requirements invalid');
expect(contract.security?.undoUsesGitResetHard === false && contract.security?.undoUsesGitCheckoutRestore === false && contract.security?.undoUsesGitClean === false && contract.security?.undoRequiresCurrentPostimageMatch === true && contract.security?.undoRequiresOriginalWorkspace === true && contract.security?.journalSnapshotEncoding === 'base64', 'E undo security contract invalid');

expect(!Object.entries(text).some(([path, value]) => path.startsWith('src/') && /@opencode|opencode-ai|OpenCode-derived controller/i.test(value)), 'legacy runtime dependency leaked into E production source');

for (const script of ['src/renderer/questions.js','src/renderer/undo.js','src/remote-app/app.js']) {
  const checked = spawnSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}
const tests = ['test/phase-e-session-control.test.mjs','test/c2-remote-commands.test.mjs'];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase E gate passed: durable continuation/fork semantics, diagnostics, bounded question brokerage, scoped Desktop/Remote controls, and byte-exact hash-checked conflict-safe undo verified.');
