import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTasks,
  taskCitation,
  taskCompletionEdit
} from '../src/tasks.js';
import { readableTaskSource } from '../src/task-sections.js';

test('a conventional arXiv citation reads as its title and paper link', () => {
  assert.deepEqual(
    taskCitation({
      text: 'Yu et al., "MEGABYTE: Predicting sequences" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185)'
    }),
    {
      title: 'MEGABYTE: Predicting sequences',
      href: 'https://arxiv.org/abs/2305.07185'
    }
  );
});

test('anything else keeps its own prose', () => {
  assert.equal(
    taskCitation({ text: 'who:me read [this paper](https://example.com)' }),
    null
  );
  assert.equal(
    taskCitation({ text: 'An unfinished idea: keep the original.' }),
    null
  );
  // An action in front of the citation is the task, not decoration.
  assert.equal(
    taskCitation({
      text: 'who:me read this, Yu et al., "MEGABYTE" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185)'
    }),
    null
  );
});

test('source labels read as words but keep dates intact', () => {
  assert.equal(
    readableTaskSource('/raw/projects/foundation_universe/gpt-pretraining.md'),
    'foundation universe › gpt pretraining'
  );
  assert.equal(
    readableTaskSource('/raw/dailynotes/2026-08-26.md'),
    'dailynotes › 2026-08-26'
  );
  assert.equal(
    readableTaskSource('notes/v2-final_plan.md'),
    'notes › v2 final plan'
  );
});

test('completion changes only the selected line and rejects stale rows', () => {
  const content = '# Work\n\n- [ ] First\n- [ ] Second 📅 2026-09-20\n';
  const task = collectTasks(content)[1];
  const edit = taskCompletionEdit(content, task, '2026-09-14');
  const updated =
    content.slice(0, edit.from) + edit.insert + content.slice(edit.to);
  assert.equal(
    updated,
    '# Work\n\n- [ ] First\n- [x] Second 📅 2026-09-20 ✅ 2026-09-14\n'
  );
  assert.throws(
    () =>
      taskCompletionEdit(
        content.replace('Second', 'Different'),
        task,
        '2026-09-14'
      ),
    /changed/
  );
  assert.throws(
    () => taskCompletionEdit(updated, task, '2026-09-14'),
    /changed/
  );
});
