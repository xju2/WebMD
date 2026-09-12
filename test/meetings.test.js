import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { indicoSites } from '../server/indico.js';
import {
  htmlToText,
  indicoTime,
  eventPageZoom,
  fetchMeeting,
  listMeetings,
  meetingNoteMarkdown,
  noteMeetingKey,
  normalizeEvent,
  parseMeetingSource,
  resetMeetingsCache
} from '../server/meetings.js';
import { findZoom, mergeZoom, pageZoom, zoomLink } from '../server/zoom.js';
import { parseFrontmatter } from '../src/frontmatter.js';

const CERN = 'https://indico.cern.ch';
const TOKEN = 'indp_TEST_TOKEN_never_leaves_the_server';
const NOW = Date.parse('2026-09-11T08:00:00Z');

test.beforeEach(() => resetMeetingsCache());

function when(date, time, tz = 'Europe/Zurich') {
  return { date, time: `${time}:00`, tz };
}

function rawEvent(id, title, start, end, extra = {}) {
  return {
    _type: 'Conference',
    id: String(id),
    title,
    startDate: when(...start),
    endDate: when(...end),
    timezone: 'Europe/Zurich',
    url: `${CERN}/event/${id}/`,
    location: '',
    room: '',
    roomFullname: '',
    address: '',
    description: '',
    type: 'meeting',
    category: 'Weekly',
    hasAnyProtection: false,
    ...extra
  };
}

const WEEKLY = rawEvent(
  101,
  'Tracking &amp; ML weekly',
  ['2026-09-11', '15:00'],
  ['2026-09-11', '16:00'],
  {
    roomFullname: '40/S2-C01',
    location: 'CERN',
    description: '<p>Agenda &amp; minutes</p><p>Zoom link in the <b>timetable</b></p>',
    hasAnyProtection: true,
    contributions: [
      {
        db_id: 9002,
        title: 'Second talk',
        startDate: when('2026-09-11', '15:30'),
        endDate: when('2026-09-11', '15:50'),
        duration: 20,
        speakers: [{ first_name: 'Ada', last_name: 'Lovelace' }],
        session: null,
        url: `${CERN}/event/101/contributions/9002/`
      },
      {
        db_id: 9001,
        title: 'First talk',
        startDate: when('2026-09-11', '15:05'),
        endDate: when('2026-09-11', '15:25'),
        duration: 20,
        speakers: [{ fullName: 'Hopper, Grace' }],
        session: 'Tracking',
        // A link that points away from the Indico is not passed on.
        url: 'https://elsewhere.example/talk'
      },
      { db_id: 9003, title: 'Unscheduled talk', startDate: null, speakers: [] }
    ]
  }
);
const WORKSHOP = rawEvent(
  202,
  'Detector workshop',
  ['2026-09-14', '09:00'],
  ['2026-09-16', '18:00']
);
const PUBLIC_SEMINAR = rawEvent(
  303,
  'Public seminar',
  ['2026-09-12', '11:00'],
  ['2026-09-12', '12:00'],
  {
    description:
      '<p>Join on <a href="https://cern.zoom.us/j/98765432101?pwd=AbC.1&amp;uname=Someone#success">Zoom</a></p><p>Passcode: 424242.</p>'
  }
);
const FINISHED = rawEvent(
  404,
  'Last week',
  ['2026-09-01', '10:00'],
  ['2026-09-01', '11:00']
);

