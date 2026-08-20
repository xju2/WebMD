const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MARKDOWN_PATTERN = /\.(md|markdown)$/i;
const MEDIA_PATTERN = /\.(avif|gif|heic|heif|jpe?g|png|svg|webp|pdf)$/i;

export function parseWikiLinkValue(value = '') {
  const pipeIndex = value.indexOf('|');
  const target = (pipeIndex === -1 ? value : value.slice(0, pipeIndex)).trim();
  const text = (pipeIndex === -1 ? '' : value.slice(pipeIndex + 1)).trim();

  return { target, text: text || wikiLinkLabel(target) };
}

// A link without an alias reads better as just the note's name: the folders it
// lives in are how the link resolves, not what the sentence is about. Any
// `#heading` the target carries stays, since that is part of the destination.
export function wikiLinkLabel(target = '') {
  const trimmed = String(target).trim();
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);

  return name || trimmed;
}

export function isMediaWikiTarget(target) {
  return (
    typeof target === 'string' &&
    MEDIA_PATTERN.test(target.split('#')[0].trim())
  );
}

export function resolveWikiLinkPath(
  target,
  currentPath = '',
  files = [],
  { dailyNoteFolder = '' } = {}
) {
  const fileTarget = toFileTarget(target);
  if (!fileTarget) return '';

  if (fileTarget.startsWith('/')) return normalizeWorkspacePath(fileTarget);

  const kindPattern = MEDIA_PATTERN.test(fileTarget)
    ? MEDIA_PATTERN
    : MARKDOWN_PATTERN;
  const candidatePaths = files
    .map((file) => (typeof file === 'string' ? file : file?.path))
    .filter((path) => typeof path === 'string' && kindPattern.test(path));

  const dailyNotePath = toDailyNotePath(fileTarget, dailyNoteFolder);
  if (dailyNotePath && candidatePaths.includes(dailyNotePath)) {
    return dailyNotePath;
  }

  if (fileTarget.includes('/')) {
    const suffixMatch = findUniquePath(candidatePaths, (path) =>
      path.endsWith(`/${fileTarget}`)
    );
    if (suffixMatch) return suffixMatch;
  }

  const siblingPath = joinWorkspacePath(
    currentDirectory(currentPath),
    fileTarget
  );

  if (!fileTarget.includes('/') && candidatePaths.includes(siblingPath)) {
    return siblingPath;
  }

  if (!fileTarget.includes('/')) {
    const nameMatch = findUniquePath(candidatePaths, (path) =>
      path.endsWith(`/${fileTarget}`)
    );
    if (nameMatch) return nameMatch;
  }

  return dailyNotePath || siblingPath;
}

function toDailyNotePath(fileTarget, folder) {
  if (fileTarget.includes('/')) return '';
  if (!DATE_PATTERN.test(fileTarget.replace(MARKDOWN_PATTERN, ''))) return '';

  const parent =
    folder === '/' ? '/' : normalizeWorkspacePath(String(folder ?? ''));
  return parent ? joinWorkspacePath(parent, fileTarget) : '';
}

function toFileTarget(target) {
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

  return MARKDOWN_PATTERN.test(fileTarget) || MEDIA_PATTERN.test(fileTarget)
    ? fileTarget
    : `${fileTarget}.md`;
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
