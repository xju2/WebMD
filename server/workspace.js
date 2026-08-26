import { execFile } from 'node:child_process';
import { ChangeSet, Text } from '@codemirror/state';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter, parseMetadataQuery } from '../src/frontmatter.js';
import { shortestWikiTarget } from '../src/related-links.js';
import { collectTasks } from '../src/tasks.js';
import { isMediaWikiTarget, resolveWikiLinkPath } from '../src/wiki-links.js';

const execFileAsync = promisify(execFile);
const MAX_DOCUMENT_EVENTS = 1000;
const MAX_BROKEN_LINKS = 200;
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
]);
const IMAGE_MIME_EXTENSIONS = new Map([
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/webp', '.webp']
]);
const MEDIA_MIME_EXTENSIONS = new Map([
  ...IMAGE_MIME_EXTENSIONS,
  ['application/pdf', '.pdf']
]);

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function createWorkspace(workspaceRoot) {
  const root = await fs.realpath(workspaceRoot);
  let filesIndex;
  let searchIndex;
  let graphIndex;
  const documents = new Map();

  // One walk of the workspace feeds search, the link graph, and related-note
  // ranking, so a save invalidates all three together.
  const files = async () => (filesIndex ??= await readSearchFiles(root, root));
  const invalidate = () => {
    filesIndex = null;
    searchIndex = null;
    graphIndex = null;
  };

  return {
    root,
    graph: async () => (graphIndex ??= buildWorkspaceGraph(await files())),
    // Rides the same cached corpus as the graph, so asking every note what it
    // links to costs no extra walk of the workspace.
    backlinks: async (filePath) => collectBacklinks(await files(), filePath),
    markdownFiles: async () =>
      (await files()).filter((file) => file.fileKind === 'markdown'),
    overview: () => readOverview(root),
    // Rides the same cached corpus as search and the link graph, so the Tasks
    // view costs no extra walk of the workspace.
    listTasks: async (options) => listTasks(await files(), options),
    readTree: async () => {
      invalidate();
      return readTree(root, root);
    },
    loadFile: (filePath) => loadFile(root, documents, filePath),
    loadMediaFile: (filePath) => loadMediaFile(root, filePath),
    createFolder: async (folderPath) => {
      const result = await createFolder(root, folderPath);
      invalidate();
      return result;
    },
    saveImageFile: async (file) => {
      const result = await saveMediaFile(root, file);
      invalidate();
      return result;
    },
    saveMediaFile: async (file) => {
      const result = await saveMediaFile(root, file);
      invalidate();
      return result;
    },
    diffFile: (filePath) => diffFile(root, filePath),
    saveFile: async (filePath, content) => {
      const result = await saveFile(root, filePath, content);
      invalidate();
      return result;
    },
    renameFile: async (fromPath, toPath) => {
      // Rides the cached corpus so the wiki links pointing at the old name can
      // be found without a second walk of the workspace.
      const result = await renameFile(
        root,
        documents,
        await files(),
        fromPath,
        toPath
      );
      invalidate();
      return result;
    },
    deleteFile: async (filePath) => {
      const result = await deleteFile(root, documents, filePath);
      invalidate();
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
      invalidate();
      return result;
    },
    subscribeEvents: (filePath, since, send) =>
      subscribeDocumentEvents(root, documents, filePath, since, send),
    searchFiles: async (query, options) => {
      searchIndex ??= buildSearchIndex(await files());
      return searchIndex.search(query, options);
    },
    resolvePath: (filePath, options) => resolvePath(root, filePath, options)
  };
}

const TASK_LIMIT = 500;

function listTasks(corpus, { includeDone = false, limit = TASK_LIMIT } = {}) {
  const cap = Math.min(Math.max(Number(limit) || TASK_LIMIT, 1), TASK_LIMIT);
  const tasks = corpus
    .filter((file) => file.fileKind === 'markdown')
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((file) =>
      collectTasks(file.content)
        .filter((task) => task.text && (includeDone || !task.checked))
        .map((task) => ({ ...task, path: file.path }))
    );

  // `total` is reported before the cap so the view can say what it is hiding.
  return { tasks: tasks.slice(0, cap), total: tasks.length };
}