/** A stand-in Indico: routes export URLs, records who asked with what. */
function fakeIndico({ protectedAuth = TOKEN, invalidToken = false } = {}) {
  const calls = [];
  const fetchImpl = async (target, options = {}) => {
    const url = new URL(target);
    const auth = options.headers?.Authorization || '';
    calls.push({ url: target, auth });
    if (url.origin !== CERN) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (invalidToken && auth) {
      return new Response('<h1>Bad Request</h1>invalid_token: expired', {
        status: 400
      });
    }
    const authed = auth === `Bearer ${protectedAuth}`;
    const json = (results) =>
      new Response(JSON.stringify({ count: results.length, results }), {
        status: 200
      });
    const strip = ({ contributions: _c, ...rest }) => rest;

    if (url.pathname === '/export/categ/10.json') {
      // A protected category: anonymous visitors see nothing, not an error.
      return json(authed ? [WEEKLY, WORKSHOP, FINISHED].map(strip) : []);
    }
    if (url.pathname === '/export/categ/20.json') {
      return json([PUBLIC_SEMINAR, WORKSHOP].map(strip));
    }
    if (url.pathname === '/export/event/101.json') {
      if (!authed) return json([]);
      return json([
        url.searchParams.get('detail') === 'contributions' ? WEEKLY : strip(WEEKLY)
      ]);
    }
    if (url.pathname === '/export/event/303.json') return json([PUBLIC_SEMINAR]);
    if (url.pathname === '/export/categ/99.json') {
      return new Response('boom', { status: 500, statusText: 'Server Error' });
    }
    return json([]);
  };
  return { calls, fetchImpl };
}

function source(url, extra = {}) {
  return { ...parseMeetingSource(url), label: url, enabled: true, ...extra };
}

/* ------------------------------------------------------------- sources */

test('reads category and event links, and any page of an event as the event', () => {
  assert.deepEqual(parseMeetingSource('https://indico.cern.ch/category/6725/'), {
    id: 'indico.cern.ch-category-6725',
    origin: CERN,
    kind: 'category',
    indicoId: '6725',
    url: `${CERN}/category/6725/`
  });
  assert.equal(
    parseMeetingSource(`${CERN}/event/1338689/contributions/6081535/?x=1#top`).url,
    `${CERN}/event/1338689/`
  );
  assert.equal(
    parseMeetingSource(`${CERN}/categoryDisplay.py?categId=42`).url,
    `${CERN}/category/42/`
  );
  assert.throws(() => parseMeetingSource(`${CERN}/news/`), /category link/);
  assert.throws(
    () => parseMeetingSource('http://indico.cern.ch/category/1/'),
    /https/
  );
  assert.throws(
    () => parseMeetingSource('https://user:pw@indico.cern.ch/category/1/'),
    /password/
  );
  assert.throws(
    () => parseMeetingSource('https://intranet.example/category/1/'),
    /not a known Indico/
  );
});

test('treats a configured installation with any hostname as an Indico', () => {
  const sites = indicoSites({ INDICO_LAB_URL: 'https://events.lab.example' });
  assert.equal(
    parseMeetingSource('https://events.lab.example/category/3/', sites).origin,
    'https://events.lab.example'
  );
});

/* ------------------------------------------------------- normalization */

test('keeps the event timezone and the absolute instant, daylight saving included', () => {
  const summer = indicoTime(when('2026-09-11', '15:00'));
  assert.equal(summer.iso, '2026-09-11T13:00:00.000Z');
  assert.equal(summer.tz, 'Europe/Zurich');
  assert.equal(summer.time, '15:00');
  const winter = indicoTime(when('2026-12-11', '15:00'));
  assert.equal(winter.iso, '2026-12-11T14:00:00.000Z');
  assert.equal(
    indicoTime({ date: '2026-03-08', time: '09:30:00', tz: 'America/Chicago' }).iso,
    '2026-03-08T14:30:00.000Z'
  );
  assert.equal(indicoTime(null), null);
  assert.equal(indicoTime({ date: 'soon' }), null);
});

test('normalizes an event into the application model without inventing fields', () => {
  const event = normalizeEvent(WEEKLY, CERN);
  assert.equal(event.key, `${CERN}/event/101/`);
  assert.equal(event.url, `${CERN}/event/101/`);
  assert.equal(event.title, 'Tracking & ML weekly');
  assert.equal(event.room, '40/S2-C01');
  assert.equal(event.location, 'CERN');
  assert.equal(event.address, '');
  assert.equal(event.description, 'Agenda & minutes\nZoom link in the timetable');
  assert.equal(event.protected, true);
  assert.equal(event.allDay, false);
  // It mentions Zoom but carries no link or number: no Zoom is made up.
  assert.equal(event.zoom, null);
  assert.equal(normalizeEvent({ id: 'x' }, CERN), null);
  assert.equal(normalizeEvent({ id: '5', title: 'No dates' }, CERN), null);
});

