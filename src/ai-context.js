// What a chat request carries to the AI, and how the panel says so. The label
// and the payload come from the same object, so the panel can never describe
// one context while the request sends another.
//
// The rules mirror chatMessages in server/ai.js:
// - a non-blank selection is sent on its own; the note around it is not;
// - otherwise the server reads the note from disk and sends up to
//   MAX_NOTE_CONTEXT_CHARS of it;
// - an empty note sends only its path;
// - with no note, only the question goes.

export const MAX_NOTE_CONTEXT_CHARS = 12000;
const EXCERPT_CHARS = 160;

const basename = (path) => path.split('/').filter(Boolean).pop() || path;
const count = (n) => n.toLocaleString('en-US');
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {object} input
 * @param {string} input.notePath   the note whose text may be sent: only a
 *   Markdown note on screen, never one hidden behind another view
 * @param {number} input.noteLength characters in that note as last saved
 * @param {boolean} input.unsaved   edits not yet written to disk
 * @param {string} input.selectedText
 * @param {string} input.hiddenNotePath a note that is open but not on screen,
 *   named only to explain why it is left out
 */
export function chatContext({
  notePath = '',
  noteLength = 0,
  unsaved = false,
  selectedText = '',
  hiddenNotePath = ''
} = {}) {
  const payload = { path: notePath, selectedText: selectedText || '' };
  const selection = selectedText.trim();

  if (selection) {
    const chars = selection.length;
    const excerpt =
      selection.length > EXCERPT_CHARS
        ? `${selection.slice(0, EXCERPT_CHARS)}…`
        : selection;
    return {
      kind: 'selection',
      payload,
      summary: `Selection · ${plural(chars, 'char')}`,
      source: notePath ? basename(notePath) : '',
      details: [
        notePath
          ? `Only the selected text from ${notePath} is sent, not the rest of the note.`
          : 'Only the selected text is sent.'
      ],
      excerpt
    };
  }

  if (notePath) {
    const details = [];
    if (!noteLength) {
      details.push(`${notePath} is empty, so only its path is sent.`);
    } else if (noteLength > MAX_NOTE_CONTEXT_CHARS) {
      details.push(
        `The first ${count(MAX_NOTE_CONTEXT_CHARS)} of ${plural(noteLength, 'character')} of ${notePath} are sent.`
      );
    } else {
      details.push(
        `All of ${notePath} is sent (${plural(noteLength, 'character')}).`
      );
    }
    if (unsaved) {
      details.push(
        'The AI reads the saved copy; edits still syncing are not included.'
      );
    }
    return {
      kind: 'note',
      payload,
      summary: `Note · ${basename(notePath)}`,
      source: basename(notePath),
      details,
      excerpt: ''
    };
  }

  return {
    kind: 'none',
    payload,
    summary: 'No note context',
    source: '',
    details: [
      hiddenNotePath
        ? `Only your question is sent. ${hiddenNotePath} stays out while it is not on screen.`
        : 'Only your question is sent. Open a note or select text to add context.'
    ],
    excerpt: ''
  };
}
