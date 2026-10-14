import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProjectFilePath } from '../src/main/project-file-path.mjs';

test('chat file paths resolve relative, absolute and encoded file links inside the project', async t => {
  const dir = await realpath(await mkdtemp('/private/tmp/cuppet-file-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  await mkdir(root);
  const path = join(root, 'My Report.pdf');
  await writeFile(path, 'file');
  for (const input of ['My Report.pdf', path, pathToFileURL(path).href, 'My%20Report.pdf', path.replace('My Report', 'My%20Report')]) {
    assert.deepEqual(await resolveProjectFilePath(root, input), { actual: path, child: 'My Report.pdf' });
  }
  const outside = join(dir, 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, join(root, 'escape.txt'));
  for (const input of [outside, '../outside.txt', 'escape.txt']) await assert.rejects(resolveProjectFilePath(root, input), /escapes/);
  await mkdir(join(root, 'folder'));
  await assert.rejects(resolveProjectFilePath(root, 'folder'), /Only project files/);
});