test('finds the Zoom join link organizers put in an event, and only Zoom', () => {
  assert.deepEqual(normalizeEvent(PUBLIC_SEMINAR, CERN).zoom, {
    // Only the embedded passcode survives; tracking and a stray name do not.
    url: 'https://cern.zoom.us/j/98765432101?pwd=AbC.1',
    id: '98765432101',
    passcode: '424242',
    recording: ''
  });
  // Typed into the location, as a bare link.
  assert.equal(
    findZoom({ location: 'Zoom: https://ucsc.zoom.us/my/lab-room' }).url,
    'https://ucsc.zoom.us/my/lab-room'
  );
  // Only a meeting number, written out.
  assert.deepEqual(
    findZoom({ description: 'Zoom meeting ID: 912 3456 7890, Password: xyz' }),
    { url: 'https://zoom.us/j/91234567890', id: '91234567890', passcode: 'xyz', recording: '' }
  );
  // A recording link added after the meeting.
  assert.equal(
    findZoom({ description: '<a href="https://cern.zoom.us/rec/share/Ab_c-1.xyz?startTime=1">Recording</a>' })
      .recording,
    'https://cern.zoom.us/rec/share/Ab_c-1.xyz?startTime=1'
  );
  for (const bad of [
    'http://cern.zoom.us/j/98765432101',
    'https://zoom.us.evil.example/j/98765432101',
    'https://evilzoom.us/j/98765432101',
    'https://cern.zoom.us/signin',
    'javascript:alert(1)'
  ]) {
    assert.equal(zoomLink(bad), null, bad);
  }
  assert.equal(findZoom({ description: 'Room 40/S2-C01, ID 12345678901' }), null);
});

// The shape of the Zoom plugin's block on a CERN event page, as an anonymous
// visitor sees it: the join button asks for a login, the details do not.
const VC_ROOM_ANONYMOUS = `
<div class="vc-room-list">
  <ind-vc-room-segment class="ui segment vc-room-segment">
    <div class="item vc-icon"><img src="/static/plugins/vc_zoom/images/zoom_logo.svg"></div>
    <ind-vc-zoom-join-button classes="orange " href="https://indico.cern.ch/login/?next=/event/101/"
      caption="Please log in"></ind-vc-zoom-join-button>
    <div class="ui list">
      <div class="item"><div class="header">Zoom Meeting ID</div>
        63934786609
      </div>
      <div class="item"><div class="header">Useful links</div>
        <a href="https://videoconference.docs.cern.ch/zoom-meetings/#phone">Join via phone</a></div>
      <div class="item"><div class="header">Zoom URL</div>
        <input name="vc-room-url-1188950" type="text" value="https://cern.zoom.us/j/63934786609" readonly>
      </div>
    </div>
  </ind-vc-room-segment>
</div>`;
const VC_ROOM_SIGNED_IN = VC_ROOM_ANONYMOUS.replace(
  'href="https://indico.cern.ch/login/?next=/event/101/"',
  'href="https://cern.zoom.us/j/63934786609?pwd=Sign.In&amp;from=addon"'
).replace('</ind-vc-room-segment>', '<div class="item"><div class="header">Passcode</div> 777111 </div></ind-vc-room-segment>');

test('reads the Zoom plugin room off an event page', () => {
  assert.deepEqual(pageZoom(`<html>${VC_ROOM_ANONYMOUS}</html>`), {
    url: 'https://cern.zoom.us/j/63934786609',
    id: '63934786609',
    passcode: '',
    recording: ''
  });
  assert.deepEqual(pageZoom(VC_ROOM_SIGNED_IN), {
    url: 'https://cern.zoom.us/j/63934786609?pwd=Sign.In',
    id: '63934786609',
    passcode: '777111',
    recording: ''
  });
  assert.equal(pageZoom('<html>no rooms</html>'), null);
  assert.equal(pageZoom('<div class="vc-room-list"><ind-vc-room-segment>Vidyo</ind-vc-room-segment></div>'), null);
  // The page's room wins; a recording only the description had is kept.
  assert.deepEqual(
    mergeZoom(
      { url: 'https://zoom.us/j/111111111', id: '111111111', passcode: 'x', recording: 'https://cern.zoom.us/rec/share/r' },
      pageZoom(VC_ROOM_ANONYMOUS)
    ),
    {
      url: 'https://cern.zoom.us/j/63934786609',
      id: '63934786609',
      passcode: '',
      recording: 'https://cern.zoom.us/rec/share/r'
    }
  );
});

