import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pastedImageSourcesFromHtml,
  uploadFilesForPastedImageSources,
  uploadPayloadForFile
} from '../src/uploads.js';

test('converts HEIC upload payloads to JPEG when browser decoding works', async () => {
  const heic = new Blob(['heic'], { type: 'image/heic' });
  heic.name = 'clip.HEIC';
  const jpeg = new Blob(['jpg'], { type: 'image/jpeg' });

  const payload = await uploadPayloadForFile(heic, {
    convertHeicToJpeg: async () => jpeg
  });

  assert.equal(payload.name, 'clip.jpg');
  assert.equal(payload.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(payload.data, 'base64').toString(), 'jpg');
});

test('keeps the original HEIC payload when browser decoding fails', async () => {
  const heic = new Blob(['heic'], { type: 'image/heic' });
  heic.name = 'clip.HEIC';

  const payload = await uploadPayloadForFile(heic, {
    convertHeicToJpeg: async () => null
  });

  assert.equal(payload.name, 'clip.HEIC');
  assert.equal(payload.mimeType, 'image/heic');
  assert.equal(Buffer.from(payload.data, 'base64').toString(), 'heic');
});

test('converts pasted image sources into upload files', async () => {
  const originalDomParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelectorAll() {
          return [
            { getAttribute: () => '/api/workspace/media?path=/assets/clip.png' },
            { getAttribute: () => 'data:image/png;base64,cG5n' },
            { getAttribute: () => 'https://example.com/clip.png' }
          ];
        }
      };
    }
  };

  try {
    const sources = pastedImageSourcesFromHtml(
      '<img src="/api/workspace/media?path=/assets/clip.png">',
      'http://127.0.0.1:3000/note'
    );
    assert.deepEqual(sources, [
      '/api/workspace/media?path=/assets/clip.png',
      'data:image/png;base64,cG5n'
    ]);

    const files = await uploadFilesForPastedImageSources(sources.slice(0, 1), {
      fetchImpl: async (source) => {
        assert.equal(source, '/api/workspace/media?path=/assets/clip.png');
        return new Response(new Blob(['png'], { type: 'image/png' }));
      }
    });
    const payload = await uploadPayloadForFile(files[0]);

    assert.equal(payload.mimeType, 'image/png');
    assert.equal(Buffer.from(payload.data, 'base64').toString(), 'png');
  } finally {
    globalThis.DOMParser = originalDomParser;
  }
});
