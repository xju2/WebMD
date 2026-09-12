// Meetings acceptance scenarios against the fixture's canned Indico (see
// scripts/fixture.mjs): no network, and only a placeholder token. Needs a
// build first:
//
//   npm run build && npm run scenarios:meetings
//
// Screenshots land in OUT_DIR (a temp directory by default).
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  check,
  finish,
  launchChrome,
  sleep,
  startFixture
} from './browser-harness.mjs';

const PLACEHOLDER_TOKEN = 'fixture-placeholder-token';
const DESTINATIONS = [
  'Open dashboard',
  'Open today’s note',
  'Open daily notes calendar',
  'Open tasks',
  'Open arXiv news',
  'Open meetings'
];

const main = await startFixture(3201, {});
const auth = await startFixture(3202, { MEETINGS_MODE: 'auth' });
const noToken = await startFixture(3203, { MEETINGS_MODE: 'notoken' });
const empty = await startFixture(3204, { MEETINGS_MODE: 'none' });
const offline = await startFixture(3205, { MEETINGS_MODE: 'offline' });
const zoom = await startFixture(3206, { MEETINGS_MODE: 'zoom' });
const { child: chrome, page, profile } = await launchChrome();

const EDITOR = `document.querySelector('.cm-content')?.cmTile?.view`;

const snapshot = () =>
  page.eval(`
    const view = ${EDITOR};
    const rect = (id) => {
      const el = document.getElementById(id);
      if (!el || !el.getClientRects().length) return null;
      return Math.round(el.getBoundingClientRect().width);
    };
    const pane = document.querySelector('.meetings-pane');
    return {
      active: ${JSON.stringify(DESTINATIONS)}.filter((label) =>
        document.querySelector('.global-bar [aria-label="' + label + '"]')?.classList.contains('active')),
      meetingsVisible: Boolean(pane && !pane.hidden && pane.getClientRects().length),
      layout: document.querySelector('.meetings-body')?.dataset.layout || '',
      listVisible: Boolean(document.querySelector('.meetings-list:not([hidden])')),
      detailVisible: Boolean(document.querySelector('.meetings-detail:not([hidden])')),
      sections: [...document.querySelectorAll('.meetings-section')].map((el) => el.firstChild.textContent.trim()),
      items: [...document.querySelectorAll('.meetings-item-title')].map((el) => el.textContent.trim()),
      selected: document.querySelector('.meetings-item[aria-current="true"] .meetings-item-title')?.textContent.trim() || '',
      heading: document.querySelector('.meetings-detail h3')?.textContent.trim() || '',
      agenda: document.querySelectorAll('.meetings-agenda li').length,
      noteButton: [...document.querySelectorAll('.meetings-actions button')].map((el) => el.textContent.trim()).join('|'),
      indicoLink: document.querySelector('.meetings-open-indico')?.getAttribute('href') || '',
      indicoTarget: document.querySelector('.meetings-open-indico')?.getAttribute('target') || '',
      notices: [...document.querySelectorAll('.meetings-notice')].map((el) => ({ kind: el.dataset.kind || '', tone: el.classList.contains('error') ? 'error' : 'hint', text: el.textContent.replace(/\\s+/g, ' ').trim() })),
      focus: document.activeElement?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) || '',
      focusTag: document.activeElement?.tagName || '',
      doc: view ? view.state.doc.toString() : '',
      path: document.querySelector('.current-file')?.textContent.trim() || '',
      files: rect('files-panel'),
      ai: rect('ai-panel'),
      overflow: document.documentElement.scrollWidth - innerWidth,
      leaked: document.documentElement.outerHTML.includes(${JSON.stringify(PLACEHOLDER_TOKEN)}) ||
        JSON.stringify({ ...localStorage }).includes(${JSON.stringify(PLACEHOLDER_TOKEN)}) ||
        JSON.stringify({ ...sessionStorage }).includes(${JSON.stringify(PLACEHOLDER_TOKEN)})
    };`);

// A fresh page load each time: the view deliberately keeps its selection
// across same-page navigation, which a scenario must not inherit.
async function openMeetings(url, { reset = false } = {}) {
  await page.goto(`${url}/#/README.md`);
  if (reset) await page.eval(`localStorage.clear(); sessionStorage.clear();`);
  await page.reload();
  await page.click('.global-bar [aria-label="Open meetings"]');
  await page.waitFor(
    `document.querySelector('.meetings-item, .meetings-empty, .meetings-notice.error')`
  );
  await sleep(200);
}