test('reads the page with the token, else anonymously, and never fails the list for it', async () => {
  const calls = [];
  const fetchImpl = async (target, options = {}) => {
    const auth = options.headers?.Authorization || '';
    calls.push({ url: target, auth });
    const url = new URL(target);
    if (url.pathname === '/export/event/101.json') {
      return new Response(JSON.stringify({ results: [WEEKLY] }));
    }
    if (url.pathname === '/event/101/') {
      // A read:legacy_api token is turned away from HTML views.
      if (auth) return new Response('Forbidden', { status: 403 });
      return new Response(`<html>${VC_ROOM_ANONYMOUS}</html>`);
    }
    if (url.pathname === '/export/categ/10.json') {
      return new Response(JSON.stringify({ results: [WEEKLY, WORKSHOP] }));
    }
    return new Response('boom', { status: 500 });
  };
  const sites = indicoSites({ INDICO_CERN_TOKEN: TOKEN });

  const meeting = await fetchMeeting(CERN, '101', { sites, fetchImpl });
  assert.equal(meeting.zoom.url, 'https://cern.zoom.us/j/63934786609');
  assert.deepEqual(
    calls.filter((call) => call.url.endsWith('/event/101/')).map((call) => Boolean(call.auth)),
    [true, false]
  );

  // The list reads pages only for meetings in the next day: today's weekly,
  // not next week's workshop, whose page fails without failing anything.
  resetMeetingsCache();
  calls.length = 0;
  const listing = await listMeetings([source(`${CERN}/category/10/`)], {
    sites,
    fetchImpl,
    now: () => NOW
  });
  assert.equal(listing.meetings.find((item) => item.eventId === '101').zoom.id, '63934786609');
  assert.equal(listing.meetings.find((item) => item.eventId === '202').zoom, null);
  assert.ok(!calls.some((call) => call.url.endsWith('/event/202/')));
  assert.equal(await eventPageZoom(CERN, '999', { sites: new Map(), fetchImpl }), null);
});

test('re-reads times listed in the server zone in the event zone', () => {
  // As CERN lists a Tokyo workshop: dates in Europe/Zurich, the event in Asia/Tokyo.
  const event = normalizeEvent(
    {
      ...rawEvent(8, 'PIXEL', ['2026-09-07', '02:00'], ['2026-09-12', '10:00']),
      timezone: 'Asia/Tokyo'
    },
    CERN
  );
  assert.equal(event.timezone, 'Asia/Tokyo');
  assert.deepEqual(
    [event.start.date, event.start.time, event.start.tz, event.start.iso],
    ['2026-09-07', '09:00', 'Asia/Tokyo', '2026-09-07T00:00:00.000Z']
  );
  assert.equal(event.end.time, '17:00');
});

test('marks a midnight-to-midnight day as all day', () => {
  const event = normalizeEvent(
    rawEvent(7, 'Holiday', ['2026-09-20', '00:00'], ['2026-09-20', '23:59']),
    CERN
  );
  assert.equal(event.allDay, true);
});

test('turns a description into text, never markup', () => {
  assert.equal(
    htmlToText('<script>alert(1)</script><p>One<br>Two</p><ul><li>Three</li></ul>'),
    'One\nTwo\n- Three'
  );
  assert.equal(htmlToText(null), '');
});

/* ------------------------------------------------------------- listing */

