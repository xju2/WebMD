// Conference planner acceptance scenarios against the fixture's canned Indico
// conference (event 9010: two days, four tracks) and stub scorer. Needs a
// build first:
//
//   npm run build && npm run scenarios:conference
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

const EVENT = 'https://indico.cern.ch/event/9010/timetable/';
const main = await startFixture(3211, { ARXIV_NEWS_MAX_CANDIDATES: '40' });
const { child: chrome, page, profile } = await launchChrome();

const state = () =>
  page.eval(`
    const pane = document.querySelector('.conference-pane');
    const talks = [...document.querySelectorAll('.conference-talk')];
    const span = (el) => {
      const [start, end] = [...el.querySelector('.conference-time').childNodes].map((node) => node.textContent.trim());
      return [start, end];
    };
    return {
      visible: Boolean(pane && !pane.hidden && pane.getClientRects().length),
      days: [...document.querySelectorAll('.conference-days button')].map((el) => el.textContent.trim()),
      talks: talks.map((el) => ({
        span: span(el),
        title: el.querySelector('.conference-title a, .conference-title span:last-child').textContent.trim(),
        room: el.querySelector('.conference-where strong')?.textContent.trim() || '',
        backup: el.querySelector('.conference-backup button')?.textContent.trim() || ''
      })),
      cells: document.querySelectorAll('.conference-cell').length,
      chosen: [...document.querySelectorAll('.conference-cell.chosen')].map((el) => el.textContent.trim()),
      meta: document.querySelector('.conference-meta')?.textContent.trim() || '',
      error: document.querySelector('.conference-pane [role="alert"]')?.textContent.trim() || '',
      noteButton: [...document.querySelectorAll('.conference-actions button')].map((el) => el.textContent.trim()),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };`);

async function clickText(selector, text) {
  await page.eval(`
    [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((el) => el.textContent.includes(${JSON.stringify(text)})).click();`);
  await sleep(250);
}

const overlapping = (talks) =>
  talks.some((talk, index) => index && talks[index - 1].span[1] > talk.span[0]);

