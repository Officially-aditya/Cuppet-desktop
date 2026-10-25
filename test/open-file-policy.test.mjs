import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { decideProjectFileOpen } from '../src/main/open-file-policy.mjs';
import { resolveProjectFileDetails } from '../src/main/project-file-path.mjs';

const decide = (requested, actual = requested, platform = 'linux', mode = 0o644) =>
  decideProjectFileOpen({ requested, actual, platform, mode });

const blocked = 'exe com scr pif bat cmd msi lnk url hta cpl reg inf vbs wsf jar ps1 app command pkg dmg scpt desktop appimage run bin deb rpm sh bash zsh'.split(' ');
test('dangerous requested names and real targets are blocked on every platform, case-insensitively', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const extension of blocked) {
      for (const name of [`run.${extension}`, `RUN.${extension.toUpperCase()}`, `.${extension}`]) {
        assert.equal(decide(name, 'notes.txt', platform).allowed, false, `${platform}: ${name}`);
        assert.equal(decide('notes.txt', name, platform).allowed, false, `${platform}: target ${name}`);
      }
    }
  }
});

test('Windows normalizes trailing dots/spaces and rejects alternate data streams', () => {
  for (const name of ['run.bat.', 'RUN.BAT  .. ', 'C:\\project\\run.cmd. ', 'notes.txt:run.bat', 'notes.txt::$DATA', 'folder:stream/notes.txt']) {
    assert.equal(decide(name, name, 'win32').allowed, false, name);
  }
  for (const name of ['C:\\project\\notes.txt', '\\\\?\\C:\\project\\notes.txt', 'notes.txt. ']) {
    assert.equal(decide(name, name, 'win32').allowed, true, name);
  }
});

test('Windows association scripts are blocked but POSIX source files can open', () => {
  for (const extension of 'js jse py pyw pl rb msc msix appx scf vbe wsh msp msixbundle'.split(' ')) {
    assert.equal(decide(`file.${extension}`, undefined, 'win32').allowed, false, extension);
  }
  for (const platform of ['linux', 'darwin']) {
    for (const name of ['file.js', 'file.py']) assert.equal(decide(name, name, platform, 0o755).allowed, true);
  }
});

test('POSIX execute bits require a recognized document/source extension on both names', () => {
  for (const mode of [0o100, 0o010, 0o001, 0o755]) {
    for (const name of ['program', 'program.unknown']) assert.equal(decide(name, name, 'linux', mode).allowed, false);
    for (const name of ['notes.md', 'data.json', 'image.png', 'source.ts']) assert.equal(decide(name, name, 'linux', mode).allowed, true);
    assert.equal(decide('notes.md', 'program', 'darwin', mode).allowed, false);
  }
  assert.equal(decide('program', 'program', 'linux', 0o644).allowed, true);
});

test('real symlinks preserve requested names and executable modes for policy checks', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-open-policy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'run.bat'), 'echo unsafe');
  await symlink('run.bat', join(root, 'notes.txt'));
  const linked = await resolveProjectFileDetails(root, 'notes.txt');
  assert.equal(linked.requested, join(root, 'notes.txt'));
  assert.equal(linked.actual, join(root, 'run.bat'));
  assert.equal(decideProjectFileOpen(linked).allowed, false);
  for (const [name, allowed] of [['executable', false], ['executable.unknown', false], ['notes.md', true]]) {
    await writeFile(join(root, name), 'content');
    await chmod(join(root, name), 0o755);
    const details = await resolveProjectFileDetails(root, name);
    assert.equal(details.mode & 0o777, 0o755);
    assert.equal(decideProjectFileOpen(details).allowed, allowed, name);
  }
});

test('the desktop reveals blocked targets without calling shell.openPath', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  const open = source.match(/async function openProjectFile\([^]*?\n\}/)[0];
  const calls = [];
  const invoke = vm.runInNewContext(`(${open})`, {
    resolveProjectFile: async () => ({ requested: '/project/notes.txt', actual: '/project/run.bat', child: 'run.bat', mode: 0o644 }),
    decideProjectFileOpen, process: { platform: 'linux' },
    shell: {
      showItemInFolder: path => calls.push(['reveal', path]),
      openPath: () => assert.fail('blocked file must never reach the shell opener'),
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await invoke(() => {}, 'p1', 'notes.txt'))), { opened: false, revealed: true, path: 'run.bat' });
  assert.deepEqual(calls, [['reveal', '/project/run.bat']]);
});
