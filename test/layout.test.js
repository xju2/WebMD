import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CENTER_MIN,
  DEFAULT_PREFS,
  RAIL_WIDTH,
  WIDTH_LIMITS,
  clampPanelWidth,
  closePanel,
  keyboardWidth,
  readLayoutPrefs,
  resolveLayout,
  serializeLayoutPrefs,
  togglePanel
} from '../src/layout.js';

const closed = { filesOpen: false, aiOpen: false };
const prefs = (overrides = {}) => ({ ...DEFAULT_PREFS, ...overrides });

test('reads defaults when nothing is stored', () => {
  assert.deepEqual(readLayoutPrefs(null), DEFAULT_PREFS);
  assert.deepEqual(readLayoutPrefs('not json'), DEFAULT_PREFS);
  assert.deepEqual(readLayoutPrefs('[1,2]'), DEFAULT_PREFS);
  assert.equal(DEFAULT_PREFS.filesWidth, 240);
  assert.equal(DEFAULT_PREFS.aiWidth, 340);
  assert.equal(DEFAULT_PREFS.filesOpen, true);
  assert.equal(DEFAULT_PREFS.aiOpen, false);
});

test('repairs each stored field on its own', () => {
  assert.deepEqual(
    readLayoutPrefs(
      JSON.stringify({
        filesOpen: 'yes',
        aiOpen: true,
        filesWidth: 9999,
        aiWidth: 'x'
      })
    ),
    { filesOpen: true, aiOpen: true, filesWidth: 480, aiWidth: 340 }
  );
  assert.equal(readLayoutPrefs('{"filesWidth":10}').filesWidth, 180);
});

test('stores only the four layout fields', () => {
  const stored = JSON.parse(
    serializeLayoutPrefs({ ...prefs(), chat: ['secret'], path: '/note.md' })
  );
  assert.deepEqual(Object.keys(stored).sort(), [
    'aiOpen',
    'aiWidth',
    'filesOpen',
    'filesWidth'
  ]);
});

test('docks both panels on a wide desktop', () => {
  const layout = resolveLayout({
    viewportWidth: 1600,
    prefs: prefs({ aiOpen: true }),
    transient: closed
  });
  assert.equal(layout.files, 'docked');
  assert.equal(layout.ai, 'docked');
  assert.equal(layout.filesWidth, 240);
  assert.equal(layout.aiWidth, 340);
});

test('narrows a docked AI panel to keep the reading column', () => {
  const viewportWidth = 1100;
  const layout = resolveLayout({
    viewportWidth,
    prefs: prefs({ aiOpen: true }),
    transient: closed
  });
  assert.equal(layout.ai, 'docked');
  assert.equal(
    viewportWidth - RAIL_WIDTH - layout.filesWidth - layout.aiWidth,
    CENTER_MIN
  );
});

test('floats the AI panel when a laptop cannot spare the room', () => {
  const remembered = prefs({ aiOpen: true });
  const layout = resolveLayout({
    viewportWidth: 1024,
    prefs: remembered,
    transient: closed
  });
  assert.equal(layout.files, 'docked');
  // Remembered as open, but not forced into a column that does not fit.
  assert.equal(layout.ai, 'hidden');
  assert.equal(layout.aiDockable, false);
  const opened = togglePanel('ai', {
    layout,
    prefs: remembered,
    transient: closed
  });
  assert.equal(opened.prefs, remembered, 'the desktop preference is untouched');
  assert.equal(resolveLayout({ viewportWidth: 1024, ...opened }).ai, 'overlay');
});

test('collapsing the sidebar does not flip an open AI overlay', () => {
  const state = {
    prefs: prefs(),
    transient: { filesOpen: false, aiOpen: true }
  };
  const before = resolveLayout({ viewportWidth: 1024, ...state });
  assert.equal(before.ai, 'overlay');
  const next = togglePanel('files', { layout: before, ...state });
  assert.equal(next.prefs.filesOpen, false);
  assert.equal(resolveLayout({ viewportWidth: 1024, ...next }).ai, 'overlay');
});

test('phone width floats both panels, one at a time, closed by default', () => {
  const remembered = prefs({ filesOpen: true, aiOpen: true });
  const layout = resolveLayout({
    viewportWidth: 400,
    prefs: remembered,
    transient: closed
  });
  assert.equal(layout.files, 'hidden');
  assert.equal(layout.ai, 'hidden');

  let state = togglePanel('files', {
    layout,
    prefs: remembered,
    transient: closed
  });
  assert.equal(
    resolveLayout({ viewportWidth: 400, ...state }).files,
    'overlay'
  );
  state = togglePanel('ai', {
    layout: resolveLayout({ viewportWidth: 400, ...state }),
    ...state
  });
  const both = resolveLayout({ viewportWidth: 400, ...state });
  assert.equal(both.ai, 'overlay');
  assert.equal(both.files, 'hidden');
  assert.equal(both.aiWidth, 400 - RAIL_WIDTH);
  assert.equal(state.prefs, remembered);
});

test('widening the window again restores the desktop preference', () => {
  const remembered = prefs({ filesOpen: false, aiOpen: true });
  const phone = resolveLayout({
    viewportWidth: 400,
    prefs: remembered,
    transient: closed
  });
  const state = togglePanel('files', {
    layout: phone,
    prefs: remembered,
    transient: closed
  });
  const desktop = resolveLayout({ viewportWidth: 1600, ...state });
  assert.equal(desktop.files, 'hidden');
  assert.equal(desktop.ai, 'docked');
});

test('closePanel leaves a hidden panel alone', () => {
  const state = { prefs: prefs(), transient: closed };
  const layout = resolveLayout({ viewportWidth: 1600, ...state });
  assert.deepEqual(closePanel('ai', { layout, ...state }), state);
  assert.equal(
    closePanel('files', { layout, ...state }).prefs.filesOpen,
    false
  );
});

test('clamps a requested width to the limits and the spare room', () => {
  assert.equal(clampPanelWidth('files', 50, { viewportWidth: 1600 }), 180);
  assert.equal(clampPanelWidth('files', 900, { viewportWidth: 1600 }), 480);
  assert.equal(
    clampPanelWidth('ai', 700, { viewportWidth: 1200, otherWidth: 240 }),
    1200 - RAIL_WIDTH - CENTER_MIN - 240
  );
  assert.equal(
    clampPanelWidth('ai', 700, { viewportWidth: 800, otherWidth: 240 }),
    WIDTH_LIMITS.ai.min
  );
});

test('arrow keys move each panel inner edge the natural way', () => {
  assert.equal(keyboardWidth('files', 240, 'ArrowRight'), 256);
  assert.equal(keyboardWidth('files', 240, 'ArrowLeft'), 224);
  assert.equal(keyboardWidth('ai', 340, 'ArrowLeft'), 356);
  assert.equal(keyboardWidth('ai', 340, 'ArrowRight', { shift: true }), 276);
  assert.equal(keyboardWidth('ai', 340, 'Home'), WIDTH_LIMITS.ai.min);
  assert.equal(keyboardWidth('files', 240, 'End'), WIDTH_LIMITS.files.max);
  assert.equal(keyboardWidth('files', 240, 'Enter'), null);
});
