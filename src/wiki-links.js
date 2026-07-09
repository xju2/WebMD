export function parseWikiLinkValue(value = '') {
  const pipeIndex = value.indexOf('|');
  const target = (pipeIndex === -1 ? value : value.slice(0, pipeIndex)).trim();
  const text = (pipeIndex === -1 ? target : value.slice(pipeIndex + 1)).trim();

  return { target, text: text || target };
}

export function resolveWikiLinkPath(target, currentPath = '', files = []) {
  const markdownTarget = toMarkdownTarget(target);
  if (!markdownTarget) return '';

  if (markdownTarget.startsWith('/'))
    return normalizeWorkspacePath(markdownTarget);

  const markdownPaths = files
    .filter((file) => typeof file === 'string' || file?.fileKind === 'markdown')
    .map((file) => (typeof file === 'string' ? file : file.path))
    .filter(Boolean);

  if (markdownTarget.includes('/')) {
    const suffixMatch = findUniquePath(markdownPaths, (path) =>
      path.endsWith(`/${markdownTarget}`)
    );
    if (suffixMatch) return suffixMatch;
  }

  const siblingPath = joinWorkspacePath(
    currentDirectory(currentPath),
    markdownTarget
  );

  if (!markdownTarget.includes('/') && markdownPaths.includes(siblingPath)) {
    return siblingPath;
  }

  if (!markdownTarget.includes('/')) {
    const nameMatch = findUniquePath(markdownPaths, (path) =>
      path.endsWith(`/${markdownTarget}`)
    );
    if (nameMatch) return nameMatch;
  }

  return siblingPath;
}

function toMarkdownTarget(target) {
  if (typeof target !== 'string') return '';

  const fileTarget = target.split('#')[0].trim();
  if (
    !fileTarget ||
    fileTarget.includes('\0') ||
    fileTarget.includes('\\') ||
    fileTarget.split('/').some((part) => part === '..')
  ) {
    return '';
  }

  return /\.(md|markdown)$/i.test(fileTarget) ? fileTarget : `${fileTarget}.md`;
}

function joinWorkspacePath(parent, child) {
  return normalizeWorkspacePath(`${parent === '/' ? '' : parent}/${child}`);
}

function currentDirectory(filePath) {
  const normalized = normalizeWorkspacePath(filePath);
  if (!normalized) return '/';

  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : normalized.slice(0, slashIndex);
}

function normalizeWorkspacePath(filePath) {
  if (typeof filePath !== 'string') return '';

  const absolute = filePath.startsWith('/') ? filePath : `/${filePath}`;
  const parts = [];

  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    parts.push(part);
  }

  return parts.length ? `/${parts.join('/')}` : '';
}

function findUniquePath(paths, predicate) {
  const matches = paths.filter(predicate);
  return matches.length === 1 ? matches[0] : '';
}