try {
  await page.viewport(1440, 900);
  await page.goto(`${main.url}/#/README.md`);
  await page.eval(`localStorage.clear(); sessionStorage.clear();`);
  await page.reload();
  await page.click('.global-bar [aria-label="Open conference planner"]');
  await page.waitFor(`document.querySelector('.conference-open input')`);
  let s = await state();
  check('the rail opens the conference planner', s.visible);

  await page.click('.conference-open input');
  await page.type('https://example.org/agenda');
  await page.click('.conference-open button[type="submit"]');
  await page.waitFor(
    `document.querySelector('.conference-pane [role="alert"]')`
  );
  s = await state();
  check(
    'a link that is not an Indico event is refused',
    /Indico/.test(s.error),
    s.error
  );

  await page.eval(`document.querySelector('.conference-open input').select();`);
  await page.type(EVENT);
  await page.click('.conference-open button[type="submit"]');
  await page.waitFor(`document.querySelector('.conference-talk')`, 15000);
  await sleep(200);
  s = await state();
  check(
    'each conference day gets a tab',
    s.days.length === 2,
    s.days.join(' | ')
  );
  check(
    'the day plan lists talks in time order',
    s.talks.length >= 8,
    `${s.talks.length} talks`
  );
  check(
    'no two planned talks overlap',
    !overlapping(s.talks),
    s.talks.map((talk) => talk.span.join('–')).join(', ')
  );
  check(
    'every planned talk says where',
    s.talks.every((talk) => talk.room),
    s.talks.map((talk) => talk.room).join(', ')
  );
  check(
    'parallel talks are offered as a backup',
    s.talks.some((talk) => talk.backup)
  );
  check(
    'the model, talks reviewed, and time zone are stated',
    /fixture-stub reviewed \d+ talks/.test(s.meta) &&
      /Europe\/Zurich/.test(s.meta),
    s.meta
  );
  const posters = await page.eval(`
    const rows = [...document.querySelectorAll('.conference-talk')].filter((el) => el.querySelector('.conference-posters'));
    return rows.map((el) => ({
      text: el.querySelector('.conference-where').textContent.replace(/\\s+/g, ' ').trim(),
      listed: el.querySelectorAll('.conference-posters li').length
    }));`);
  check(
    'a poster session is one stop with its best posters listed',
    posters.length === 1 &&
      posters[0].listed === 10 &&
      /60 posters/.test(posters[0].text),
    JSON.stringify(posters)
  );
  const local = await page.eval(
    `return document.querySelectorAll('.conference-score.local').length;`
  );
  check(
    'talks the model did not read are marked as keyword matches',
    local > 0 && /more matched to your notes locally/.test(s.meta),
    `${local} local scores · ${s.meta}`
  );
  await page.shot('conference-plan');
  await page.eval(
    `document.querySelector('.conference-posters').closest('li.conference-talk').scrollIntoView({ block: 'center' });`
  );
  await sleep(150);
  await page.shot('conference-posters');

  // Swapping in the backup makes it the plan and the old talk its backup.
  const first = s.talks.find((talk) => talk.backup);
  await clickText('.conference-backup button', first.backup);
  s = await state();
  check(
    'choosing the backup swaps it into the plan',
    s.talks.some((talk) => talk.title === first.backup),
    first.backup
  );
  check('the plan still has no overlaps after a swap', !overlapping(s.talks));

  await clickText('.conference-mode button', 'All tracks');
  await page.waitFor(`document.querySelector('.conference-cell')`);
  s = await state();
  check(
    'all tracks show side by side, with the plan filled in',
    s.cells > 30 && s.chosen.length >= 8,
    `${s.cells} talks, ${s.chosen.length} chosen`
  );
  await page.shot('conference-grid');
  const before = s.chosen;
  await page.eval(
    `document.querySelector('.conference-cell:not(.chosen)').click();`
  );
  await sleep(200);
  s = await state();
  check(
    'picking any talk in the grid changes the plan',
    JSON.stringify(s.chosen) !== JSON.stringify(before)
  );

  await clickText(
    '.conference-days button',
    s.days[1].replace(/today/, '').trim()
  );
  s = await state();
  check('the second day has its own plan', s.chosen.length >= 8);

  await clickText('.conference-actions button', 'Save plan to note');
  await page.waitFor(
    `[...document.querySelectorAll('.conference-actions button')].some((el) => el.textContent.includes('Open note'))`
  );
  s = await state();
  check(
    'the plan is saved to a note',
    s.noteButton.some((label) => label.includes('Update plan note')),
    s.noteButton.join(' | ')
  );
  const notes = path.join(main.dir, 'research', 'meetings');
  const files = await fs.readdir(notes).catch(() => []);
  const planFile = files.find((name) => name.endsWith('plan.md'));
  const note = planFile
    ? await fs.readFile(path.join(notes, planFile), 'utf8')
    : '';
  check(
    'the note has a section per day and the backups',
    (note.match(/^## /gm) || []).length === 2 &&
      /- Or: /.test(note) &&
      /60 posters; the best 10 to visit/.test(note),
    note.slice(0, 1500) || 'no plan note'
  );

  await page.viewport(390, 844);
  await clickText('.conference-mode button', 'Plan');
  s = await state();
  check(
    'phone: the plan fits without sideways scrolling',
    s.overflow <= 0,
    `overflow ${s.overflow}`
  );
  await page.shot('conference-phone');

  // The planner remembers the conference, and scores are not asked for again.
  await page.viewport(1440, 900);
  await page.reload();
  await page.click('.global-bar [aria-label="Open conference planner"]');
  await page.waitFor(`document.querySelector('.conference-recent button')`);
  await clickText('.conference-recent button', 'Connecting the Dots 2026');
  await page.waitFor(`document.querySelector('.conference-talk')`);
  s = await state();
  check('a planned conference reopens from the list', s.talks.length >= 8);
} catch (error) {
  check('scenario ran to the end', false, error.stack);
} finally {
  chrome.kill();
  main.child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  finish();
}
