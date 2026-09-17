import { resolveWikiLinkPath } from './wiki-links.js';

const MARKDOWN_PATTERN = /\.(md|markdown)$/i;

/**
 * The shortest wikilink text that resolves back to `targetPath`.
 *
 * Tries a bare name first, then progressively more path segments, and falls
 * back to the absolute path. Every form is verified with the same resolver the
 * app navigates with, so a returned link can never be a dead one — an ambiguous
 * basename simply loses to a longer form instead of being emitted.
 */
export function shortestWikiTarget(
  targetPath,
  currentPath = '',
  paths = [],
  options = {}
) {
  if (typeof targetPath !== 'string' || !targetPath) return '';

  const segments = targetPath
    .replace(MARKDOWN_PATTERN, '')
    .split('/')
    .filter(Boolean);
  const forms = segments.map((_, index) =>
    segments.slice(segments.length - index - 1).join('/')
  );
  forms.push(targetPath);

  for (const form of forms) {
    if (!form) continue;
    if (resolveWikiLinkPath(form, currentPath, paths, options) === targetPath) {
      return form;
    }
  }

  return targetPath;
}
