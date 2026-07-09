import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnifiedDiff } from '../src/diff.js';

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
