import { xPostReference } from './editor.js';

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
