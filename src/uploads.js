const HEIC_EXTENSIONS = /\.(heic|heif)$/i;
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
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

export function isHeicUploadFile(file) {
  return (
    HEIC_MIME_TYPES.has(String(file?.type || '').toLowerCase()) ||
    HEIC_EXTENSIONS.test(file?.name || '')
  );
}

export async function uploadPayloadForFile(
  file,
  { convertHeicToJpeg = convertHeicToJpegBlob } = {}
) {
  const converted = isHeicUploadFile(file)
    ? await convertHeicToJpeg(file).catch(() => null)
    : null;
  const upload = converted || file;
  return {
    name: converted ? jpegUploadName(file.name) : file.name,
    mimeType: converted ? 'image/jpeg' : file.type,
    data: await blobToBase64(upload)
  };
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function pastedImageSources(clipboardData) {
  return pastedImageSourcesFromHtml(clipboardData?.getData?.('text/html'));
}

export function pastedImageSourcesFromHtml(
  html,
  baseHref = globalThis.location?.href
) {
  if (!html || typeof DOMParser !== 'function') return [];

  const document = new DOMParser().parseFromString(html, 'text/html');
  return [...document.querySelectorAll('img[src]')]
    .map((image) => image.getAttribute('src'))
    .filter((source) => isSupportedPastedImageSource(source, baseHref));
}

export async function uploadFilesForPastedImageSources(
  sources,
  { fetchImpl = fetch, FileImpl = globalThis.File } = {}
) {
  const files = [];
  for (const [index, source] of sources.entries()) {
    const response = await fetchImpl(source);
    if (!response.ok) throw new Error('Pasted image could not be loaded.');

    const blob = await response.blob();
    if (!blob.type?.startsWith('image/')) {
      throw new Error('Pasted content is not an image.');
    }

    const name = pastedImageName(source, blob.type, index);
    files.push(
      typeof FileImpl === 'function'
        ? new FileImpl([blob], name, { type: blob.type })
        : Object.assign(blob, { name })
    );
  }
  return files;
}

function jpegUploadName(name = '') {
  return HEIC_EXTENSIONS.test(name)
    ? name.replace(HEIC_EXTENSIONS, '.jpg')
    : name;
}

function isSupportedPastedImageSource(source, baseHref) {
  if (!source) return false;
  try {
    const sourceUrl = new URL(source, baseHref);
    if (sourceUrl.protocol === 'data:') return source.startsWith('data:image/');
    if (sourceUrl.protocol === 'blob:') return true;

    const baseUrl = new URL(baseHref);
    return sourceUrl.origin === baseUrl.origin;
  } catch {
    return false;
  }
}

function pastedImageName(source, mimeType, index) {
  const extension = IMAGE_MIME_EXTENSIONS.get(mimeType.toLowerCase()) || '.png';
  try {
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop());
    if (name) return name;
  } catch {
    // Data URLs and relative paths use the generated name below.
  }
  return `pasted-image-${index + 1}${extension}`;
}

async function convertHeicToJpegBlob(file) {
  if (typeof createImageBitmap !== 'function' || !globalThis.document)
    return null;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9)
    );
  } finally {
    bitmap?.close?.();
  }
}
