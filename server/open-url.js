import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// A link the browser opens itself lands in the profile WebMD's own window
// belongs to. Asking Chrome over AppleScript puts it in a new tab of the
// frontmost ordinary window instead, whichever profile that is. The URL goes
// in as an argument, never into the script text.
const SCRIPT = `on run argv
  set theUrl to item 1 of argv
  tell application "Google Chrome"
    set targets to every window whose mode is "normal"
    if (count of targets) is 0 then
      make new window
      set URL of active tab of window 1 to theUrl
    else
      set theWindow to item 1 of targets
      tell theWindow to make new tab with properties {URL:theUrl}
      set index of theWindow to 1
    end if
    activate
  end tell
end run`;

export class OpenUrlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** `url` as an absolute http(s) URL, or an OpenUrlError. */
export function externalUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new OpenUrlError(400, 'Not a URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new OpenUrlError(400, 'Only http and https links open in Chrome.');
  return parsed.href;
}

/** Opens `url` in Chrome's most recently active window on this Mac. */
export async function openInChrome(url, { platform = process.platform } = {}) {
  if (platform !== 'darwin')
    throw new OpenUrlError(501, 'Opening links in Chrome needs macOS.');
  try {
    // A pending macOS automation prompt would otherwise hold the request.
    await execFileAsync('osascript', ['-e', SCRIPT, url], { timeout: 10000 });
  } catch (error) {
    throw new OpenUrlError(
      502,
      `Chrome did not open the link: ${String(error.stderr || error.message).trim()}`
    );
  }
}
