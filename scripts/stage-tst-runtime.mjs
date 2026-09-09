#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runtimeKey } from '../src/runtime/tst-supervisor.mjs';
import { TST_PROTOCOL_VERSION } from '../src/runtime/tst-client.mjs';
import { MANAGED_TST_SOURCE_REPOSITORY, MANAGED_TST_SOURCE_REVISION } from '../src/runtime/tst-release.mjs';

const sourceArgument = argument('source');
if (!sourceArgument) throw new Error('Standalone TST artifact directory is required via --source=<directory>');
const runtime = runtimeKey();
if (!runtime) throw new Error(`Managed TST staging is unsupported on ${process.platform}-${process.arch}`);
const source = resolve(sourceArgument);
const sourceMetadata = JSON.parse(await readFile(join(source, 'tst-runtime.json'), 'utf8'));
const sourceBinaryRelative = process.platform === 'win32' ? 'bin/tst-daemon.exe' : 'bin/tst-daemon';
validateSourceMetadata(sourceMetadata, runtime, sourceBinaryRelative);
const sourceBinary = join(source, sourceBinaryRelative);
const sourceStats = await stat(sourceBinary).catch(() => null);
if (!sourceStats?.isFile()) throw new Error(`Standalone TST binary is missing: ${sourceBinary}`);
if (process.platform !== 'win32' && (sourceStats.mode & 0o111) === 0) throw new Error(`Standalone TST binary is not executable: ${sourceBinary}`);
const sourceDigest = createHash('sha256').update(await readFile(sourceBinary)).digest('hex');
if (sourceDigest !== sourceMetadata.files[sourceBinaryRelative]) throw new Error(`Standalone TST checksum mismatch: ${sourceBinary}`);
const protocol = (await capture(sourceBinary, ['--protocol'])).trim();
if (protocol !== TST_PROTOCOL_VERSION) throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${protocol || 'no identity'}`);

const destination = resolve(argument('output') ?? join('vendor', 'tst', runtime));
const binaryName = process.platform === 'win32' ? 'tst-daemon.exe' : 'tst-daemon';
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true, mode: 0o755 });
const binaryPath = join(destination, binaryName);
await copyFile(sourceBinary, binaryPath);
if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(join(source, name), join(destination, name));
}
await writeFile(join(destination, 'source-tst-runtime.json'), `${JSON.stringify(sourceMetadata, null, 2)}\n`);
const digest = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
const metadata = {
  schema: 1,
  kind: 'cuppet-desktop-tst-runtime',
  protocol: TST_PROTOCOL_VERSION,
  runtime,
  platform: process.platform,
  arch: process.arch,
  sourceRepository: MANAGED_TST_SOURCE_REPOSITORY,
  sourceRevision: MANAGED_TST_SOURCE_REVISION,
  sourceKind: sourceMetadata.kind,
  sourceVersion: sourceMetadata.version,
  sha256: digest,
  binary: binaryName,
};
await writeFile(join(destination, 'tst-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${destination}\n`);

function validateSourceMetadata(metadata, expectedRuntime, binaryRelative) {
  if (
    metadata?.schema !== 1 || metadata?.kind !== 'cuppet-tst-runtime' ||
    metadata?.protocol !== TST_PROTOCOL_VERSION || metadata?.runtime !== expectedRuntime ||
    metadata?.platform !== process.platform || metadata?.arch !== process.arch ||
    metadata?.sourceRepository !== MANAGED_TST_SOURCE_REPOSITORY ||
    metadata?.sourceRevision !== MANAGED_TST_SOURCE_REVISION ||
    !/^[a-f0-9]{64}$/.test(metadata?.files?.[binaryRelative] ?? '')
  ) throw new Error(`Standalone TST artifact does not match the pinned F1 contract for ${expectedRuntime}`);
}
function argument(name) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function capture(command, arguments_) { return new Promise((resolveCapture, rejectCapture) => { const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); rejectCapture(new Error('TST protocol probe timed out')); }, 5_000); child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); }); child.once('error', (error) => { clearTimeout(timer); rejectCapture(error); }); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveCapture(stdout) : rejectCapture(new Error(`TST protocol probe exited ${code}: ${stderr.trim()}`)); }); }); }
