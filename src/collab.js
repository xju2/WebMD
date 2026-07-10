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

export function rebaseRemoteUpdate(remoteUpdate, unconfirmedUpdates, makeUpdate) {
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
