const HEIC_EXTENSIONS = /\.(heic|heif)$/i;
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);

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

function jpegUploadName(name = '') {
  return HEIC_EXTENSIONS.test(name)
    ? name.replace(HEIC_EXTENSIONS, '.jpg')
    : name;
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
