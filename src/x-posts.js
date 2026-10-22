import { arxivPasteId, xPostReference } from './editor.js';

// A Markdown link keeps its label; a bare URL (or `<url>`) has none.
const LINK =
  /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()[\]]+)/g;

/** Every X post a note links to, once each, as `{ url, handle, label }`. */
export function collectXPosts(content = '') {
  const posts = new Map();
  for (const [, text, linked, bare] of content.matchAll(LINK)) {
    const reference = xPostReference(linked ?? bare);
    if (!reference || posts.has(reference.url)) continue;
    const label = text?.trim();
    posts.set(reference.url, {
      url: reference.url,
      handle: reference.handle,
      label:
        label && label !== (linked ?? bare) ? label : `${reference.handle} on X`
    });
  }
  return [...posts.values()];
}

// Not accounts: github.com/<these>/<anything> is a site page, not a repository.
const GITHUB_RESERVED = new Set([
  'about',
  'collections',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics'
]);

/**
 * Every repository a note links to, once each, as `{ url, handle, label }`.
 * Issue, PR and file links collapse into their repository.
 */
export function collectGithubRepos(content = '') {
  const repos = new Map();
  for (const [, , linked, bare] of content.matchAll(LINK)) {
    let parsed;
    try {
      parsed = new URL(linked ?? bare);
    } catch {
      continue;
    }
    if (parsed.hostname.replace(/^www\./, '') !== 'github.com') continue;
    const [owner, name] = parsed.pathname.split('/').filter(Boolean);
    const repo = name?.match(/^[\w.-]+/)?.[0].replace(/\.git$/, '');
    if (!repo || GITHUB_RESERVED.has(owner.toLowerCase())) continue;
    const handle = `${owner}/${repo}`;
    const url = `https://github.com/${handle}`;
    if (!repos.has(url)) repos.set(url, { url, handle, label: handle });
  }
  return [...repos.values()];
}

/** Every arXiv paper a note links to, once each (versions merged), as `{ url, handle, label }`. */
export function collectArxivPapers(content = '') {
  const papers = new Map();
  for (const [, text, linked, bare] of content.matchAll(LINK)) {
    const id = arxivPasteId(linked ?? bare)?.replace(/v\d+$/, '');
    if (!id || papers.has(id)) continue;
    const label = text?.trim();
    papers.set(id, {
      url: `https://arxiv.org/abs/${id}`,
      handle: `arXiv:${id}`,
      label: label && !/^arxiv:/i.test(label) ? label : `arXiv:${id}`
    });
  }
  return [...papers.values()];
}
