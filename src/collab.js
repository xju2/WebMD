import { ChangeSet } from '@codemirror/state';

export function updateFromChangeSet(changes, clientID, id) {
  return {
    id,
    clientID,
    changes: changes.toJSON()
  };
}

export function changeSetFromUpdate(update) {
  return ChangeSet.fromJSON(update.changes);
}

export function composeUpdateChanges(updates) {
  let changes;
  for (const update of updates) {
    const next = changeSetFromUpdate(update);
    changes = changes ? changes.compose(next) : next;
  }
  return changes;
}

/**
 * The single change that turns one text into the other, spanning everything
 * between the first and last character they disagree about. A resync cannot
 * replay the edits that got us here - they were composed against a base the
 * server has thrown away - so it sends this instead.
 */
export function changesBetween(before = '', after = '') {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < limit - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end += 1;
  return ChangeSet.of(
    {
      from: start,
      to: before.length - end,
      insert: after.slice(start, after.length - end)
    },
    before.length
  );
}

export function rebaseRemoteUpdate(
  remoteUpdate,
  unconfirmedUpdates,
  makeUpdate
) {
  const remoteChanges = changeSetFromUpdate(remoteUpdate);
  const localChanges = composeUpdateChanges(unconfirmedUpdates);
  const changesForEditor = localChanges
    ? remoteChanges.map(localChanges, true)
    : remoteChanges;

  return {
    changesForEditor,
    rebasedUpdates: localChanges
      ? updatesFor(localChanges.map(remoteChanges), makeUpdate)
      : []
  };
}

function updatesFor(changes, makeUpdate) {
  return changes.empty ? [] : [makeUpdate(changes)];
}
