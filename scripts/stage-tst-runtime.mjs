#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runtimeKey } from '../src/runtime/tst-supervisor.mjs';
import { TST_PROTOCOL_VERSION } from '../src/runtime/tst-client.mjs';

const sourceArgument = argument('source') ?? process.env.CUPPET_TST_BIN;
if (!sourceArgument) throw new Error('TST binary is required via --source=<path> or CUPPET_TST_BIN');
const runtime = runtimeKey();
if (!runtime) throw new Error(`Managed TST staging is unsupported on ${process.platform}-${process.arch}`);
const source = resolve(sourceArgument);
const sourceStats = await stat(source).catch(() => null);
if (!sourceStats?.isFile()) throw new Error(`TST binary is missing: ${source}`);
if (process.platform !== 'win32' && (sourceStats.mode & 0o111) === 0) throw new Error(`TST binary is not executable: ${source}`);
const protocol = (await capture(source, ['--protocol'])).trim();
if (protocol !== TST_PROTOCOL_VERSION) throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${protocol || 'no identity'}`);

const destination = resolve(argument('output') ?? join('vendor', 'tst', runtime));
const binaryName = process.platform === 'win32' ? 'tst-daemon.exe' : 'tst-daemon';
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true, mode: 0o755 });
const binaryPath = join(destination, binaryName);
await copyFile(source, binaryPath);
if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
const digest = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
const metadata = {
  schema: 1,
  kind: 'cuppet-desktop-tst-runtime',
  protocol: TST_PROTOCOL_VERSION,
  runtime,
  platform: process.platform,
  arch: process.arch,
  sourceRepository: 'Officially-aditya/Cuppet-code',
  sourceRevision: process.env.CUPPET_TST_SOURCE_REVISION ?? null,
  sha256: digest,
  binary: binaryName,
};
await writeFile(join(destination, 'tst-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${destination}\n`);

function argument(name) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function capture(command, arguments_) { return new Promise((resolveCapture, rejectCapture) => { const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); rejectCapture(new Error('TST protocol probe timed out')); }, 5_000); child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); }); child.once('error', (error) => { clearTimeout(timer); rejectCapture(error); }); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveCapture(stdout) : rejectCapture(new Error(`TST protocol probe exited ${code}: ${stderr.trim()}`)); }); }); }
