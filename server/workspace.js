import { execFile } from 'node:child_process';
import { ChangeSet, Text } from '@codemirror/state';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_DOCUMENT_EVENTS = 1000;
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
]);

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function createWorkspace(workspaceRoot) {
  const root = await fs.realpath(workspaceRoot);
  let searchIndex;
  const documents = new Map();

  return {
    root,
    readTree: async () => {
      searchIndex = null;
      return readTree(root, root);
    },
    loadFile: (filePath) => loadFile(root, documents, filePath),
    loadMediaFile: (filePath) => loadMediaFile(root, filePath),
    diffFile: (filePath) => diffFile(root, filePath),
    saveFile: async (filePath, content) => {
      const result = await saveFile(root, filePath, content);
      searchIndex = null;
      return result;
    },
    applyUpdates: async (filePath, version, updates) => {
      const result = await applyDocumentUpdates(
        root,
        documents,
        filePath,
        version,
        updates
      );
      searchIndex = null;
      return result;
    },
    subscribeEvents: (filePath, since, send) =>
      subscribeDocumentEvents(root, documents, filePath, since, send),
    searchFiles: async (query, options) => {
      searchIndex ??= await buildSearchIndex(root);
      return searchIndex.search(query, options);
    },
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
    } else if (entry.isFile()) {
      const fileKind = fileKindForPath(entry.name);
      if (fileKind)
        nodes.push({ name: entry.name, type: 'file', path: nodePath, fileKind });
    }
  }

  return nodes;
}

async function loadFile(root, documents, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const document = documents.get(normalized);
  if (document) {
    return {
      path: normalized,
      content: document.content,
      version: document.version
    };
  }

  const absolute = await resolvePath(root, normalized);
  return {
    path: normalized,
    content: await fs.readFile(absolute, 'utf8'),
    version: 0
  };
}

async function loadMediaFile(root, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  const fileKind = assertMedia(normalized);
  const absolute = await resolvePath(root, normalized);
  const stat = await fs.stat(absolute);

  if (!stat.isFile()) throw new WorkspaceError(400, 'Path points to a directory.');
  return { path: normalized, absolute, fileKind };
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

async function applyDocumentUpdates(root, documents, filePath, version, updates) {
  if (!Array.isArray(updates)) {
    throw new WorkspaceError(400, 'Updates must be an array.');
  }

  const document = await getDocument(root, documents, filePath);
  return enqueueDocumentWrite(document, async () => {
    const baseVersion = parseVersion(version);
    if (baseVersion !== document.version) {
      throw new WorkspaceError(409, `Document is at version ${document.version}.`);
    }
    if (!updates.length) {
      return { success: true, path: document.path, version: document.version };
    }

    const nextContent = applyChangeSets(document.content, updates);
    await saveFile(root, document.path, nextContent);

    const events = updates.map((update, index) => ({
      path: document.path,
      version: baseVersion + index + 1,
      updates: [update]
    }));

    document.content = nextContent;
    document.version = baseVersion + updates.length;
    document.events.push(...events);
    // ponytail: bounded in-memory log; persist logs when reconnect windows matter.
    while (document.events.length > MAX_DOCUMENT_EVENTS) document.events.shift();
    for (const event of events) {
      for (const listener of document.listeners) {
        try {
          listener(event);
        } catch {
          document.listeners.delete(listener);
        }
      }
    }

    return { success: true, path: document.path, version: document.version };
  });
}

async function subscribeDocumentEvents(root, documents, filePath, since, send) {
  if (typeof send !== 'function') {
    throw new WorkspaceError(500, 'Event listener is required.');
  }

  const document = await getDocument(root, documents, filePath);
  const version = parseVersion(since);
  const backlog = document.events.filter((event) => event.version > version);
  document.listeners.add(send);

  return {
    path: document.path,
    version: document.version,
    backlog,
    unsubscribe: () => document.listeners.delete(send)
  };
}

async function getDocument(root, documents, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);

  let document = documents.get(normalized);
  if (document) return document;

  const absolute = await resolvePath(root, normalized);
  document = {
    path: normalized,
    content: await fs.readFile(absolute, 'utf8'),
    version: 0,
    events: [],
    listeners: new Set(),
    pendingWrite: Promise.resolve()
  };
  documents.set(normalized, document);
  return document;
}

