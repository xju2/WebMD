import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDateNamedPath,
  noteTitle,
  renamePathForTitle,
  titleFileName
} from '../src/note-title.js';

test('reads the title from frontmatter before the heading', () => {
  assert.equal(
    noteTitle('---\ntitle: Field Notes\n---\n\n# Something else\n'),
    'Field Notes'
  );
  assert.equal(noteTitle('# Field Notes\n\nBody\n'), 'Field Notes');
  assert.equal(noteTitle('Body without a title\n'), '');
});

test('drops characters that file names cannot carry', () => {
  assert.equal(titleFileName('Q3: plans / drafts?'), 'Q3 plans drafts.md');
  assert.equal(titleFileName('  .hidden title.  '), 'hidden title.md');
  assert.equal(titleFileName('***'), '');
  assert.equal(titleFileName(''), '');
});

test('renames only when the title names a different file', () => {
  assert.equal(
    renamePathForTitle('/wiki/Untitled.md', 'Field Notes'),
    '/wiki/Field Notes.md'
  );
  assert.equal(renamePathForTitle('/wiki/Field Notes.md', 'Field Notes'), '');
  assert.equal(renamePathForTitle('/wiki/Untitled.md', '///'), '');
  assert.equal(renamePathForTitle('/photo.png', 'Field Notes'), '');
});

test('recognises date-named daily notes', () => {
  assert.equal(isDateNamedPath('/daily/2026-08-17.md'), true);
  assert.equal(isDateNamedPath('/wiki/Field Notes.md'), false);
});