function buildWorkspaceGraph(corpus) {
  const files = corpus
    .filter((file) => file.fileKind === 'markdown')
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = files.map((file) => file.path);
  const pathSet = new Set(paths);
  const edges = new Map();
  const broken = [];
  let unresolved = 0;

  for (const file of files) {
    for (const mention of wikiLinkMentions(file.content)) {
      const resolved = resolveWikiLinkPath(mention.target, file.path, paths);
      if (resolved && pathSet.has(resolved)) {
        edges.set(`${file.path}\0${resolved}`, {
          source: file.path,
          target: resolved
        });
        continue;
      }
      if (isMediaWikiTarget(mention.target)) continue;

      // The count is of every dead mention; the list is capped, since a
      // workspace mid-reorganisation can hold thousands and the reader only
      // fixes them a handful at a time.
      unresolved += 1;
      if (broken.length < MAX_BROKEN_LINKS) {
        broken.push({
          path: file.path,
          name: noteName(file.path),
          target: mention.target,
          line: mention.line
        });
      }
    }
  }

  return {
    nodes: files.map((file) => ({
      path: file.path,
      name: noteName(file.path),
      group: graphGroup(file.path)
    })),
    edges: [...edges.values()].sort((a, b) =>
      `${a.source}\0${a.target}`.localeCompare(`${b.source}\0${b.target}`)
    ),
    unresolved,
    broken
  };
}

/**
 * Every `[[link]]` in a note, as the target it names and the 0-based line it
 * sits on — the numbering the rendered blocks and the editor both use, so a
 * mention can be opened where it is written.
 */
function wikiLinkMentions(content) {
  const mentions = [];
  const lines = String(content).split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      mentions.push({ target: match[1].split('|')[0].trim(), line: index });
    }
  }

  return mentions;
}

function noteName(filePath) {
  return path.basename(filePath).replace(/\.(md|markdown)$/i, '');
}

/**
 * Every mention of `filePath` in the workspace, grouped by the note it is
 * written in: which note, and the line of the sentence around each link.
 *
 * Links are resolved rather than string-matched, so `[[triton]]`,
 * `[[iaas/triton]]` and `[[/raw/projects/iaas/triton|Triton]]` all count as
 * mentions of the same note. A note linking to itself is not a backlink.
 */
function collectBacklinks(corpus, filePath) {
  const target = normalizeWorkspacePath(filePath);
  assertMarkdown(target);

  const files = corpus.filter((file) => file.fileKind === 'markdown');
  const paths = files.map((file) => file.path);
  const notes = [];

  for (const file of files) {
    if (file.path === target) continue;

    const lines = file.content.split('\n');
    const mentions = [];
    for (const mention of wikiLinkMentions(file.content)) {
      if (resolveWikiLinkPath(mention.target, file.path, paths) !== target)
        continue;
      // One entry per line: two links to the same note in one sentence are one
      // mention of it, not two.
      if (mentions.at(-1)?.line === mention.line) continue;

      mentions.push({ line: mention.line, text: lines[mention.line].trim() });
    }

    if (mentions.length) {
      notes.push({ path: file.path, name: noteName(file.path), mentions });
    }
  }

  return {
    path: target,
    notes: notes.sort((a, b) => a.path.localeCompare(b.path)),
    total: notes.reduce((sum, note) => sum + note.mentions.length, 0)
  };
}

function graphGroup(filePath) {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length === 1) return 'root';
  if (parts[0] === 'wiki') return parts.length > 2 ? parts[1] : 'wiki';
  return parts[0] || 'root';
}

async function readOverview(root) {
  const files = await readOverviewFiles(root, root);
  const markdownFiles = files.filter((file) => file.fileKind === 'markdown');

  return {
    fileCount: files.length,
    markdownCount: markdownFiles.length,
    recent: markdownFiles
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, 6),
    ...(await readGitChanges(root))
  };
}

