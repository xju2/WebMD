import { execFile } from 'node:child_process';
import { runAiCompletion } from './ai.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// A background commit must never stop to ask a human anything: signing can wait
// on a passphrase and a credential helper can wait on a terminal.
const GIT_FLAGS = ['-c', 'commit.gpgsign=false'];

// What git leaves behind while a merge, rebase, or cherry-pick is unfinished.
// Sweeping the tree into a commit then would bury a half-resolved conflict.
// A one-line summary is worth a model call once a snapshot is more than a
// stray edit; below that the file names say as much as any sentence could.
const DEFAULT_SUMMARY_LINES = 5;
const MAX_DIFF_CHARS = 12000;
const SUMMARY_SYSTEM =
  'You write git commit subjects for snapshots of a personal Markdown notebook. Answer with one line of at most 72 characters, in the imperative mood, naming what the notes now say. No quotes, no trailing period, no file names unless nothing else identifies the change.';

const IN_PROGRESS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply'
];

/**
 * What the snapshot did, read off the same `git status` that found it: the
 * notes by name, and the full list underneath. Git already stamps the time, so
 * the message says what changed instead of when.
 */
export function autoCommitMessage(changes = []) {
  if (!changes.length) return 'WebMD autosave';

  const verbs = new Set(changes.map((change) => change.verb));
  const verb = verbs.size === 1 ? [...verbs][0] : 'Update';
  const names = changes.map((change) =>
    path.basename(change.path, path.extname(change.path))
  );
  const listed = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  const subject = `${verb} ${listed}${rest > 0 ? ` and ${rest} more` : ''}`;
  return `${subject}\n\n${changeList(changes)}`;
}

/** The files the snapshot touched, one per line, for the message body. */
export function changeList(changes = []) {
  return changes
    .map((change) => `- ${change.verb.toLowerCase()} ${change.path}\n`)
    .join('');
}

// `XY path`, where X is the staged state and Y the working tree's. A rename
// reads `R  old -> new`, and only the new name is worth naming.
const STATUS_VERB = { A: 'Add', '?': 'Add', D: 'Delete', R: 'Rename' };

export function parseStatus(porcelain = '') {
  return porcelain
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const state = line.slice(0, 2).trim()[0] ?? '';
      const named = line.slice(3).trim();
      const quoted = /^"(.*)"$/.exec(named);
      const file = (quoted ? quoted[1] : named).split(' -> ').at(-1);
      return { verb: STATUS_VERB[state] ?? 'Update', path: file };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** How many lines the snapshot adds or removes, as the diff shows them. */
export function changedLineCount(diff = '') {
  return diff
    .split('\n')
    .filter(
      (line) =>
        /^[+-]/.test(line) &&
        !/^(\+\+\+|---)/.test(line) &&
        line.slice(1).trim()
    ).length;
}

/**
 * One line saying what was written, from the model the workspace is already
 * set up with. Whatever goes wrong — no provider, no network, a reply that is
 * not a subject line — is the caller's cue to fall back to the file names.
 */
export async function summarizeDiff(diff, { env = process.env } = {}) {
  const reply = await runAiCompletion({
    env,
    messages: [
      { role: 'developer', content: SUMMARY_SYSTEM },
      {
        role: 'user',
        content: `Summarize this snapshot of my notes:\n\n${diff.slice(0, MAX_DIFF_CHARS)}`
      }
    ]
  });
  return reply;
}

/** The model's reply as a commit subject, or nothing if it did not write one. */
export function subjectLine(reply = '') {
  const subject = String(reply)
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^["'`]+|["'`.]+$/g, '')
        .trim()
    )
    .find(Boolean);
  return subject && subject.length <= 100 ? subject : '';
}

/**
 * Commits everything in a workspace that git would track, so a note deleted by
 * mistake stays recoverable after the browser tab (and its undo history) is
 * gone. Skips silently when there is nothing to commit or when the repo is
 * mid-operation; the next tick tries again.
 */
export async function commitWorkspace(
  root,
  {
    env = process.env,
    summarize = summarizeDiff,
    summaryLines = Number(
      env?.AUTO_COMMIT_SUMMARY_LINES ?? DEFAULT_SUMMARY_LINES
    )
  } = {}
) {
  const gitDir = await resolveGitDir(root);
  if (!gitDir) return { committed: false, reason: 'not-a-repo' };
  if (await isMidOperation(gitDir)) {
    return { committed: false, reason: 'in-progress' };
  }
  const changes = parseStatus(await readStatus(root));
  if (!changes.length) return { committed: false, reason: 'clean' };

  let message = autoCommitMessage(changes);
  // Staged first, so the diff read below is exactly what is about to be
  // committed, untracked notes included.
  await git(root, ['add', '-A']);
  const { stdout: diff } = await git(root, ['diff', '--cached', '--no-color']);
  if (changedLineCount(diff) > summaryLines) {
    try {
      const subject = subjectLine(await summarize(diff, { env }));
      if (subject) message = `${subject}\n\n${changeList(changes)}`;
    } catch {
      // No model, no network, or a refusal: the file names still say enough.
    }
  }
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
export function startAutoCommit({ roots = [], intervalMs, onError }) {
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
            ...(await commitWorkspace(root))
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

async function readStatus(root) {
  const { stdout } = await git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]);
  return stdout;
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
