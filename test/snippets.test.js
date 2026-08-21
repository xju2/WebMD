import assert from 'node:assert/strict';
import test from 'node:test';
import { SNIPPETS, clockTime, snippetExpansion } from '../src/snippets.js';

const NOW = { date: '2026-08-21', time: '14:30' };

function expand(beforeCursor, context = NOW) {
  const expansion = snippetExpansion(beforeCursor, context);
  return expansion && expansion.insert;
}

test('expands a date snippet to plain text', () => {
  assert.equal(expand('/date'), '2026-08-21');
  assert.equal(expand('/now'), '2026-08-21 14:30');
  assert.equal(expand('/lastupdate'), 'Last update: 2026-08-21');
});

test('links the neighbouring daily notes', () => {
  assert.equal(expand('/today'), '[[2026-08-21]]');
  assert.equal(expand('/tomorrow'), '[[2026-08-22]]');
  assert.equal(expand('/yesterday'), '[[2026-08-20]]');
});

test('replaces only the token, wherever it sits on the line', () => {
  const expansion = snippetExpansion('Shipped the fit /date', NOW);
  assert.deepEqual(expansion, {
    length: 5,
    insert: '2026-08-21',
    caret: 10
  });
});

test('leaves the caret where the snippet marks it', () => {
  assert.deepEqual(snippetExpansion('/task', NOW), {
    length: 5,
    insert: '- [ ] ',
    caret: 6
  });
  assert.deepEqual(snippetExpansion('/note', NOW), {
    length: 5,
    insert: '> [!note] ',
    caret: 10
  });
  const table = snippetExpansion('/table', NOW);
  assert.equal(table.insert, '| | |\n| --- | --- |\n| | |');
  assert.equal(table.caret, 2);
});

test('carries the time into a log bullet', () => {
  assert.equal(expand('/log'), '- **14:30** ');
});

test('ignores a token that does not open a word', () => {
  assert.equal(expand('https://example.com/date'), null);
  assert.equal(expand('~/notes/date'), null);
});

test('ignores an unknown token', () => {
  assert.equal(expand('/nosuchthing'), null);
  assert.equal(expand('/'), null);
  assert.equal(expand(''), null);
});

test('expands after an opening bracket or quote', () => {
  assert.equal(expand('("/date'), '2026-08-21');
  assert.equal(expand('[/today'), '[[2026-08-21]]');
});

test('skips a dated snippet when the date is unknown', () => {
  assert.equal(expand('/lastupdate', { date: '', time: '14:30' }), null);
  assert.equal(expand('/tomorrow', { date: '', time: '' }), null);
  assert.equal(expand('/task', { date: '', time: '' }), '- [ ] ');
});

test('every snippet has a unique lowercase name and a hint', () => {
  const names = SNIPPETS.map((snippet) => snippet.name);
  assert.equal(new Set(names).size, names.length);
  for (const snippet of SNIPPETS) {
    assert.match(snippet.name, /^[a-z]+$/);
    assert.ok(snippet.hint, `${snippet.name} needs a hint`);
    assert.ok(snippetExpansion(`/${snippet.name}`, NOW));
  }
});

test('pads the wall clock to two digits', () => {
  assert.equal(clockTime(new Date(2026, 7, 21, 9, 5)), '09:05');
  assert.equal(clockTime(new Date(2026, 7, 21, 14, 30)), '14:30');
});
