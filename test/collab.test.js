import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import test from 'node:test';
import {
  changeSetFromUpdate,
  changesBetween,
  rebaseRemoteUpdate,
  updateFromChangeSet
} from '../src/collab.js';

function updateFor(content, change, id) {
  return updateFromChangeSet(
    ChangeSet.of(change, Text.of(content.split('\n')).length),
    'client',
    id
  );
}

test('rebases local pending changes over a remote update', () => {
  const base = Text.of(['abc']);
  const local = updateFor('abc', { from: 3, to: 3, insert: 'L' }, 'local:1');
  const remote = updateFor('abc', { from: 0, to: 0, insert: 'R' }, 'remote:1');
  const localDoc = changeSetFromUpdate(local).apply(base);

  const { changesForEditor, rebasedUpdates } = rebaseRemoteUpdate(
    remote,
    [local],
    (changes) => updateFromChangeSet(changes, 'client', 'local:2')
  );

  assert.equal(changesForEditor.apply(localDoc).toString(), 'RabcL');
  assert.equal(
    changeSetFromUpdate(rebasedUpdates[0])
      .apply(changeSetFromUpdate(remote).apply(base))
      .toString(),
    'RabcL'
  );
});

test('spans what two texts disagree about', () => {
  const cases = [
    ['one\ntwo\nthree', 'one\ntwo EDITED\nthree'],
    ['', 'a whole note typed from nothing'],
    ['a note deleted down to nothing', ''],
    ['abc', 'abcdef'],
    ['abcdef', 'abc'],
    ['prefix middle suffix', 'prefix suffix']
  ];
  for (const [before, after] of cases) {
    const changes = changesBetween(before, after);
    assert.equal(
      changes.apply(Text.of(before.split('\n'))).toString(),
      after,
      `${before} -> ${after}`
    );
  }
  assert.equal(changesBetween('same', 'same'), null);
});