async function readOverviewFiles(root, dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (isHiddenSearchEntry(entry.name)) continue;

    const absolute = path.join(dir, entry.name);
    const real = await realpathOrNull(absolute);
    if (!real || !isInside(root, real)) continue;

    const filePath = `${prefix}/${entry.name}`.replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      files.push(...(await readOverviewFiles(root, absolute, filePath)));
      continue;
    }

    const fileKind = fileKindForPath(entry.name);
    if (!entry.isFile() || !fileKind) continue;
    const stat = await fs.stat(real);
    files.push({
      name: entry.name,
      path: filePath,
      fileKind,
      modifiedAt: stat.mtime.toISOString()
    });
  }

  return files;
}

async function readGitChanges(root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all'
      ],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 }
    );
    const entries = stdout.split('\0');
    const changes = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      if (/[RC]/.test(status)) index += 1;
      if (
        fileKindForPath(filePath) &&
        !filePath
          .split('/')
          .some((part) => part.startsWith('.') || part === 'node_modules')
      ) {
        changes.push({
          name: path.basename(filePath),
          path: `/${filePath.replaceAll(path.sep, '/')}`,
          status
        });
      }
    }

    return { gitAvailable: true, changes: changes.slice(0, 20) };
  } catch {
    return { gitAvailable: false, changes: [] };
  }
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
        nodes.push({
          name: entry.name,
          type: 'file',
          path: nodePath,
          fileKind
        });
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
      version: document.version,
      created: document.created
    };
  }

  const absolute = await resolvePath(root, normalized);
  const stat = await fs.stat(absolute);
  return {
    path: normalized,
    content: await fs.readFile(absolute, 'utf8'),
    version: 0,
    // How old the file itself is, so a note written before the frontmatter
    // stamp existed is dated by its age rather than by the day it is reopened.
    created: fileCreated(stat)
  };
}

/**
 * A file's age as an ISO timestamp. Some filesystems report no birth time, and
 * a copied file can report one later than its own contents, so the earlier of
 * birth and modification time is the safer answer.
 */
function fileCreated(stat) {
  return new Date(
    Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs)
  ).toISOString();
}

async function loadMediaFile(root, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  const fileKind = assertMedia(normalized);
  const absolute = await resolvePath(root, normalized);
  const stat = await fs.stat(absolute);

  if (!stat.isFile())
    throw new WorkspaceError(400, 'Path points to a directory.');
  return { path: normalized, absolute, fileKind };
}

async function createFolder(root, folderPath) {
  const normalized = normalizeWorkspaceFolder(folderPath);
  if (normalized === '/') return { path: '/' };

  const target = path.resolve(root, `.${normalized}`);
  if (!isInside(root, target)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }
  await ensureWriteParent(root, path.dirname(target));

  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(target);
    return { path: normalized };
  }

  if (stat.isSymbolicLink()) {
    const real = await fs.realpath(target);
    if (!isInside(root, real)) {
      throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
    }
    stat = await fs.stat(real);
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceError(400, 'Path is not a directory.');
  }
  return { path: normalized };
}

