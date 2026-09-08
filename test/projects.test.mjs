import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { ProjectManager, ProjectError, normalizeGithubRepositoryUrl } from '../src/runtime/projects.mjs';

const execFileAsync = promisify(execFile);
async function git(args, cwd) { return execFileAsync('git', args, { cwd }); }

test('GitHub URL validation accepts normal URLs and rejects embedded credentials', () => {
  assert.equal(normalizeGithubRepositoryUrl('https://github.com/openai/openai.git').identity, 'openai/openai');
  assert.equal(normalizeGithubRepositoryUrl('git@github.com:openai/openai.git').identity, 'openai/openai');
  assert.equal(normalizeGithubRepositoryUrl('ssh://git@github.com/openai/openai.git').identity, 'openai/openai');
  assert.throws(() => normalizeGithubRepositoryUrl('https://token:secret@github.com/openai/openai.git'), (error) => error instanceof ProjectError && error.code === 'GITHUB_URL_CREDENTIALS');
  assert.throws(() => normalizeGithubRepositoryUrl('https://gitlab.com/openai/openai'), (error) => error.code === 'GITHUB_URL_INVALID');
});

test('manual project registration canonicalizes to Git root and rejects duplicate checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-project-'));
  const repo = join(dir, 'repo');
  const nested = join(repo, 'src');
  await mkdir(nested, { recursive: true });
  await git(['init'], repo);
  await git(['remote', 'add', 'origin', 'https://github.com/example/demo.git'], repo);
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  const manager = new ProjectManager({ db });
  try {
    const project = await manager.addLocal({ id: 'project_1', path: nested, name: 'Demo' });
    assert.equal(project.repositoryId, 'example/demo');
    assert.equal(project.remoteUrl, 'https://github.com/example/demo.git');
    assert.equal(project.missing, false);
    assert.match(project.canonicalPath, /repo$/);
    await assert.rejects(() => manager.addLocal({ id: 'project_2', path: repo, name: 'Duplicate' }), (error) => error.code === 'PROJECT_DUPLICATE');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed clone cleans its newly-created target and reports auth failure without leaking credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-clone-'));
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  const calls = [];
  const manager = new ProjectManager({
    db,
    runCommand: async (command, args) => {
      calls.push([command, args]);
      const target = args.at(-1);
      if (command === 'git' && args[0] === 'clone') {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'partial'), 'partial');
        return { ok: false, code: 128, stdout: '', stderr: 'fatal: Authentication failed for https://ghp_SECRET@github.com/private/repo.git', missing: false };
      }
      return { ok: true, code: 0, stdout: '', stderr: '', missing: false };
    },
  });
  try {
    await assert.rejects(() => manager.cloneUrl({ id: 'project_1', url: 'https://github.com/private/repo.git', destinationParent: dir }), (error) => {
      assert.equal(error.code, 'GIT_AUTH_FAILED');
      assert.doesNotMatch(error.message, /ghp_SECRET/);
      return true;
    });
    await assert.rejects(stat(join(dir, 'repo')));
    assert.equal(calls[0][0], 'git');
    assert.deepEqual(calls[0][1].slice(0, 2), ['clone', '--']);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('authenticated picker uses existing gh auth data and filters repositories locally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-gh-'));
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  const manager = new ProjectManager({
    db,
    runCommand: async (command, args) => {
      assert.equal(command, 'gh');
      assert.equal(args[0], 'api');
      return { ok: true, code: 0, stderr: '', missing: false, stdout: JSON.stringify([[
        { id: 1, full_name: 'acme/private-one', html_url: 'https://github.com/acme/private-one', ssh_url: 'git@github.com:acme/private-one.git', private: true, default_branch: 'main', description: 'billing service' },
        { id: 2, full_name: 'acme/public-two', html_url: 'https://github.com/acme/public-two', ssh_url: 'git@github.com:acme/public-two.git', private: false, default_branch: 'main', description: 'docs' },
      ]]) };
    },
  });
  try {
    const repos = await manager.listGithubRepositories({ query: 'billing' });
    assert.equal(repos.length, 1);
    assert.equal(repos[0].nameWithOwner, 'acme/private-one');
    assert.equal(repos[0].isPrivate, true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
