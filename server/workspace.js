import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function createWorkspace(workspaceRoot) {
  const root = await fs.realpath(workspaceRoot);

  return {
    root,
    readTree: () => readTree(root, root),
    loadFile: (filePath) => loadFile(root, filePath),
    diffFile: (filePath) => diffFile(root, filePath),
    saveFile: (filePath, content) => saveFile(root, filePath, content),
    resolvePath: (filePath, options) => resolvePath(root, filePath, options)
  };
}

export function normalizeWorkspacePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
    throw new WorkspaceError(400, 'Path must start with /.');
  }
  if (filePath.includes('\0') || filePath.includes('\\')) {
    throw new WorkspaceError(400, 'Invalid path.');
  }

  const parts = filePath.split('/').filter(Boolean);
  if (!parts.length) throw new WorkspaceError(400, 'File path is required.');
  if (parts.some((part) => part === '..')) {
    throw new WorkspaceError(400, 'Path traversal is not allowed.');
  }

  return `/${parts.filter((part) => part !== '.').join('/')}`;
}

async function readTree(root, dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes = [];

  for (const entry of entries.sort(sortEntries)) {
    if (entry.name.endsWith('.tmp')) continue;

    const absolute = path.join(dir, entry.name);
    const real = await realpathOrNull(absolute);
    if (!real || !isInside(root, real)) continue;

    const nodePath = `${prefix}/${entry.name}`.replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        type: 'directory',
        path: nodePath,
        children: await readTree(root, absolute, nodePath)
      });
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      nodes.push({ name: entry.name, type: 'file', path: nodePath });
    }
  }

  return nodes;
}

async function loadFile(root, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const absolute = await resolvePath(root, normalized);
  return {
    path: normalized,
    content: await fs.readFile(absolute, 'utf8')
  };
}

async function diffFile(root, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const absolute = await resolvePath(root, normalized);
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/');

  try {
    const { stdout } = await execFileAsync('git', ['diff', '--', relative], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024
    });
    return { path: normalized, diff: stdout };
  } catch (error) {
    throw new WorkspaceError(
      400,
      error.stderr?.trim() || error.message || 'Unable to read git diff.'
    );
  }
}

async function saveFile(root, filePath, content) {
  if (typeof content !== 'string') {
    throw new WorkspaceError(400, 'Content must be a string.');
  }

  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const absolute = await resolvePath(root, normalized, { forWrite: true });
  const tempPath = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempPath, absolute);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  return { success: true, timestamp: new Date().toISOString() };
}

async function resolvePath(root, filePath, { forWrite = false } = {}) {
  const normalized = normalizeWorkspacePath(filePath);
  const target = path.resolve(root, `.${normalized}`);

  if (!isInside(root, target)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }

  if (!forWrite) {
    let real;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new WorkspaceError(404, 'File not found.');
      throw error;
    }
    if (!isInside(root, real)) {
      throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
    }
    return real;
  }

  const parent = await ensureWriteParent(root, path.dirname(target));
  if (!isInside(root, parent)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }

  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) throw new WorkspaceError(400, 'Path points to a directory.');
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(target);
      if (!isInside(root, real)) {
        throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
      }
      return real;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return path.join(parent, path.basename(target));
}

async function ensureWriteParent(root, parentPath) {
  if (!isInside(root, parentPath)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }

  let current = root;
  const relative = path.relative(root, parentPath);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
      continue;
    }

    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(current);
      if (!isInside(root, real)) {
        throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
      }
      stat = await fs.stat(real);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError(400, 'Path parent is not a directory.');
    }
  }

  return fs.realpath(parentPath);
}

function assertMarkdown(filePath) {
  if (!isMarkdownPath(filePath)) {
    throw new WorkspaceError(400, 'Only Markdown files are supported.');
  }
}

function isMarkdownPath(filePath) {
  return /\.(md|markdown)$/i.test(filePath);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sortEntries(a, b) {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function realpathOrNull(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}
