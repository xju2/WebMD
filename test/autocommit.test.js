import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  autoCommitMessage,
  commitWorkspace,
  startAutoCommit
} from '../server/autocommit.js';

const execFileAsync = promisify(execFile);

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-autocommit-'));
}

async function gitRepo({ commitBase = true } = {}) {
  const root = await tempRoot();
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: root
  });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: root
  });
  if (commitBase) {
    await fs.writeFile(path.join(root, 'note.md'), 'old notes\n');
    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
  }
  return root;
}

async function log(root) {
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--pretty=%s', '--name-only'],
    { cwd: root }
  );
  return stdout;
}

test('commits edited, new, and deleted notes', async () => {
  const root = await gitRepo();
  await fs.writeFile(path.join(root, 'note.md'), 'edited notes\n');
  await fs.writeFile(path.join(root, 'fresh.md'), 'brand new\n');

  const result = await commitWorkspace(root, {
    now: new Date(2026, 7, 14, 9, 5)
  });

  assert.equal(result.committed, true);
  assert.equal(result.message, 'WebMD autosave 2026-08-14 09:05');
  const history = await log(root);
  assert.match(history, /WebMD autosave 2026-08-14 09:05/);
  assert.match(history, /^note\.md$/m);
  assert.match(history, /^fresh\.md$/m);
});

test('recovers a deleted note from the snapshot', async () => {
  const root = await gitRepo();
  await fs.writeFile(path.join(root, 'note.md'), 'old notes\nkeep me\n');
  await commitWorkspace(root);

  await fs.writeFile(path.join(root, 'note.md'), '');
  const { stdout } = await execFileAsync('git', ['show', 'HEAD:note.md'], {
    cwd: root
  });
  assert.equal(stdout, 'old notes\nkeep me\n');
});

test('does nothing when the tree is clean', async () => {
  const root = await gitRepo();
  const before = await log(root);

  assert.deepEqual(await commitWorkspace(root), {
    committed: false,
    reason: 'clean'
  });
  assert.equal(await log(root), before);
});

test('skips a directory that is not a git repo', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'untracked\n');

  assert.deepEqual(await commitWorkspace(root), {
    committed: false,
    reason: 'not-a-repo'
  });
});

test('leaves a half-finished merge alone', async () => {
  const root = await gitRepo();
  await fs.writeFile(path.join(root, 'note.md'), 'conflicting\n');
  const { stdout: gitDir } = await execFileAsync(
    'git',
    ['rev-parse', '--absolute-git-dir'],
    { cwd: root }
  );
  await fs.writeFile(path.join(gitDir.trim(), 'MERGE_HEAD'), 'deadbeef\n');

  assert.deepEqual(await commitWorkspace(root), {
    committed: false,
    reason: 'in-progress'
  });
});

// A machine that has never run `git config --global user.email` would otherwise
// fail every snapshot, so the fallback identity has to hold on its own.
test('commits a repo with no configured identity', async (t) => {
  const root = await gitRepo({ commitBase: false });
  await execFileAsync('git', ['config', '--unset', 'user.email'], {
    cwd: root
  });
  await execFileAsync('git', ['config', '--unset', 'user.name'], { cwd: root });
  await fs.writeFile(path.join(root, 'note.md'), 'first\n');

  // Without this the global identity on the developer's machine answers for the
  // repo and the fallback never runs.
  const isolated = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null'
  };
  const restore = { ...process.env };
  Object.assign(process.env, isolated);
  t.after(() => {
    process.env = restore;
  });

  const result = await commitWorkspace(root);

  assert.equal(result.committed, true);
  const { stdout } = await execFileAsync('git', ['log', '--pretty=%an <%ae>'], {
    cwd: root,
    env: { ...process.env, ...isolated }
  });
  assert.match(stdout, /WebMD <webmd@localhost>/);
});

test('sweeps every root on one tick and skips overlapping runs', async () => {
  const [first, second] = await Promise.all([gitRepo(), gitRepo()]);
  await fs.writeFile(path.join(first, 'note.md'), 'first edit\n');
  await fs.writeFile(path.join(second, 'note.md'), 'second edit\n');

  const autoCommit = startAutoCommit({
    roots: [first, second],
    intervalMs: 60_000
  });
  const [results] = await Promise.all([
    autoCommit.runOnce(),
    autoCommit.runOnce()
  ]);
  autoCommit.stop();

  assert.deepEqual(
    results.map((entry) => entry.committed),
    [true, true]
  );
  assert.match(await log(first), /WebMD autosave/);
  assert.match(await log(second), /WebMD autosave/);
});

test('stays idle when disabled', async () => {
  const root = await gitRepo();
  await fs.writeFile(path.join(root, 'note.md'), 'edited\n');

  const autoCommit = startAutoCommit({ roots: [root], intervalMs: 0 });
  assert.deepEqual(await autoCommit.runOnce(), []);
  autoCommit.stop();

  assert.doesNotMatch(await log(root), /WebMD autosave/);
});

test('stamps the message with the local date and time', () => {
  assert.equal(
    autoCommitMessage(new Date(2026, 0, 2, 3, 4)),
    'WebMD autosave 2026-01-02 03:04'
  );
});
