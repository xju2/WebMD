// Web links on the Mac go to the Chrome window used last. Left to the
// browser, a new-tab link opens in the profile WebMD's own window belongs
// to, which is often not the one the user is signed in with (Indico, Zoom).
// The server asks Chrome directly; anywhere else, or if that fails, the link
// opens the ordinary way.

let unavailable = false;

/** True on a desktop Mac, the machine the server runs on. iPads say Macintosh too, but have touch. */
export function onDesktopMac(nav = globalThis.navigator) {
  return /Macintosh/.test(nav?.userAgent || '') && !(nav?.maxTouchPoints > 0);
}

/** The http(s) URL a click should hand to Chrome, or '' to let the browser handle it. */
export function chromeLinkFor(event, here = globalThis.location) {
  if (event.defaultPrevented || event.button !== 0) return '';
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return '';
  const anchor = event.target?.closest?.('a[href]');
  if (!anchor || anchor.target !== '_blank' || anchor.hasAttribute('download')) return '';
  let url;
  try {
    url = new URL(anchor.href, here.href);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.origin === here.origin ? '' : url.href;
}

/** Opens `url` in Chrome's last active window; false when it could not. */
export async function openInChrome(url) {
  if (unavailable || !onDesktopMac()) return false;
  try {
    const response = await fetch('/api/open-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (response.ok) return true;
  } catch {
    // Fall through: the server is away or Chrome said no.
  }
  // Don't make every later click wait on a route that does not work here.
  unavailable = true;
  return false;
}

/** Opens a web link in Chrome's last active window, else in a new tab. */
export async function openWebLink(url) {
  if (!(await openInChrome(url))) window.open(url, '_blank', 'noopener,noreferrer');
}

/** Document click listener: sends new-tab web links to Chrome on the Mac. */
export function interceptWebLinks(event) {
  if (unavailable || !onDesktopMac()) return;
  const url = chromeLinkFor(event);
  if (!url) return;
  event.preventDefault();
  openWebLink(url);
}
