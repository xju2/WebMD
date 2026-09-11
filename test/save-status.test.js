import assert from 'node:assert/strict';
import test from 'node:test';
import { saveStatusView } from '../src/save-status.js';

test('claims saved only for an open note with nothing pending', () => {
  assert.deepEqual(saveStatusView({ status: '[Saved]', hasNote: true }), {
    tone: 'ok',
    label: 'All changes saved'
  });
});

test('pending edits override a stale saved status', () => {
  assert.equal(
    saveStatusView({ status: '[Saved]', hasNote: true, unsaved: true }).tone,
    'pending'
  );
  assert.equal(
    saveStatusView({ status: '[Syncing...]', hasNote: true }).label,
    'Saving…'
  );
});

test('a failed save reads as an error, never as saved', () => {
  assert.deepEqual(
    saveStatusView({
      status: '[Offline - Retrying]',
      hasNote: true,
      unsaved: true
    }),
    { tone: 'error', label: 'Offline · edits kept, retrying' }
  );
});

test('no open note is not reported as saved work', () => {
  assert.deepEqual(saveStatusView({ status: '[Saved]', hasNote: false }), {
    tone: 'neutral',
    label: 'No note open'
  });
  assert.equal(
    saveStatusView({ status: '[Read-only]', hasNote: false }).label,
    'Read-only file'
  );
});

test('other in-progress statuses stay pending', () => {
  assert.deepEqual(saveStatusView({ status: '[Writing quote...]' }), {
    tone: 'pending',
    label: 'Writing quote…'
  });
});
