import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// A background commit must never stop to ask a human anything: signing can wait
// on a passphrase and a credential helper can wait on a terminal.
const GIT_FLAGS = ['-c', 'commit.gpgsign=false'];

// What git leaves behind while a merge, rebase, or cherry-pick is unfinished.
// Sweeping the tree into a commit then would bury a half-resolved conflict.
const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply'
];

export function autoCommitMessage(now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join(':');
  return `WebMD autosave ${stamp} ${time}`;
}

/**
 * Commits everything in a workspace that git would track, so a note deleted by
 * mistake stays recoverable after the browser tab (and its undo history) is
 * gone. Skips silently when there is nothing to commit or when the repo is
 * mid-operation; the next tick tries again.
 */
export async function commitWorkspace(root, { now = new Date() } = {}) {
  const gitDir = await resolveGitDir(root);
  if (!gitDir) return { committed: false, reason: 'not-a-repo' };
  if (await isMidOperation(gitDir)) {
    return { committed: false, reason: 'in-progress' };
  }
  if (!(await hasChanges(root))) return { committed: false, reason: 'clean' };

  const message = autoCommitMessage(now);
  await git(root, ['add', '-A']);
  // --no-verify: a pre-commit hook that reformats or rejects would turn an
  // unattended snapshot into a surprise.
  await git(root, [
    ...GIT_FLAGS,
    ...(await identityFlags(root)),
    'commit',
    '--no-verify',
    '-m',
    message
  ]);

  return { committed: true, reason: 'committed', message };
}

/**
 * Snapshots every root on an interval. The timer is unref'd so it never holds
 * the process open, and overlapping runs are skipped rather than queued.
 */
export function startAutoCommit({ roots = [], intervalMs, onError, now }) {
  if (!roots.length || !(intervalMs > 0))
    return { stop() {}, runOnce: async () => [] };

  let running = false;

  const runOnce = async () => {
    if (running) return [];
    running = true;
    try {
      const results = [];
      for (const root of roots) {
        try {
          results.push({
            root,
            ...(await commitWorkspace(root, { now: now?.() }))
          });
        } catch (error) {
          results.push({ root, committed: false, reason: 'error', error });
          onError?.(root, error);
        }
      }
      return results;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer), runOnce };
}

async function resolveGitDir(root) {
  try {
    const { stdout } = await git(root, ['rev-parse', '--absolute-git-dir']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isMidOperation(gitDir) {
  for (const marker of IN_PROGRESS) {
    try {
      await fs.access(path.join(gitDir, marker));
      return true;
    } catch {
      // Missing marker is the normal case.
    }
  }
  return false;
}

async function hasChanges(root) {
  const { stdout } = await git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]);
  return Boolean(stdout.trim());
}

/** Only supplies an identity when the repo and user config leave one missing. */
async function identityFlags(root) {
  try {
    const { stdout } = await git(root, ['config', 'user.email']);
    if (stdout.trim()) return [];
  } catch {
    // No identity configured; fall through to the WebMD default.
  }
  return ['-c', 'user.name=WebMD', '-c', 'user.email=webmd@localhost'];
}

function git(root, args) {
  return execFileAsync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 10 * 1024 * 1024
  });
}