async function saveMediaFile(
  root,
  { folder = '/assets', notePath, name, mimeType, data } = {}
) {
  const extension = mediaExtensionFor(name, mimeType);
  if (!extension)
    throw new WorkspaceError(400, 'Only image and PDF files are supported.');
  if (typeof data !== 'string' || !data) {
    throw new WorkspaceError(400, 'File data is required.');
  }

  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) throw new WorkspaceError(400, 'File data is required.');

  const directory = normalizeWorkspaceFolder(folder);
  const noteStem = noteFileStem(notePath);
  const stem = noteStem || cleanFileStem(name) || timestampStem();

  for (let index = 0; index < 1000; index += 1) {
    const suffix = noteStem
      ? `-${String(index + 1).padStart(2, '0')}`
      : index
        ? `-${index + 1}`
        : '';
    const filePath = `${directory === '/' ? '' : directory}/${stem}${suffix}${extension}`;
    const absolute = await resolvePath(root, filePath, { forWrite: true });
    try {
      await fs.writeFile(absolute, buffer, { flag: 'wx' });
      return {
        path: normalizeWorkspacePath(filePath),
        fileKind: extension === '.pdf' ? 'pdf' : 'image'
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  throw new WorkspaceError(409, 'Could not choose a unique file name.');
}

async function diffFile(root, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const absolute = await resolvePath(root, normalized);
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/');

  try {
    const { stdout: status } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--', relative],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 }
    );
    if (status.startsWith('?? ')) {
      return {
        path: normalized,
        diff: await diffUntrackedFile(root, relative)
      };
    }

    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--', relative],
      {
        cwd: root,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return { path: normalized, diff: stdout };
  } catch (error) {
    if (
      /unknown revision|bad revision|ambiguous argument 'HEAD'/.test(
        error.stderr || ''
      )
    ) {
      return {
        path: normalized,
        diff: await diffUntrackedFile(root, relative)
      };
    }
    throw new WorkspaceError(
      400,
      error.stderr?.trim() || error.message || 'Unable to read git diff.'
    );
  }
}

async function diffUntrackedFile(root, relative) {
  try {
    return (
      await execFileAsync(
        'git',
        ['diff', '--no-index', '--', '/dev/null', relative],
        {
          cwd: root,
          maxBuffer: 10 * 1024 * 1024
        }
      )
    ).stdout;
  } catch (error) {
    if (error.code === 1) return error.stdout;
    throw error;
  }
}

async function saveFile(root, filePath, content) {
  if (typeof content !== 'string') {
    throw new WorkspaceError(400, 'Content must be a string.');
  }

  const normalized = normalizeWorkspacePath(filePath);
  assertMarkdown(normalized);
  const absolute = await resolvePath(root, normalized, { forWrite: true });
  const tempPath = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomUUID()}.tmp`
  );

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempPath, absolute);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  return { success: true, timestamp: new Date().toISOString() };
}

async function renameFile(root, documents, corpus, fromPath, toPath) {
  const from = normalizeWorkspacePath(fromPath);
  const to = normalizeWorkspacePath(toPath);
  assertMarkdown(from);
  assertMarkdown(to);
  if (from === to) return { success: true, path: from, updatedLinks: [] };

  const source = await resolvePath(root, from);
  if (!(await fs.stat(source)).isFile()) {
    throw new WorkspaceError(400, 'Path points to a directory.');
  }
  const target = await resolvePath(root, to, { forWrite: true });

  // Planned before the move, while the old name is still what those links
  // resolve to.
  const rewrites = planLinkRewrites(corpus, from, to);

  const move = async () => {
    try {
      // link() + unlink() rather than rename(), which would silently overwrite
      // a note that already sits at the new name.
      await fs.link(source, target);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new WorkspaceError(409, `A note already exists at ${to}.`);
      }
      throw error;
    }
    await fs.unlink(source);

    const document = documents.get(from);
    if (document) {
      documents.delete(from);
      document.path = to;
      documents.set(to, document);
    }
  };

  const document = documents.get(from);
  await (document ? enqueueDocumentWrite(document, move) : move());

  for (const rewrite of rewrites) {
    await saveFile(root, rewrite.path, rewrite.content);
    // The in-memory copy is now behind the file, so the next open re-reads it
    // rather than serving the pre-rewrite links.
    documents.delete(rewrite.path);
  }

  return { success: true, path: to, updatedLinks: rewrites.map((r) => r.path) };
}

/**
 * Every `[[wiki link]]` that resolves to the renamed note, pointed at its new
 * name. Aliases, heading anchors, and embeds are kept as written. The renamed
 * note itself is skipped: it is the note being edited, and rewriting it under
 * the editor would fight with the open buffer.
 */
function planLinkRewrites(corpus, from, to) {
  const files = corpus.filter((file) => file.fileKind === 'markdown');
  const paths = files.map((file) => file.path);
  // Link text is chosen against the workspace as it will be, so a bare name is
  // only used when it still resolves to the note under its new name.
  const renamedPaths = paths.map((item) => (item === from ? to : item));
  const rewrites = [];

  for (const file of files) {
    if (file.path === from) continue;

    const nextTarget = shortestWikiTarget(to, file.path, renamedPaths);
    let changed = false;
    const content = String(file.content || '').replace(
      /(!?)\[\[([^\][\n]+)\]\]/g,
      (match, embed, value) => {
        const pipeIndex = value.indexOf('|');
        const alias = pipeIndex === -1 ? '' : value.slice(pipeIndex);
        const [target, ...anchor] = (
          pipeIndex === -1 ? value : value.slice(0, pipeIndex)
        ).split('#');
        if (!target.trim()) return match;
        if (resolveWikiLinkPath(target.trim(), file.path, paths) !== from) {
          return match;
        }

        changed = true;
        return `${embed}[[${[nextTarget, ...anchor].join('#')}${alias}]]`;
      }
    );

    if (changed) rewrites.push({ path: file.path, content });
  }

  return rewrites;
}

async function deleteFile(root, documents, filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  if (!fileKindForPath(normalized)) {
    throw new WorkspaceError(
      400,
      'Only Markdown, image, and PDF files are supported.'
    );
  }

  const target = path.resolve(root, `.${normalized}`);
  if (!isInside(root, target)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }

  let real;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new WorkspaceError(404, 'File not found.');
    throw error;
  }
  if (!isInside(root, real)) {
    throw new WorkspaceError(403, 'Path resolves outside WORKSPACE_ROOT.');
  }
  if (!(await fs.stat(real)).isFile()) {
    throw new WorkspaceError(400, 'Path points to a directory.');
  }

  const remove = async () => {
    await fs.rm(target);
    documents.delete(normalized);
    return { success: true, path: normalized };
  };
  const document = documents.get(normalized);
  return document ? enqueueDocumentWrite(document, remove) : remove();
}

async function applyDocumentUpdates(
  root,
  documents,
  filePath,
  version,
  updates
) {
  if (!Array.isArray(updates)) {
    throw new WorkspaceError(400, 'Updates must be an array.');
  }

  const document = await getDocument(root, documents, filePath);
  return enqueueDocumentWrite(document, async () => {
    const baseVersion = parseVersion(version);
    if (baseVersion !== document.version) {
      throw new WorkspaceError(
        409,
        `Document is at version ${document.version}.`
      );
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
    while (document.events.length > MAX_DOCUMENT_EVENTS)
      document.events.shift();
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
  const stat = await fs.stat(absolute);
  document = {
    path: normalized,
    content: await fs.readFile(absolute, 'utf8'),
    version: 0,
    created: fileCreated(stat),
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

/**
 * Matches are collected across the whole corpus and then ranked, rather than
 * returned in walk order: a note that owns an asset should outrank the asset
 * itself, and the note touched this morning should outrank the one filed a
 * year ago.
 */
function buildSearchIndex(files) {
  return {
    search(query, { limit = 50 } = {}) {
      const needle = normalizeSearchQuery(query);
      if (!needle) return [];
      const metadataQuery = parseMetadataQuery(query);

      const results = [];
      const maxResults = Math.max(1, Math.min(Number(limit) || 50, 100));
      const now = newestModified(files);

      for (const file of files) {
        if (metadataQuery) {
          const match = findMetadataMatch(file, metadataQuery);
          if (match)
            results.push({ ...searchResult(file, 'metadata'), ...match });
          continue;
        }

        if (file.lowerPath.includes(needle)) {
          results.push(searchResult(file, 'path'));
          continue;
        }
        if (file.fileKind !== 'markdown') continue;

        const match = findSearchContentMatch(file, needle);
        if (match) results.push({ ...searchResult(file, 'content'), ...match });
      }

      return rankSearchResults(results, files, needle, now).slice(
        0,
        maxResults
      );
    }
  };
}

const SEARCH_MATCH_SCORES = {
  nameExact: 120,
  namePrefix: 90,
  name: 70,
  path: 40,
  metadata: 70,
  content: 30
};
// Big enough that a note mentioning `chart-01.png` outranks the image itself,
// which is the jump the reader nearly always wants.
const MARKDOWN_BONUS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_STEPS = [
  [1, 25],
  [7, 18],
  [30, 12],
  [90, 6]
];

function rankSearchResults(results, files, needle, now) {
  const byPath = new Map(files.map((file) => [file.path, file]));

  return results
    .map((result) => {
      const file = byPath.get(result.path);
      return { result, file, score: searchScore(result, file, needle, now) };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.file?.mtimeMs ?? 0) - (left.file?.mtimeMs ?? 0) ||
        left.result.path.localeCompare(right.result.path)
    )
    .map((entry) => entry.result);
}

function searchScore(result, file, needle, now) {
  const kindScore =
    result.kind === 'path'
      ? pathMatchScore(result.name, needle)
      : SEARCH_MATCH_SCORES[result.kind] || 0;
  const markdown = result.fileKind === 'markdown' ? MARKDOWN_BONUS : 0;

  return kindScore + markdown + recencyScore(file?.mtimeMs, now);
}

function pathMatchScore(name, needle) {
  const stem = name.toLowerCase().replace(/\.[^.]+$/, '');
  if (stem === needle) return SEARCH_MATCH_SCORES.nameExact;
  if (stem.startsWith(needle)) return SEARCH_MATCH_SCORES.namePrefix;
  if (stem.includes(needle)) return SEARCH_MATCH_SCORES.name;
  return SEARCH_MATCH_SCORES.path;
}

/**
 * Recency is measured against the freshest file in the workspace, not the
 * clock, so an archive nobody has touched for a year still ranks its own
 * newest notes first.
 */
function recencyScore(mtimeMs, now) {
  if (!mtimeMs || !now) return 0;
  const age = (now - mtimeMs) / DAY_MS;
  for (const [days, score] of RECENCY_STEPS) if (age <= days) return score;
  return 0;
}

function newestModified(files) {
  return files.reduce((newest, file) => Math.max(newest, file.mtimeMs || 0), 0);
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

      const stats = await statOrNull(real);
      const file = {
        name: entry.name,
        type: 'file',
        path: nodePath,
        fileKind,
        lowerPath: nodePath.toLowerCase(),
        mtimeMs: stats ? stats.mtimeMs : 0
      };

      if (fileKind === 'markdown') {
        file.content = await fs.readFile(real, 'utf8');
        file.lowerContent = file.content.toLowerCase();
        file.metadata = parseFrontmatter(file.content).attributes;
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
  return (
    name.endsWith('.tmp') || name.startsWith('.') || name === 'node_modules'
  );
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

function findMetadataMatch(file, { field, value }) {
  if (file.fileKind !== 'markdown') return null;
  const values = Array.isArray(file.metadata[field])
    ? file.metadata[field]
    : [file.metadata[field]];
  const match = values.find(
    (item) =>
      item != null &&
      (field === 'tags'
        ? String(item).toLowerCase() === value
        : String(item).toLowerCase().includes(value))
  );
  return match === undefined
    ? null
    : {
        field,
        preview: `${field}: ${Array.isArray(file.metadata[field]) ? file.metadata[field].join(', ') : file.metadata[field]}`
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
      if (error.code === 'ENOENT')
        throw new WorkspaceError(404, 'File not found.');
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
    if (stat.isDirectory())
      throw new WorkspaceError(400, 'Path points to a directory.');
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

function mediaExtensionFor(name, mimeType) {
  const mimeExtension = MEDIA_MIME_EXTENSIONS.get(
    String(mimeType || '').toLowerCase()
  );
  if (mimeExtension) return mimeExtension;
  const extension = path.extname(name || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension) || extension === '.pdf') return extension;
  return '';
}

function cleanFileStem(name) {
  return path
    .basename(name || '', path.extname(name || ''))
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function noteFileStem(filePath) {
  try {
    const normalized = normalizeWorkspacePath(filePath);
    if (!isMarkdownPath(normalized)) return '';
    return cleanFileStem(path.basename(normalized, path.extname(normalized)));
  } catch {
    return '';
  }
}

function timestampStem() {
  return `file-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
}

export function normalizeWorkspaceFolder(folder) {
  if (!folder || folder === '/') return '/';
  const value = String(folder);
  const normalized = normalizeWorkspacePath(
    `${value.startsWith('/') ? value : `/${value}`}/_`
  );
  return path.posix.dirname(normalized) || '/';
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
  return (
    relative === '' ||
    (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
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

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}