async function chooseMeeting(title) {
  await page.eval(`
    const button = [...document.querySelectorAll('.meetings-item')]
      .find((el) => el.textContent.includes(${JSON.stringify(title)}));
    button.click();`);
  await page.waitFor(
    `document.querySelector('.meetings-agenda, .meetings-detail .preview-empty:not(.meetings-pick), .meetings-detail .meetings-notice')`
  );
  await sleep(150);
}

async function clickText(selector, text) {
  await page.eval(`
    [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((el) => el.textContent.includes(${JSON.stringify(text)})).click();`);
  await sleep(200);
}

try {
  // 1. Desktop: list, one meeting, its agenda, and nothing secret on the page.
  await page.viewport(1440, 900);
  await openMeetings(main.url, { reset: true });
  let s = await snapshot();
  check(
    'Meetings is the one active destination on the rail',
    s.meetingsVisible && s.active.join() === 'Open meetings',
    s.active.join()
  );
  check(
    'upcoming meetings are grouped by local day and sorted',
    s.sections[0] === 'Today' &&
      s.items[0] === 'Tracking and reconstruction weekly' &&
      s.items.includes('Detector upgrade workshop'),
    `${s.sections.join(', ')} / ${s.items.join(' | ')}`
  );
  check('desktop shows list and detail side by side', s.layout === 'both', s.layout);
  check('file sidebar stays docked beside Meetings', s.files === 240, String(s.files));
  await page.shot('meetings-list-desktop');

  await chooseMeeting('Tracking and reconstruction weekly');
  s = await snapshot();
  check(
    'a protected meeting opens with its agenda',
    s.heading === 'Tracking and reconstruction weekly' && s.agenda === 4,
    `${s.heading} / ${s.agenda}`
  );
  check(
    'Open in Indico links to the canonical event in a new tab',
    s.indicoLink === 'https://indico.cern.ch/event/9001/' && s.indicoTarget === '_blank',
    s.indicoLink
  );
  check('the note action offers to create one', s.noteButton === 'Create note', s.noteButton);
  check('no token appears in the page or browser storage', !s.leaked);
  await page.shot('meeting-agenda-desktop');

  // 2. Create the note, write in it, come back, and reopen it.
  await clickText('.meetings-actions button', 'Create note');
  await page.waitFor(`${EDITOR} && ${EDITOR}.state.doc.toString().includes('indico:')`);
  s = await snapshot();
  const notePath = s.path;
  check(
    'Create note opens a Markdown note tied to the event',
    /indico: https:\/\/indico\.cern\.ch\/event\/9001\//.test(s.doc) &&
      /## Agenda/.test(s.doc) &&
      /## Action items/.test(s.doc) &&
      notePath.startsWith('/meetings/'),
    notePath
  );
  await page.eval(`
    const view = ${EDITOR};
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();`);
  await page.type('\nDecision: keep the seeding change.');
  await sleep(1500);
  const disk = await fs.readFile(
    path.join(main.dir, 'research', notePath),
    'utf8'
  );
  check('the note saves to the workspace', disk.includes('Decision: keep the seeding change.'));

  await page.click('.global-bar [aria-label="Open meetings"]');
  await page.waitFor(`document.querySelector('.meetings-pane:not([hidden])')`);
  await sleep(300);
  s = await snapshot();
  check(
    'returning to Meetings keeps the chosen meeting',
    s.selected === 'Tracking and reconstruction weekly' && s.agenda === 4,
    s.selected
  );
  check('the meeting now offers Open note', s.noteButton === 'Open note', s.noteButton);
  await page.shot('meeting-existing-note-desktop');

  await clickText('.meetings-actions button', 'Open note');
  await page.waitFor(`${EDITOR} && ${EDITOR}.state.doc.toString().includes('Decision:')`);
  s = await snapshot();
  check(
    'Open note reopens the same note with the user text intact',
    s.path === notePath && s.doc.includes('Decision: keep the seeding change.'),
    s.path
  );
  const notes = await fs.readdir(path.join(main.dir, 'research', 'meetings'));
  check(
    'no duplicate note was created',
    notes.filter((name) => name.startsWith('Tracking')).length === 1,
    notes.join(', ')
  );

  // 3. Views come and go around the open note without disturbing it.
  await page.click('.global-action[aria-controls="ai-panel"]');
  await sleep(300);
  const before = await snapshot();
  for (const label of [
    'Open meetings',
    'Open tasks',
    'Open daily notes calendar',
    'Open arXiv news',
    'Open meetings'
  ]) {
    await page.click(`.global-bar [aria-label="${label}"]`);
    await sleep(350);
    s = await snapshot();
    check(
      `${label.replace('Open ', '')}: only it is active; panels unchanged`,
      s.active.join() === label && s.files === before.files && s.ai === before.ai,
      JSON.stringify({ active: s.active, files: s.files, ai: s.ai })
    );
  }
  check('Meetings still has its selection after the tour', s.selected === 'Tracking and reconstruction weekly', s.selected);
  await page.eval(`history.back();`);
  await page.click('.global-bar [aria-label="Open meetings"]');
  await clickText('.meetings-actions button', 'Open note');
  await page.waitFor(`${EDITOR} && ${EDITOR}.state.doc.toString().includes('Decision:')`);
  s = await snapshot();
  check(
    'the note is unchanged after visiting every view',
    s.doc === before.doc,
    `${s.doc.length} vs ${before.doc.length}`
  );
  await page.click('.global-action[aria-controls="ai-panel"]');

  // 4. Keyboard: meeting rows are buttons, Enter chooses one.
  await page.click('.global-bar [aria-label="Open meetings"]');
  await page.eval(`
    [...document.querySelectorAll('.meetings-item')]
      .find((el) => el.textContent.includes('Colloquium')).focus();`);
  await page.key('Enter');
  await page.waitFor(`document.querySelector('.meetings-detail h3')?.textContent.includes('Colloquium')`);
  s = await snapshot();
  check('Enter on a focused meeting opens it', s.heading.startsWith('Colloquium'), s.heading);

  // 5. Add source: validation and a successful add.
  await clickText('.tasks-summary button', 'Add source');
  s = await snapshot();
  const focusIsUrl = await page.eval(
    `return document.activeElement?.getAttribute('type') === 'url';`
  );
  check('Add source puts focus in the link field', focusIsUrl);
  await page.type('https://intranet.example.org/category/1/');
  await page.eval(`document.querySelector('.meetings-add').requestSubmit();`);
  await page.waitFor(`document.querySelector('.meetings-sources .meetings-notice.error')`);
  const refused = await page.eval(
    `return document.querySelector('.meetings-sources .meetings-notice.error').textContent;`
  );
  check(
    'a link to a host that is not an Indico is refused with a reason',
    /not a known Indico/.test(refused),
    refused
  );
  await page.eval(`
    const input = document.querySelector('.meetings-add input[type=url]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();`);
  await page.type('https://indico.cern.ch/event/9003/timetable/');
  await page.eval(`document.querySelector('.meetings-add').requestSubmit();`);
  await page.waitFor(`document.querySelectorAll('.meetings-source-list li').length === 3`);
  await sleep(300);
  await page.shot('meetings-add-source-desktop');
  check('a valid event link is added as a source', true);
  const saved = JSON.parse(
    await fs.readFile(path.join(main.dir, 'research', '.webmd/meetings.json'), 'utf8')
  );
  check(
    'the source is stored canonical, with no token',
    saved.sources[2].url === 'https://indico.cern.ch/event/9003/' &&
      !JSON.stringify(saved).includes(PLACEHOLDER_TOKEN),
    saved.sources[2].url
  );

  // 6. Widths: no horizontal overflow, list and detail take turns when narrow.
  for (const [name, width, height] of [
    ['laptop', 1280, 800],
    ['small-laptop', 1024, 768],
    ['tablet', 800, 1000]
  ]) {
    await page.viewport(width, height);
    s = await snapshot();
    check(`${name}: no horizontal overflow`, s.overflow <= 0, `overflow ${s.overflow}, layout ${s.layout}`);
  }

  await page.viewport(390, 844);
  await openMeetings(main.url);
  s = await snapshot();
  check(
    'phone: the list comes first, alone',
    s.layout === 'list' && s.listVisible && !s.detailVisible && s.overflow <= 0,
    JSON.stringify({ layout: s.layout, overflow: s.overflow })
  );
  await page.shot('meetings-list-narrow');
  await chooseMeeting('Detector upgrade workshop');
  s = await snapshot();
  check(
    'phone: a meeting replaces the list, and focus moves to its title',
    s.layout === 'detail' && !s.listVisible && s.detailVisible &&
      s.focusTag === 'H3' && s.overflow <= 0,
    JSON.stringify({ layout: s.layout, focus: s.focusTag, overflow: s.overflow })
  );
  await page.shot('meeting-agenda-narrow');
  await clickText('.meetings-back', 'All meetings');
  s = await snapshot();
  check(
    'phone: back returns to the list with focus on the meeting',
    s.layout === 'list' && s.focus.includes('Detector upgrade workshop'),
    s.focus
  );
  await chooseMeeting('Machine learning seminar');
  await page.shot('meeting-existing-note-narrow');
  s = await snapshot();
  check('phone: an existing note offers Open note', s.noteButton === 'Open note', s.noteButton);
  await clickText('.tasks-summary button', 'Add source');
  await page.shot('meetings-add-source-narrow');
  s = await snapshot();
  check('phone: Add source fits', s.overflow <= 0, `overflow ${s.overflow}`);

  // 7. Failure states.
  await page.viewport(1440, 900);
  await openMeetings(auth.url);
  s = await snapshot();
  const authNotice = s.notices.find((notice) => notice.kind === 'auth');
  check(
    'a rejected token is an authentication error naming the variable',
    authNotice?.tone === 'error' && /rejected INDICO_CERN_TOKEN/.test(authNotice.text),
    authNotice?.text
  );
  check('the rejected token is not shown', !s.leaked);
  await page.shot('meetings-auth-desktop');
  await page.viewport(390, 844);
  await sleep(250);
  await page.shot('meetings-auth-narrow');
  s = await snapshot();
  check('phone: the authentication error fits', s.overflow <= 0, `overflow ${s.overflow}`);

  await page.viewport(1440, 900);
  await openMeetings(noToken.url);
  s = await snapshot();
  const hint = s.notices.find((notice) => notice.kind === 'maybe_protected');
  check(
    'without a token, public meetings still show',
    s.items.includes('Machine learning seminar') &&
      !s.items.includes('Tracking and reconstruction weekly'),
    s.items.join(' | ')
  );
  check(
    'without a token, the protected source says what to set',
    hint?.tone === 'hint' && /set INDICO_CERN_TOKEN/.test(hint.text),
    hint?.text
  );
  await page.shot('meetings-no-token-desktop');

  await openMeetings(offline.url);
  s = await snapshot();
  check(
    'a network failure is reported per source',
    s.notices.some((notice) => notice.kind === 'network' && notice.tone === 'error'),
    JSON.stringify(s.notices)
  );
  await page.shot('meetings-offline-desktop');

  await openMeetings(empty.url);
  s = await snapshot();
  check(
    'with no sources the view explains how to start',
    await page.eval(`return Boolean(document.querySelector('.meetings-empty'));`)
  );
  await page.shot('meetings-empty-desktop');

  // 7. Zoom: Join while a call is on, then a past meeting's recording and
  // transcript, summarized into its note.
  await page.viewport(1440, 900);
  await openMeetings(zoom.url, { reset: true });
  const chip = await page.eval(`
    const row = [...document.querySelectorAll('.meetings-row')]
      .find((el) => el.textContent.includes('Analysis check-in on Zoom'));
    const link = row?.querySelector('.meetings-join-chip');
    return link ? { href: link.getAttribute('href'), target: link.getAttribute('target') } : null;`);
  check(
    'a call under way offers Join beside its row',
    chip?.href === 'https://cern.zoom.us/j/98765432101?pwd=Fixture.1' && chip.target === '_blank',
    JSON.stringify(chip)
  );
  const quiet = await page.eval(`
    return [...document.querySelectorAll('.meetings-row')]
      .filter((el) => el.querySelector('.meetings-join-chip'))
      .map((el) => el.querySelector('.meetings-item-title').textContent.trim());`);
  check('meetings not about to start offer no Join', quiet.length === 1, quiet.join(' | '));
  await chooseMeeting('Analysis check-in on Zoom');
  const joinDetail = await page.eval(`
    const link = document.querySelector('.meetings-actions .meetings-join');
    return {
      text: link?.textContent.trim(),
      primary: link?.classList.contains('primary'),
      facts: [...document.querySelectorAll('.meetings-facts > div')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()).find((text) => text.startsWith('Zoom'))
    };`);
  check(
    'the call shows Join Zoom now first, with its meeting ID and passcode',
    joinDetail.text === 'Join Zoom now' && joinDetail.primary &&
      /Meeting ID 987 6543 2101 · Passcode 424242/.test(joinDetail.facts),
    JSON.stringify(joinDetail)
  );
  await page.shot('meetings-zoom-live-desktop');

  s = await snapshot();
  check('past meetings are listed last', s.sections.at(-1) === 'Past week', s.sections.join(', '));
  await chooseMeeting('Last week analysis review');
  const follow = () =>
    page.eval(`
      const section = document.querySelector('.meetings-follow');
      return section ? {
        text: section.textContent.replace(/\\s+/g, ' ').trim(),
        recording: section.querySelector('a[href*="rec/share"]')?.getAttribute('href') || '',
        notice: section.querySelector('.meetings-notice')?.textContent.trim() || ''
      } : null;`);
  let f = await follow();
  check(
    'a past meeting offers its Indico recording and a transcript upload',
    f?.recording === 'https://cern.zoom.us/rec/share/fixture-recording' &&
      /linked in Indico/.test(f.text) && /Add file/.test(f.text),
    f?.text
  );
  await clickText('.meetings-follow button', 'Save to note');
  await page.waitFor(`document.querySelector('.meetings-follow .meetings-notice')`);
  f = await follow();
  check('the recording link is saved in the note', /saved in the note/.test(f.notice) && /Change/.test(f.text), f.notice);

  await page.eval(`
    const input = document.querySelector('.meetings-follow input[type=file]');
    const data = new DataTransfer();
    data.items.add(new File(['WEBVTT\\n\\n1\\n00:00:01.000 --> 00:00:03.000\\nAda Lovelace: We rerun the validation.\\n'], 'meeting.transcript.vtt', { type: 'text/vtt' }));
    input.files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await page.waitFor(`document.querySelector('.meetings-follow .meetings-file-link')`);
  f = await follow();
  check(
    'a transcript file becomes a transcript note beside the meeting note',
    /Last week analysis review \(\d{4}-\d{2}-\d{2}\) transcript/.test(f.text) && /Transcript saved: 1 turn/.test(f.notice),
    f.notice
  );
  await page.waitFor(`document.getElementById('files-panel')?.textContent.includes('transcript')`);
  check('the file tree shows the new transcript note', true);
  await page.shot('meetings-transcript-desktop');

  await page.viewport(390, 844);
  s = await snapshot();
  check('phone: the recording and transcript section fits', s.overflow <= 0, `overflow ${s.overflow}`);
  await page.shot('meetings-transcript-narrow');
  await page.viewport(1440, 900);

  await clickText('.meetings-follow button', 'Summarize into note');
  await page.waitFor(`${EDITOR} && ${EDITOR}.state.doc.toString().includes('## Summary')`);
  s = await snapshot();
  check(
    'Summarize writes a summary and action items into the meeting note and opens it',
    /_Written by AI from \[\[Last week analysis review \(\d{4}-\d{2}-\d{2}\) transcript\]\]\._/.test(s.doc) &&
      /- \[ \] Rerun the fixture validation who:fixture 📅 \d{4}-\d{2}-\d{2}/.test(s.doc) &&
      /recording: https:\/\/cern\.zoom\.us\/rec\/share\/fixture-recording/.test(s.doc) &&
      /- \*\*Zoom:\*\* <https:\/\/cern\.zoom\.us\/j\/12345678901>/.test(s.doc),
    s.path
  );
  await page.shot('meetings-summary-note-desktop');
} catch (error) {
  check('meetings scenario run', false, error.stack);
} finally {
  chrome.kill();
  for (const fixture of [main, auth, noToken, empty, offline, zoom]) fixture.child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

finish();
