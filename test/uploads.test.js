import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadPayloadForFile } from '../src/uploads.js';

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