test('merges sources, drops finished meetings, sorts by start, dedupes by event', async () => {
  const { fetchImpl } = fakeIndico();
  const listing = await listMeetings(
    [source(`${CERN}/category/10/`), source(`${CERN}/category/20/`)],
    { sites: indicoSites({ INDICO_CERN_TOKEN: TOKEN }), fetchImpl, now: () => NOW }
  );

  assert.deepEqual(
    listing.meetings.map((meeting) => meeting.title),
    ['Tracking & ML weekly', 'Public seminar', 'Detector workshop']
  );
  const workshop = listing.meetings.find((meeting) => meeting.eventId === '202');
  assert.deepEqual(workshop.sources, [
    'indico.cern.ch-category-10',
    'indico.cern.ch-category-20'
  ]);
  assert.deepEqual(
    listing.statuses.map(({ id, state, count }) => [id, state, count]),
    [
      ['indico.cern.ch-category-10', 'ok', 2],
      ['indico.cern.ch-category-20', 'ok', 2]
    ]
  );
});

test('asks for a bounded window and insists on a login when it has a token', async () => {
  const { calls, fetchImpl } = fakeIndico();
  await listMeetings([source(`${CERN}/category/10/`)], {
    sites: indicoSites({ INDICO_CERN_TOKEN: TOKEN }),
    fetchImpl,
    now: () => NOW
  });
  const url = new URL(calls[0].url);
  // The past week too, so a meeting stays listed until its recording is in.
  assert.equal(url.searchParams.get('from'), '2026-09-03');
  assert.equal(url.searchParams.get('to'), '2026-09-26');
  assert.equal(url.searchParams.get('oa'), 'yes');
  assert.equal(url.searchParams.get('limit'), '200');
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
});

test('public meetings work without a token, and a protected source says what to set', async () => {
  const { calls, fetchImpl } = fakeIndico();
  const listing = await listMeetings(
    [source(`${CERN}/category/10/`), source(`${CERN}/event/303/`)],
    { sites: indicoSites({}), fetchImpl, now: () => NOW }
  );
  assert.deepEqual(
    listing.meetings.map((meeting) => meeting.title),
    ['Public seminar']
  );
  const hint = listing.statuses.find((status) => status.id.endsWith('category-10'));
  assert.equal(hint.state, 'empty');
  assert.equal(hint.kind, 'maybe_protected');
  assert.match(hint.message, /INDICO_CERN_TOKEN/);
  assert.ok(calls.every((call) => call.auth === ''));
  assert.ok(calls.every((call) => !new URL(call.url).searchParams.has('oa')));
});

test('an expired token is an authentication error, separate from other sources', async () => {
  const { fetchImpl } = fakeIndico({ invalidToken: true });
  const listing = await listMeetings(
    [source(`${CERN}/category/10/`), source(`${CERN}/category/99/`)],
    { sites: indicoSites({ INDICO_CERN_TOKEN: TOKEN }), fetchImpl, now: () => NOW }
  );
  const [auth, failed] = listing.statuses;
  assert.equal(auth.state, 'error');
  assert.equal(auth.kind, 'auth');
  assert.match(auth.message, /rejected INDICO_CERN_TOKEN/);
  assert.ok(!JSON.stringify(listing).includes(TOKEN));
  assert.equal(failed.kind, 'auth');
});

test('one broken source does not take the others down', async () => {
  const { fetchImpl } = fakeIndico();
  const listing = await listMeetings(
    [source(`${CERN}/category/99/`), source(`${CERN}/category/20/`)],
    { fetchImpl, now: () => NOW }
  );
  assert.equal(listing.statuses[0].kind, 'upstream');
  assert.match(listing.statuses[0].message, /500/);
  assert.equal(listing.meetings.length, 2);
});

