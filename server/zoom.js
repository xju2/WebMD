import { decodeHtml } from './indico.js';

/**
 * Zoom details an Indico event carries in the fields organizers type into:
 * its location, room, and description. Indico's Zoom plugin keeps its own
 * room out of the export API, so a link someone pasted is the only one there
 * is to find. Nothing is made up: no link, no Zoom.
 *
 *   { url, id, passcode, recording }
 *
 * `url` is a join link on a Zoom host, `id` the meeting number when one is
 * known, `passcode` one written out beside it, and `recording` a cloud
 * recording share link, which organizers often add after the meeting.
 */
export function findZoom(raw) {
  const fields = [
    raw?.location,
    raw?.roomFullname,
    raw?.room,
    raw?.address,
    raw?.description
  ].filter((value) => typeof value === 'string' && value.trim());

  let join = null;
  let recording = '';
  for (const field of fields) {
    for (const candidate of fieldUrls(field)) {
      const link = zoomLink(candidate);
      if (!link) continue;
      if (link.kind === 'recording') recording ||= link.url;
      else join ||= link;
    }
  }

  const text = fields.map(plainText).join('\n');
  const mentionsZoom = /\bzoom\b/i.test(text);
  const id = join?.id || (mentionsZoom ? writtenMeetingId(text) : '');
  const url = join?.url || (id ? `https://zoom.us/j/${id}` : '');
  if (!url && !recording) return null;
  return {
    url,
    id,
    passcode: url ? writtenPasscode(text) : '',
    recording
  };
}

/** Every URL in a field: the targets of its links first, then bare ones. */
function fieldUrls(field) {
  const urls = [];
  for (const match of field.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    urls.push(decodeHtml(match[2]));
  }
  for (const match of plainText(field).matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    urls.push(match[0].replace(/[.,;:!?]+$/, ''));
  }
  return urls;
}

function plainText(field) {
  return decodeHtml(field.replace(/<[^>]+>/g, ' '));
}

const ZOOM_HOST = /^(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)$/i;

/**
 * `{ kind, url, id }` for a Zoom join or recording link, or null. The join
 * link keeps only its embedded passcode (`pwd`), never tracking parameters or
 * a display name someone's browser added.
 */
export function zoomLink(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !ZOOM_HOST.test(url.hostname)) return null;

  if (/^\/rec\/(?:share|play)\/[\w.-]+/.test(url.pathname)) {
    url.hash = '';
    return { kind: 'recording', url: url.href, id: '' };
  }

  const numbered = /^\/(?:j|w|s|wc\/join)\/(\d{9,12})\/?$/.exec(url.pathname);
  const personal = /^\/my\/[\w.-]+\/?$/.test(url.pathname);
  if (!numbered && !personal) return null;
  const pwd = url.searchParams.get('pwd');
  const clean = new URL(`${url.origin}${url.pathname}`);
  if (pwd && /^[\w.-]+$/.test(pwd)) clean.searchParams.set('pwd', pwd);
  return { kind: 'join', url: clean.href, id: numbered ? numbered[1] : '' };
}

/** "Meeting ID: 123 4567 8901", however it was spaced. */
function writtenMeetingId(text) {
  const match = /meeting\s*(?:id|number)\s*[:#]?\s*((?:\d[\s-]?){9,12})/i.exec(text);
  if (!match) return '';
  const digits = match[1].replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 12 ? digits : '';
}

function writtenPasscode(text) {
  const match =
    /\b(?:passcode|password|meeting\s+password)\s*[:=]\s*([^\s,;<>]{3,32})/i.exec(text);
  return match ? match[1].replace(/[.)]+$/, '') : '';
}

/**
 * The Zoom room Indico's own Zoom plugin shows on an event page, which the
 * export API leaves out. Anonymous visitors of a public event see its meeting
 * ID and bare URL; a signed-in visitor also gets the join link with its
 * passcode, which is preferred. Only the first room (the event's own) is read.
 */
export function pageZoom(html) {
  if (typeof html !== 'string') return null;
  const at = html.indexOf('vc-room-list');
  if (at === -1) return null;
  const block = html.slice(at, at + 40000);
  const segment = block.split(/<ind-vc-room-segment\b/i)[1] ?? block;
  if (!/vc_zoom|zoom/i.test(segment)) return null;

  const links = [...segment.matchAll(/\b(?:href|value)\s*=\s*(["'])(.*?)\1/gi)]
    .map((match) => zoomLink(decodeHtml(match[2])))
    .filter((link) => link?.kind === 'join');
  const join = links.find((link) => /[?&]pwd=/.test(link.url)) || links[0];
  const idText = /Zoom\s+Meeting\s+ID\s*<\/div>\s*([\d\s-]{9,20})/i.exec(segment)?.[1];
  const id = join?.id || (idText ? idText.replace(/\D/g, '') : '');
  if (!join && !/^\d{9,12}$/.test(id)) return null;
  const passcode =
    /(?:Passcode|Password)\s*<\/div>\s*([^<\s]{3,32})/i.exec(segment)?.[1] || '';
  return {
    url: join?.url || `https://zoom.us/j/${id}`,
    id,
    passcode: decodeHtml(passcode),
    recording: ''
  };
}

/**
 * The event's own Zoom from its page, when there is one, with anything only
 * the description had (a recording link, a passcode written out) kept.
 */
export function mergeZoom(fromExport, fromPage) {
  if (!fromPage) return fromExport;
  return {
    url: fromPage.url,
    id: fromPage.id,
    passcode: fromPage.passcode || (fromExport?.id === fromPage.id ? fromExport.passcode : ''),
    recording: fromExport?.recording || ''
  };
}
