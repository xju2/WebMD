import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReplacementDiffFile, parseUnifiedDiff } from '../src/diff.js';

test('parses unified diff hunks into readable line groups', () => {
  const files = parseUnifiedDiff(`diff --git a/note.md b/note.md
index 1111111..2222222 100644
--- a/note.md
+++ b/note.md
@@ -1,3 +1,4 @@ note heading
 title
-old
+new
+extra
 context
\\ No newline at end of file
`);

  assert.equal(files[0].title, 'note.md');
  assert.equal(files[0].hunks[0].header, '@@ -1,3 +1,4 @@');
  assert.equal(files[0].hunks[0].summary, 'note heading');
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => [
      line.kind,
      line.oldNumber,
      line.newNumber,
      line.text
    ]),
    [
      ['context', 1, 1, 'title'],
      ['removed', 2, '', 'old'],
      ['added', '', 2, 'new'],
      ['added', '', 3, 'extra'],
      ['context', 3, 4, 'context'],
      ['note', '', '', '\\ No newline at end of file']
    ]
  );
});

test('returns no files for an empty diff', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('builds a replacement diff preview without mutating text', () => {
  const file = buildReplacementDiffFile('old line\nsecond\n', 'new line\n');

  assert.equal(file.title, 'AI edit preview');
  assert.equal(file.hunks[0].header, '@@ -1,2 +1,1 @@');
  assert.deepEqual(
    file.hunks[0].lines.map((line) => [
      line.kind,
      line.oldNumber,
      line.newNumber,
      line.text
    ]),
    [
      ['removed', 1, '', 'old line'],
      ['removed', 2, '', 'second'],
      ['added', '', 1, 'new line']
    ]
  );
});

test('marks unchanged replacement previews', () => {
  const file = buildReplacementDiffFile('same', 'same');

  assert.equal(file.hunks[0].summary, 'No changes');
  assert.deepEqual(file.hunks[0].lines, [
    { kind: 'context', oldNumber: 1, newNumber: 1, text: 'same' }
  ]);
});