test('skips disabled sources', async () => {
  const { calls, fetchImpl } = fakeIndico();
  const listing = await listMeetings(
    [source(`${CERN}/category/20/`, { enabled: false })],
    { fetchImpl, now: () => NOW }
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(listing.meetings, []);
});

test('caches a listing, shares one request, and refetches on refresh', async () => {
  const { calls, fetchImpl } = fakeIndico();
  const sources = [source(`${CERN}/category/20/`)];
  await Promise.all([
    listMeetings(sources, { fetchImpl, now: () => NOW }),
    listMeetings(sources, { fetchImpl, now: () => NOW })
  ]);
  await listMeetings(sources, { fetchImpl, now: () => NOW });
  assert.equal(calls.length, 1);
  await listMeetings(sources, { fetchImpl, now: () => NOW, refresh: true });
  assert.equal(calls.length, 2);
});

/* ---------------------------------------------------------------- notes */

test('writes a readable meeting note with a stable association', () => {
  const meeting = {
    ...normalizeEvent(WEEKLY, CERN),
    agenda: [
      {
        title: 'First [draft] talk',
        start: { date: '2026-09-11', time: '15:05' },
        speakers: ['Grace Hopper'],
        url: `${CERN}/event/101/contributions/9001/`
      },
      {
        title: 'Coffee',
        start: { date: '2026-09-12', time: '10:00' },
        speakers: []
      }
    ]
  };
  const markdown = meetingNoteMarkdown(meeting);
  const { attributes, body } = parseFrontmatter(markdown);
  assert.equal(attributes.indico, `${CERN}/event/101/`);
  assert.equal(attributes.type, 'meeting');
  assert.equal(attributes.date, '2026-09-11');
  assert.match(body, /^# Tracking & ML weekly \(2026-09-11\)$/m);
  assert.match(body, /\*\*When:\*\* 2026-09-11 15:00 – 16:00 \(Europe\/Zurich\)/);
  assert.match(body, /\*\*Indico:\*\* <https:\/\/indico\.cern\.ch\/event\/101\/>/);
  assert.match(body, /\*\*Where:\*\* 40\/S2-C01, CERN/);
  assert.match(
    body,
    /- 15:05 \[First \\\[draft\\\] talk\]\(https:\/\/indico\.cern\.ch\/event\/101\/contributions\/9001\/\) — Grace Hopper/
  );
  assert.match(body, /- 2026-09-12 10:00 Coffee$/m);
  assert.match(body, /## Notes\n/);
  assert.match(body, /## Action items\n/);
  assert.doesNotMatch(body, /Zoom:/);
  assert.match(
    meetingNoteMarkdown({ ...normalizeEvent(PUBLIC_SEMINAR, CERN), agenda: [] }),
    /- \*\*Zoom:\*\* <https:\/\/cern\.zoom\.us\/j\/98765432101\?pwd=AbC\.1> \(passcode 424242\)/
  );
  // No blank checkbox that the Tasks view would count as an empty task.
  assert.doesNotMatch(body, /- \[ \]/);
});

test('finds a meeting from however its note spells the link', () => {
  assert.equal(noteMeetingKey('https://indico.cern.ch/event/101'), `${CERN}/event/101/`);
  assert.equal(
    noteMeetingKey(' https://indico.cern.ch/event/101/timetable/ '),
    `${CERN}/event/101/`
  );
  assert.equal(noteMeetingKey('http://indico.cern.ch/event/101/'), '');
  assert.equal(noteMeetingKey('not a link'), '');
  assert.equal(noteMeetingKey(undefined), '');
});

/* ------------------------------------------------------------------ API */

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-meetings-'));
}

async function startApp({ roots, env = { INDICO_CERN_TOKEN: TOKEN }, indico = fakeIndico() } = {}) {
  const workspaceRoots = roots || [await tempRoot(), await tempRoot()];
  const app = await createApp({ workspaceRoots, indicoFetch: indico.fetchImpl, env });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    // Whatever the route, the token never reaches the browser.
    assert.ok(!text.includes(TOKEN), `${route} leaked the token`);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { server, call, roots: workspaceRoots, indico };
}

test('adds and removes sources per workspace, reporting only whether a token is set', async (t) => {
  const { server, call, roots } = await startApp();
  t.after(() => server.close());

  const added = await call('POST', '/api/meetings/sources', {
    root: '0',
    url: 'https://indico.cern.ch/category/10/overview?period=week',
    label: '  Tracking   meetings '
  });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.sources, [
    {
      id: 'indico.cern.ch-category-10',
      label: 'Tracking meetings',
      origin: CERN,
      url: `${CERN}/category/10/`,
      kind: 'category',
      enabled: true,
      configured: true,
      tokenVariable: 'INDICO_CERN_TOKEN'
    }
  ]);
  const saved = JSON.parse(
    await fs.readFile(path.join(roots[0], '.webmd/meetings.json'), 'utf8')
  );
  assert.equal(saved.version, 1);
  assert.equal(saved.noteFolder, '/meetings');
  assert.equal(saved.sources[0].url, `${CERN}/category/10/`);
  assert.ok(!JSON.stringify(saved).includes('indp_'));

  const duplicate = await call('POST', '/api/meetings/sources', {
    root: '0',
    url: `${CERN}/category/10/`
  });
  assert.equal(duplicate.status, 409);
  const bad = await call('POST', '/api/meetings/sources', {
    root: '0',
    url: 'https://intranet.example/category/1/'
  });
  assert.equal(bad.status, 400);
  // A lookalike Indico may be listed anonymously, but it never counts as
  // having the CERN token.
  const lookalike = await call('POST', '/api/meetings/sources', {
    root: '0',
    url: 'https://indico.cern.example/category/1/'
  });
  assert.equal(lookalike.body.sources[1].configured, false);
  await call('DELETE', '/api/meetings/sources', {
    root: '0',
    id: 'indico.cern.example-category-1'
  });

  // The other root has its own, empty list, and looking does not create .webmd.
  assert.deepEqual((await call('GET', '/api/meetings?root=1')).body.sources, []);
  await assert.rejects(() => fs.access(path.join(roots[1], '.webmd')));

  const removed = await call('DELETE', '/api/meetings/sources', {
    root: '0',
    id: 'indico.cern.ch-category-10'
  });
  assert.deepEqual(removed.body.sources, []);
});

test('skips a malformed source with a warning and keeps it on the next write', async (t) => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd/meetings.json'),
    JSON.stringify({
      version: 1,
      sources: [
        { label: 'Typo', url: 'htps://indico.cern.ch/category/1/' },
        { label: 'Good', url: `${CERN}/category/20/` }
      ]
    })
  );
  const { server, call } = await startApp({ roots: [root] });
  t.after(() => server.close());

  const listing = await call('GET', '/api/meetings?root=0');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.sources.map((item) => item.label), ['Good']);
  assert.match(listing.body.warnings[0], /Source 1 \(Typo\).*skipped/);
  assert.equal(listing.body.meetings.length, 2);

  await call('POST', '/api/meetings/sources', { root: '0', url: `${CERN}/event/303/` });
  const saved = JSON.parse(await fs.readFile(path.join(root, '.webmd/meetings.json'), 'utf8'));
  assert.equal(saved.sources.length, 3);
  assert.equal(saved.sources[0].url, 'htps://indico.cern.ch/category/1/');
});

