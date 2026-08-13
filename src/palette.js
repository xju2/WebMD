// Quick-open palette helpers. Kept apart from App.svelte so the selection and
// labelling rules can be tested without a DOM.

// Moves the highlighted row, wrapping at both ends so Down on the last result
// returns to the first. An empty list has nothing to highlight.
export function stepPaletteIndex(count, index, step) {
  if (count <= 0) return -1;

  const next = (index + step) % count;
  return next < 0 ? next + count : next;
}

// Keeps the highlight on a real row after the results change: the first row,
// or nothing at all while the list is empty.
export function clampPaletteIndex(count, index) {
  if (count <= 0) return -1;
  return index >= 0 && index < count ? index : 0;
}

// The muted line under a result name. Content matches point at the line they
// hit, metadata matches name the field, and everything else shows the path.
export function paletteResultLabel(result) {
  if (!result) return '';
  if (result.kind === 'content') return `Line ${result.lineNumber}`;
  if (result.kind === 'metadata') return result.field;
  return result.path;
}

// Recent files become palette rows so an empty query still opens something.
export function recentPaletteResults(files) {
  return files.map((file) => ({
    name: file.name,
    path: file.path,
    fileKind: file.fileKind,
    kind: 'recent'
  }));
}
