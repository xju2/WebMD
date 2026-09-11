// Turns the editor's raw status and pending-work flags into what the file
// sidebar says about saving. "Saved" is only ever claimed for an open note with
// nothing left to write; anything in flight or failed says so instead.

/**
 * @param {object} input
 * @param {string} input.status  the raw editor status, e.g. "[Syncing...]"
 * @param {boolean} input.hasNote a Markdown note is open for editing
 * @param {boolean} input.unsaved edits exist that the server has not confirmed
 * @returns {{ tone: 'ok'|'pending'|'error'|'neutral', label: string }}
 */
export function saveStatusView({
  status = '',
  hasNote = false,
  unsaved = false
}) {
  if (/offline/i.test(status)) {
    return { tone: 'error', label: 'Offline · edits kept, retrying' };
  }
  if (/read-only/i.test(status))
    return { tone: 'neutral', label: 'Read-only file' };
  if (/syncing/i.test(status) || (hasNote && unsaved)) {
    return { tone: 'pending', label: 'Saving…' };
  }
  const busy = /^\[(.+?)\.{3}\]$/.exec(status);
  if (busy) return { tone: 'pending', label: `${busy[1]}…` };
  if (!hasNote) return { tone: 'neutral', label: 'No note open' };
  if (/saved/i.test(status)) return { tone: 'ok', label: 'All changes saved' };
  return { tone: 'neutral', label: status.replace(/^\[|\]$/g, '') };
}
