#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runtimeKey } from '../src/runtime/tst-supervisor.mjs';
import { TST_PROTOCOL_VERSION } from '../src/runtime/tst-client.mjs';
import { MANAGED_TST_SOURCE_REPOSITORY, MANAGED_TST_SOURCE_REVISION } from '../src/runtime/tst-release.mjs';

const runtime = runtimeKey();
if (!runtime) throw new Error(`Managed TST packaging is unsupported on ${process.platform}-${process.arch}`);
const directory = resolve(process.argv[2] ?? join('vendor', 'tst', runtime));
const metadata = JSON.parse(await readFile(join(directory, 'tst-runtime.json'), 'utf8'));
if (
  metadata.schema !== 1 || metadata.kind !== 'cuppet-desktop-tst-runtime' ||
  metadata.protocol !== TST_PROTOCOL_VERSION || metadata.runtime !== runtime ||
  metadata.platform !== process.platform || metadata.arch !== process.arch ||
  metadata.sourceRepository !== MANAGED_TST_SOURCE_REPOSITORY ||
  metadata.sourceRevision !== MANAGED_TST_SOURCE_REVISION ||
  metadata.sourceKind !== 'cuppet-tst-runtime' ||
  !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '')
) throw new Error(`Invalid staged TST runtime metadata in ${directory}`);
const sourceMetadata = JSON.parse(await readFile(join(directory, 'source-tst-runtime.json'), 'utf8'));
if (
  sourceMetadata.kind !== 'cuppet-tst-runtime' ||
  sourceMetadata.protocol !== TST_PROTOCOL_VERSION ||
  sourceMetadata.runtime !== runtime ||
  sourceMetadata.sourceRepository !== MANAGED_TST_SOURCE_REPOSITORY ||
  sourceMetadata.sourceRevision !== MANAGED_TST_SOURCE_REVISION
) throw new Error(`Staged TST source identity does not match the pinned F1 artifact in ${directory}`);
const binary = join(directory, metadata.binary === 'tst-daemon.exe' ? 'tst-daemon.exe' : 'tst-daemon');
const stats = await stat(binary);
if (!stats.isFile()) throw new Error(`Staged TST binary is missing: ${binary}`);
if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) throw new Error(`Staged TST binary is not executable: ${binary}`);
const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
if (digest !== metadata.sha256) throw new Error(`Staged TST checksum mismatch: ${binary}`);
const sourceBinaryRelative = process.platform === 'win32' ? 'bin/tst-daemon.exe' : 'bin/tst-daemon';
if (sourceMetadata.files?.[sourceBinaryRelative] !== digest) throw new Error(`Staged TST checksum differs from the standalone source artifact: ${binary}`);
const protocol = (await capture(binary, ['--protocol'])).trim();
if (protocol !== TST_PROTOCOL_VERSION) throw new Error(`Staged TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${protocol || 'no identity'}`);
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) if (!(await stat(join(directory, name))).isFile()) throw new Error(`Staged TST notice is missing: ${name}`);
process.stdout.write(`verified ${runtime} ${digest} from ${MANAGED_TST_SOURCE_REVISION}\n`);

function capture(command, arguments_) { return new Promise((resolveCapture, rejectCapture) => { const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); rejectCapture(new Error('TST protocol probe timed out')); }, 5_000); child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); }); child.once('error', (error) => { clearTimeout(timer); rejectCapture(error); }); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveCapture(stdout) : rejectCapture(new Error(`TST protocol probe exited ${code}: ${stderr.trim()}`)); }); }); }
