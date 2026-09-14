import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTasks,
  taskCompletionEdit,
  taskDisplayTitle
} from '../src/tasks.js';
import { readableTaskSource } from '../src/task-sections.js';

test('readable labels preserve prose and extract conventional citation titles', () => {
  assert.equal(
    taskDisplayTitle({
      text: 'Yu et al., "MEGABYTE: Predicting sequences" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185)'
    }),
    'MEGABYTE: Predicting sequences'
  );
  assert.equal(
    taskDisplayTitle({ text: 'who:me read [this paper](https://example.com)' }),
    'Me read this paper'
  );
  assert.equal(
    taskDisplayTitle({ text: 'An unfinished idea: keep the original.' }),
    'An unfinished idea: keep the original.'
  );
  assert.equal(
    readableTaskSource('/raw/projects/foundation_universe/gpt-pretraining.md'),
    'foundation universe › gpt pretraining'
  );
});

test('a citation with an explicit action keeps that action', () => {
  assert.match(
    taskDisplayTitle({
      text: 'who:me read this, Yu et al., "MEGABYTE" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185)'
    }),
    /^Me read this/
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
