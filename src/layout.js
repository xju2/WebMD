// Panel layout: a slim rail, the file sidebar on the left, the workspace in the
// middle, and the AI panel on the right. Kept free of the DOM so the rules that
// decide what docks, what floats, and what is remembered can be tested.
//
// Two kinds of state feed it:
// - prefs: what the user chose on a desktop-sized window. Remembered.
// - transient: what is open while the window is too small to dock a panel.
//   Never remembered, so squeezing the window cannot overwrite a preference.

export const LAYOUT_KEY = 'webmd:layout';
export const RAIL_WIDTH = 52;
// Below this the reading column stops being comfortable, so a panel that would
// squeeze it floats over it instead.
export const CENTER_MIN = 520;
// Matches NARROW_LAYOUT_QUERY in App.svelte and the stylesheet breakpoint.
export const NARROW_MAX = 760;
export const WIDTH_LIMITS = {
  files: { min: 180, max: 480, initial: 240 },
  ai: { min: 280, max: 720, initial: 340 }
};
export const WIDTH_STEP = 16;

export const DEFAULT_PREFS = Object.freeze({
  filesOpen: true,
  aiOpen: false,
  filesWidth: WIDTH_LIMITS.files.initial,
  aiWidth: WIDTH_LIMITS.ai.initial
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function cleanWidth(panel, value) {
  const { min, max, initial } = WIDTH_LIMITS[panel];
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? clamp(number, min, max) : initial;
}

/**
 * Stored preferences, repaired: anything missing, malformed, or out of range
 * falls back to the default for that field alone. Only these four fields are
 * kept, so nothing else ever lands in storage through here.
 */
export function readLayoutPrefs(raw) {
  let stored = {};
  try {
    stored = JSON.parse(raw || '{}') || {};
  } catch {
    stored = {};
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    filesOpen:
      typeof stored.filesOpen === 'boolean'
        ? stored.filesOpen
        : DEFAULT_PREFS.filesOpen,
    aiOpen:
      typeof stored.aiOpen === 'boolean' ? stored.aiOpen : DEFAULT_PREFS.aiOpen,
    filesWidth: cleanWidth(
      'files',
      stored.filesWidth ?? DEFAULT_PREFS.filesWidth
    ),
    aiWidth: cleanWidth('ai', stored.aiWidth ?? DEFAULT_PREFS.aiWidth)
  };
}

export function serializeLayoutPrefs(prefs) {
  const clean = readLayoutPrefs(JSON.stringify(prefs));
  return JSON.stringify(clean);
}

/**
 * What each panel is doing at this window width: `docked` beside the
 * workspace, `overlay` floating over it, or `hidden`. Widths are what to draw;
 * a docked panel may be drawn narrower than its preference so the reading
 * column keeps CENTER_MIN, without that narrower width being remembered.
 *
 * The file sidebar docks first. The AI panel docks only if what is left still
 * fits it; otherwise it opens as an overlay. At phone width both float.
 */
export function resolveLayout({ viewportWidth, prefs, transient }) {
  const width = Number(viewportWidth) || 0;
  const narrow = width <= NARROW_MAX;
  const room = width - RAIL_WIDTH - CENTER_MIN;

  if (narrow) {
    const sheet = Math.max(width - RAIL_WIDTH, 0);
    return {
      narrow,
      files: transient.filesOpen ? 'overlay' : 'hidden',
      ai: transient.aiOpen ? 'overlay' : 'hidden',
      filesWidth: Math.min(prefs.filesWidth, sheet, 320),
      aiWidth: sheet,
      filesDockable: false,
      aiDockable: false
    };
  }

  const filesDockable = room >= WIDTH_LIMITS.files.min;
  const filesDocked = filesDockable && prefs.filesOpen;
  const filesWidth = filesDocked
    ? clamp(prefs.filesWidth, WIDTH_LIMITS.files.min, room)
    : prefs.filesWidth;
  const aiRoom = room - (filesDocked ? filesWidth : 0);
  // Whether the AI panel docks depends on the window, not on whether the file
  // sidebar happens to be open: otherwise closing the sidebar would turn an
  // open AI overlay into a docked panel whose remembered state is "closed",
  // and it would vanish under the user's hand.
  const aiDockable =
    room - (filesDockable ? filesWidth : 0) >= WIDTH_LIMITS.ai.min;
  const aiDocked = aiDockable && prefs.aiOpen;

  return {
    narrow,
    files: filesDockable
      ? filesDocked
        ? 'docked'
        : 'hidden'
      : transient.filesOpen
        ? 'overlay'
        : 'hidden',
    ai: aiDockable
      ? aiDocked
        ? 'docked'
        : 'hidden'
      : transient.aiOpen
        ? 'overlay'
        : 'hidden',
    filesWidth,
    aiWidth: aiDocked
      ? clamp(prefs.aiWidth, WIDTH_LIMITS.ai.min, aiRoom)
      : Math.min(prefs.aiWidth, Math.max(width - RAIL_WIDTH - 48, 0)),
    filesDockable,
    aiDockable
  };
}

/**
 * Opens or closes one panel. Where the panel can dock this flips the
 * remembered preference; where it cannot, only the transient state changes.
 * At phone width the two overlays are exclusive, so opening one closes the
 * other rather than stacking them.
 */
export function togglePanel(panel, { layout, prefs, transient }) {
  const openKey = panel === 'files' ? 'filesOpen' : 'aiOpen';
  const dockable = panel === 'files' ? layout.filesDockable : layout.aiDockable;
  if (dockable) {
    return { prefs: { ...prefs, [openKey]: !prefs[openKey] }, transient };
  }
  const opening = !transient[openKey];
  const next = { ...transient, [openKey]: opening };
  if (opening && layout.narrow) {
    next[panel === 'files' ? 'aiOpen' : 'filesOpen'] = false;
  }
  return { prefs, transient: next };
}

/** Closes a panel however it is currently shown. */
export function closePanel(panel, { layout, prefs, transient }) {
  const mode = layout[panel];
  if (mode === 'hidden') return { prefs, transient };
  return togglePanel(panel, { layout, prefs, transient });
}

/**
 * The width a drag or key press asks for, kept inside the panel's limits and
 * — for a docked panel — inside the room the reading column can spare.
 */
export function clampPanelWidth(
  panel,
  width,
  { viewportWidth, otherWidth = 0 }
) {
  const { min, max } = WIDTH_LIMITS[panel];
  const room = viewportWidth - RAIL_WIDTH - CENTER_MIN - otherWidth;
  return clamp(Math.round(width), min, Math.max(min, Math.min(max, room)));
}

/**
 * Keyboard resizing for a separator. Arrows move the panel's inner edge by one
 * step (Shift for four), Home and End jump to the limits. The file sidebar
 * grows to the right, the AI panel to the left. Returns null for other keys.
 */
export function keyboardWidth(panel, width, key, { shift = false } = {}) {
  const { min, max } = WIDTH_LIMITS[panel];
  const step = WIDTH_STEP * (shift ? 4 : 1);
  const grow = panel === 'files' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = panel === 'files' ? 'ArrowLeft' : 'ArrowRight';
  if (key === grow) return width + step;
  if (key === shrink) return width - step;
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
}
