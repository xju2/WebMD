import { WorkspaceError } from './workspace.js';

// Large enough for a full-size photo, small enough that a link to something
// else entirely cannot fill the disk.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20000;

/**
 * Downloads one image a note embeds from the web, as the `{ name, mimeType,
 * data }` payload `saveMediaFile` takes. Fetched here rather than in the
 * browser because image hosts send no CORS headers.
 */
export async function fetchRemoteImage(url, { fetchImpl = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new WorkspaceError(400, `"${url}" is not a link.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkspaceError(400, `"${url}" is not a web link.`);
  }

  const response = await fetchImpl(parsed.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new WorkspaceError(
      502,
      `The image host answered ${response.status}.`
    );
  }
  const mimeType = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new WorkspaceError(415, 'The link is not an image.');
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    throw new WorkspaceError(413, 'The image is larger than 20 MB.');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new WorkspaceError(413, 'The image is larger than 20 MB.');
  }

  return {
    name: decodeURIComponent(parsed.pathname.split('/').pop() || '') || 'image',
    mimeType,
    data: buffer.toString('base64')
  };
}
