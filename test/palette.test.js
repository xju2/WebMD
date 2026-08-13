import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPaletteIndex,
  paletteResultLabel,
  recentPaletteResults,
  stepPaletteIndex
} from '../src/palette.js';

test('wraps the palette highlight at both ends', () => {
  assert.equal(stepPaletteIndex(3, 0, 1), 1);
  assert.equal(stepPaletteIndex(3, 2, 1), 0);
  assert.equal(stepPaletteIndex(3, 0, -1), 2);
  assert.equal(stepPaletteIndex(0, 0, 1), -1);
});

test('keeps the highlight on a real row as results change', () => {
  assert.equal(clampPaletteIndex(3, 1), 1);
  assert.equal(clampPaletteIndex(3, 7), 0);
  assert.equal(clampPaletteIndex(3, -1), 0);
  assert.equal(clampPaletteIndex(0, 2), -1);
});

test('labels a result by how it matched', () => {
  assert.equal(
    paletteResultLabel({ kind: 'content', lineNumber: 12, path: '/a.md' }),
    'Line 12'
  );
  assert.equal(
    paletteResultLabel({ kind: 'metadata', field: 'tags', path: '/a.md' }),
    'tags'
  );
  assert.equal(paletteResultLabel({ kind: 'name', path: '/a.md' }), '/a.md');
  assert.equal(paletteResultLabel(null), '');
});

test('turns recent files into palette rows', () => {
  const rows = recentPaletteResults([
    { name: 'a.md', path: '/a.md', fileKind: 'markdown', type: 'file' }
  ]);

  assert.deepEqual(rows, [
    { name: 'a.md', path: '/a.md', fileKind: 'markdown', kind: 'recent' }
  ]);
});