function enqueueDocumentWrite(document, write) {
  const nextWrite = document.pendingWrite.then(write, write);
  document.pendingWrite = nextWrite.catch(() => {});
  return nextWrite;
}

function applyChangeSets(content, updates) {
  let doc = Text.of(content.split('\n'));

  try {
    for (const update of updates) {
      if (!update || typeof update !== 'object' || !('changes' in update)) {
        throw new WorkspaceError(400, 'Each update must include changes.');
      }
      doc = ChangeSet.fromJSON(update.changes).apply(doc);
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(400, error.message || 'Invalid document update.');
  }

  return doc.toString();
}

function parseVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw new WorkspaceError(400, 'Version must be a non-negative integer.');
  }
  return version;
}

async function buildSearchIndex(root) {
  const files = await readSearchFiles(root, root);

  return {
    search(query, { limit = 50 } = {}) {
      const needle = normalizeSearchQuery(query);
      if (!needle) return [];

      const results = [];
      const maxResults = Math.max(1, Math.min(Number(limit) || 50, 100));

      for (const file of files) {
        if (results.length >= maxResults) break;

        if (file.lowerPath.includes(needle)) {
          results.push(searchResult(file, 'path'));
          continue;
        }
        if (file.fileKind !== 'markdown') continue;

        const match = findSearchContentMatch(file, needle);
        if (match) results.push({ ...searchResult(file, 'content'), ...match });
      }

      return results;
    }
  };
}

async function readSearchFiles(root, dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort(sortEntries)) {
    if (isHiddenSearchEntry(entry.name)) continue;

    const absolute = path.join(dir, entry.name);
    const real = await realpathOrNull(absolute);
    if (!real || !isInside(root, real)) continue;

    const nodePath = `${prefix}/${entry.name}`.replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      files.push(...(await readSearchFiles(root, absolute, nodePath)));
    } else if (entry.isFile()) {
      const fileKind = fileKindForPath(entry.name);
      if (!fileKind) continue;

      const file = {
        name: entry.name,
        type: 'file',
        path: nodePath,
        fileKind,
        lowerPath: nodePath.toLowerCase()
      };

      if (fileKind === 'markdown') {
        file.content = await fs.readFile(real, 'utf8');
        file.lowerContent = file.content.toLowerCase();
      }

      files.push(file);
    }
  }

  return files;
}

function normalizeSearchQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function isHiddenSearchEntry(name) {
  return name.endsWith('.tmp') || name.startsWith('.') || name === 'node_modules';
}

function searchResult(file, kind) {
  return {
    name: file.name,
    type: file.type,
    path: file.path,
    fileKind: file.fileKind,
    kind
  };
}

function findSearchContentMatch(file, needle) {
  const index = file.lowerContent.indexOf(needle);
  if (index === -1) return null;

  const lineStart = file.content.lastIndexOf('\n', index) + 1;
  const lineEnd = file.content.indexOf('\n', index);
  const line = file.content
    .slice(lineStart, lineEnd === -1 ? file.content.length : lineEnd)
    .trim();

  return {
    from: index,
    to: index + needle.length,
    lineNumber: file.content.slice(0, lineStart).split('\n').length,
    preview: line.length > 140 ? `${line.slice(0, 137)}...` : line
  };
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

function assertMedia(filePath) {
  const fileKind = fileKindForPath(filePath);
  if (fileKind !== 'image' && fileKind !== 'pdf') {
    throw new WorkspaceError(400, 'Only image and PDF files are supported.');
  }
  return fileKind;
}

function isMarkdownPath(filePath) {
  return fileKindForPath(filePath) === 'markdown';
}

function fileKindForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  return '';
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