test('refuses to overwrite a meetings file that does not parse', async (t) => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(path.join(root, '.webmd/meetings.json'), '{ nope');
  const { server, call } = await startApp({ roots: [root] });
  t.after(() => server.close());

  const listing = await call('GET', '/api/meetings?root=0');
  assert.match(listing.body.warnings[0], /not valid JSON/);
  const add = await call('POST', '/api/meetings/sources', {
    root: '0',
    url: `${CERN}/category/20/`
  });
  assert.equal(add.status, 409);
  assert.equal(await fs.readFile(path.join(root, '.webmd/meetings.json'), 'utf8'), '{ nope');
});

test('shows a protected meeting with its agenda to a valid token', async (t) => {
  const { server, call } = await startApp();
  t.after(() => server.close());

  const event = await call('GET', `/api/meetings/event?root=0&origin=${encodeURIComponent(CERN)}&id=101`);
  assert.equal(event.status, 200);
  assert.equal(event.body.title, 'Tracking & ML weekly');
  assert.equal(event.body.notePath, '');
  assert.deepEqual(
    event.body.agenda.map((item) => [item.start.time, item.title, item.speakers, item.url]),
    [
      ['15:05', 'First talk', ['Grace Hopper'], undefined],
      ['15:30', 'Second talk', ['Ada Lovelace'], `${CERN}/event/101/contributions/9002/`]
    ]
  );
  assert.equal(event.body.unscheduled, 1);
  assert.equal(event.body.agenda[0].session, 'Tracking');
});

test('without a token a protected event says which variable to set', async (t) => {
  const { server, call } = await startApp({ env: {} });
  t.after(() => server.close());

  const event = await call('GET', `/api/meetings/event?root=0&origin=${encodeURIComponent(CERN)}&id=101`);
  assert.equal(event.status, 404);
  assert.equal(event.body.kind, 'config');
  assert.match(event.body.error, /set INDICO_CERN_TOKEN/);
});

