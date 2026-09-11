import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_NOTE_CONTEXT_CHARS, chatContext } from '../src/ai-context.js';

test('a selection is the whole context and says the note is left out', () => {
  const context = chatContext({
    notePath: '/notes/draft.md',
    noteLength: 500,
    selectedText: '  The results indicate a trend.  '
  });
  assert.equal(context.kind, 'selection');
  assert.equal(context.summary, 'Selection · 29 chars');
  assert.equal(context.source, 'draft.md');
  assert.match(context.details[0], /not the rest of the note/);
  assert.deepEqual(context.payload, {
    path: '/notes/draft.md',
    selectedText: '  The results indicate a trend.  '
  });
});

test('a long selection is excerpted in the label only', () => {
  const text = 'x'.repeat(500);
  const context = chatContext({ selectedText: text });
  assert.equal(context.excerpt.length, 161);
  assert.equal(context.payload.selectedText, text);
  assert.equal(context.details[0], 'Only the selected text is sent.');
});

test('a blank selection falls back to the note, as the server does', () => {
  const context = chatContext({
    notePath: '/a.md',
    noteLength: 40,
    selectedText: '   \n'
  });
  assert.equal(context.kind, 'note');
  assert.equal(context.summary, 'Note · a.md');
  assert.equal(context.details[0], 'All of /a.md is sent (40 characters).');
});

test('a long note reports the truncation the server applies', () => {
  const context = chatContext({ notePath: '/long.md', noteLength: 30000 });
  assert.equal(MAX_NOTE_CONTEXT_CHARS, 12000);
  assert.equal(
    context.details[0],
    'The first 12,000 of 30,000 characters of /long.md are sent.'
  );
});

test('an empty note sends only its path', () => {
  const context = chatContext({ notePath: '/empty.md', noteLength: 0 });
  assert.match(context.details[0], /only its path is sent/);
});

test('unsynced edits are called out, since the server reads the saved copy', () => {
  const context = chatContext({
    notePath: '/a.md',
    noteLength: 10,
    unsaved: true
  });
  assert.match(context.details[1], /saved copy/);
});

test('a hidden note is named as left out, never as context', () => {
  const context = chatContext({ hiddenNotePath: '/README.md' });
  assert.equal(context.kind, 'none');
  assert.equal(context.summary, 'No note context');
  assert.deepEqual(context.payload, { path: '', selectedText: '' });
  assert.match(context.details[0], /\/README\.md stays out/);
});

test('names the kind of context, never a paper', () => {
  // A note called paper.md is still a note: its name is shown as a file name,
  // and the kind label never claims paper context the app does not send.
  const labels = [
    chatContext({}),
    chatContext({ notePath: '/paper.md', noteLength: 10 }),
    chatContext({ selectedText: 'abc' })
  ].map((context) => context.summary);
  assert.deepEqual(labels, [
    'No note context',
    'Note · paper.md',
    'Selection · 3 chars'
  ]);
  for (const label of labels) assert.doesNotMatch(label, /current paper/i);
});