test('rejects an event lookup on an origin that is not an Indico', async (t) => {
  const { server, call, indico } = await startApp();
  t.after(() => server.close());

  const response = await call(
    'GET',
    `/api/meetings/event?root=0&origin=${encodeURIComponent('https://169.254.169.254')}&id=1`
  );
  assert.equal(response.status, 400);
  assert.equal(indico.calls.length, 0);
});

test('creates a meeting note once, then opens it again whatever became of it', async (t) => {
  const { server, call, roots } = await startApp();
  t.after(() => server.close());
  const request = { root: '0', origin: CERN, id: '101' };

  const [first, concurrent] = await Promise.all([
    call('POST', '/api/meetings/note', request),
    call('POST', '/api/meetings/note', request)
  ]);
  assert.equal(first.status, 200);
  assert.equal(first.body.path, '/meetings/Tracking & ML weekly (2026-09-11).md');
  assert.equal(concurrent.body.path, first.body.path);
  assert.equal([first.body.created, concurrent.body.created].filter(Boolean).length, 1);

  const file = path.join(roots[0], first.body.path);
  const written = await fs.readFile(file, 'utf8');
  assert.equal(parseFrontmatter(written).attributes.indico, `${CERN}/event/101/`);
  assert.match(written, /- 15:05 First talk — Grace Hopper/);

  // The user writes in it and retitles it; the association survives both.
  const edited = written.replace('# Tracking & ML weekly (2026-09-11)', '# Tracking sync') +
    '\nMy own notes.\n';
  const renamed = path.join(roots[0], 'meetings/Tracking sync.md');
  await fs.writeFile(file, edited);
  await fs.rename(file, renamed);

  const again = await call('POST', '/api/meetings/note', request);
  assert.deepEqual(again.body, { path: '/meetings/Tracking sync.md', created: false });
  assert.equal(await fs.readFile(renamed, 'utf8'), edited);

  const listing = await call('GET', `/api/meetings/event?root=0&origin=${encodeURIComponent(CERN)}&id=101`);
  assert.equal(listing.body.notePath, '/meetings/Tracking sync.md');

  // The other workspace keeps its own notes.
  const other = await call('POST', '/api/meetings/note', { ...request, root: '1' });
  assert.equal(other.body.created, true);
  assert.ok(other.body.path.startsWith('/meetings/'));
  await fs.access(path.join(roots[1], other.body.path));
});

test('never overwrites a different note that already has the name', async (t) => {
  const root = await tempRoot();
  const taken = path.join(root, 'meetings/Tracking & ML weekly (2026-09-11).md');
  await fs.mkdir(path.dirname(taken), { recursive: true });
  await fs.writeFile(taken, '# Someone else\n');
  const { server, call } = await startApp({ roots: [root] });
  t.after(() => server.close());

  const created = await call('POST', '/api/meetings/note', { root: '0', origin: CERN, id: '101' });
  assert.equal(created.status, 200);
  assert.equal(
    created.body.path,
    '/meetings/Tracking & ML weekly (2026-09-11, event 101).md'
  );
  assert.equal(await fs.readFile(taken, 'utf8'), '# Someone else\n');
  const note = await fs.readFile(path.join(root, created.body.path), 'utf8');
  // Heading and file name agree, so a save does not rename it back.
  assert.match(note, /^# Tracking & ML weekly \(2026-09-11, event 101\)$/m);
});

test('keeps meeting notes inside the workspace whatever noteFolder says', async (t) => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd/meetings.json'),
    JSON.stringify({ version: 1, noteFolder: '../../outside', sources: [] })
  );
  const { server, call } = await startApp({ roots: [root] });
  t.after(() => server.close());

  const created = await call('POST', '/api/meetings/note', { root: '0', origin: CERN, id: '303' });
  assert.equal(created.status, 200);
  const resolved = path.resolve(root, `.${created.body.path}`);
  assert.ok(resolved.startsWith(`${await fs.realpath(root)}${path.sep}`) || resolved.startsWith(`${root}${path.sep}`));
  await fs.access(resolved);
});
