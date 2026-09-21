// Layout acceptance scenarios, driven through headless Chrome (see
// scripts/browser-harness.mjs). It starts its own fixture servers, so the only
// prerequisite is a build:
//
//   npm run build && npm run scenarios
//
// Screenshots land in OUT_DIR (a temp directory by default). Set CHROME_PATH
// if Chrome is not in the usual place. Exits non-zero if any check fails.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  check,
  finish,
  launchChrome,
  sleep,
  startFixture
} from './browser-harness.mjs';

// Reads the running page. The editor view is only inspected, never driven.
const EDITOR = `document.querySelector('.cm-content').cmTile.view`;
const state = (page) =>
  page.eval(`
    const view = ${EDITOR};
    const sel = view.state.selection.main;
    const rect = (id) => {
      const el = document.getElementById(id);
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), overlay: el.classList.contains('panel-overlay') };
    };
    return {
      files: rect('files-panel'),
      ai: rect('ai-panel'),
      selection: view.state.sliceDoc(sel.from, sel.to),
      doc: view.state.doc.toString(),
      contextSummary: document.querySelector('.ai-context-summary')?.textContent.trim(),
      contextDetails: document.querySelector('.ai-context-body')?.textContent.replace(/\\s+/g, ' ').trim(),
      focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.className || '',
      save: document.querySelector('.sidebar-status [role=status]')?.textContent.trim(),
      overflow: document.documentElement.scrollWidth - innerWidth,
      title: document.querySelector('.current-file')?.textContent.trim()
    };`);

async function sendChat(page, text) {
  await page.eval(`
    const input = document.querySelector('textarea[aria-label="Ask AI"]');
    input.focus();`);
  await page.type(text);
  const before = await page.eval(
    `return document.querySelectorAll('.ai-message-assistant').length;`
  );
  await page.click('.ai-send-button');
  await page.waitFor(
    `document.querySelectorAll('.ai-message-assistant').length > ${before}`
  );
  const streaming = await page.eval(`
    return {
      sendDisabled: document.querySelector('.ai-send-button').disabled,
      status: document.querySelector('.ai-status')?.textContent.trim() || ''
    };`);
  await page.waitFor(
    `!document.querySelector('.ai-status') || !/Thinking/.test(document.querySelector('.ai-status').textContent)`,
    20000
  );
  const reply = await page.eval(`
    const replies = document.querySelectorAll('.ai-message-assistant');
    return replies[replies.length - 1].textContent.replace(/\\s+/g, ' ').trim();`);
  return { streaming, reply };
}

const main = await startFixture(3198, { AI_MODE: 'slow' });
const failing = await startFixture(3199, { AI_MODE: 'error' });
const { child: chrome, page, profile } = await launchChrome();

try {
  // 1. Edit, select, open AI, resize and collapse, keep editing.
  await page.viewport(1440, 900);
  await page.goto(`${main.url}/#/README.md`);
  await page.eval(`localStorage.clear(); sessionStorage.clear();`);
  await page.reload();
  await page.waitFor(`document.querySelector('.cm-content')`);
  let s = await state(page);
  check(
    'defaults: file sidebar docked at 240px, AI closed',
    s.files?.width === 240 && !s.ai,
    JSON.stringify({ files: s.files, ai: s.ai })
  );

  await page.eval(
    `window.__editorDom = document.querySelector('.cm-content');`
  );
  await page.click('.cm-line:nth-child(8)');
  await page.key('End');
  await page.type(' Edited.');
  for (let i = 0; i < 7; i += 1) await page.key('ArrowLeft', { shift: true });
  s = await state(page);
  check(
    'editor selection made with the keyboard',
    s.selection === 'Edited.',
    JSON.stringify(s.selection)
  );
  const drawn = await page.eval(`
    const layer = document.querySelector('.cm-selectionBackground');
    const line = document.querySelector('.cm-activeLine');
    return {
      selection: layer ? getComputedStyle(layer).backgroundColor : null,
      activeLine: line ? getComputedStyle(line).backgroundColor : null
    };`);
  check(
    'selection is painted and the active line does not cover it',
    drawn.selection &&
      drawn.selection !== 'rgba(0, 0, 0, 0)' &&
      !/^rgb\(/.test(drawn.activeLine || 'rgb('),
    JSON.stringify(drawn)
  );
  await page.shot('1-editor-selection');

  await page.click('.global-action[aria-controls="ai-panel"]');
  s = await state(page);
  check(
    'AI docks on the right at 340px',
    s.ai?.width === 340 && !s.ai.overlay,
    JSON.stringify(s.ai)
  );
  check('opening AI focuses the composer', s.focus === 'Ask AI', s.focus);
  check(
    'context shows the selection, not the note',
    s.contextSummary === 'Selection · 7 chars',
    s.contextSummary
  );
  check('opening AI keeps the editor selection', s.selection === 'Edited.');
  await page.shot('1-desktop-ai-open');

  await page.drag('.resize-handle-files', 60);
  await page.eval(`document.querySelector('.resize-handle-ai').focus();`);
  await page.key('ArrowLeft');
  await page.key('ArrowLeft');
  s = await state(page);
  check(
    'drag resizes the file sidebar',
    Math.abs(s.files.width - 300) <= 2,
    String(s.files.width)
  );
  check(
    'arrow keys resize the AI panel',
    s.ai.width === 372,
    String(s.ai.width)
  );

  await page.click('#files-panel .panel-close-button');
  await page.click('.ai-header .panel-close-button[aria-controls="ai-panel"]');
  s = await state(page);
  check('both panels collapse', !s.files && !s.ai);
  check(
    'collapsing returns focus to the editor with its selection',
    /cm-content/.test(s.focus) && s.selection === 'Edited.',
    `${s.focus} / ${JSON.stringify(s.selection)}`
  );
  check(
    'the editor was never recreated',
    await page.eval(
      `return window.__editorDom === document.querySelector('.cm-content');`
    )
  );
  await page.type('Revised.');
  s = await state(page);
  check(
    'typing replaces the selection',
    s.doc.includes('and [[Missing note]]. Revised.')
  );
  await page.key('z', { meta: true });
  s = await state(page);
  check(
    'undo restores the selected text',
    s.doc.includes('[[Missing note]]. Edited.') && !s.doc.includes('Revised.')
  );
  await page.waitFor(
    `/All changes saved/.test(document.querySelector('.sidebar-status')?.textContent || '')`,
    5000
  );
  await sleep(600);
  const disk = await fs.readFile(
    path.join(main.dir, 'research', 'README.md'),
    'utf8'
  );
  check('the edit reaches disk', disk.includes('[[Missing note]]. Edited.'));

  // 2. Navigate with AI open; labels and requests stay accurate.
  await page.click('.global-action[aria-controls="files-panel"]');
  await page.click('.global-action[aria-controls="ai-panel"]');
  await page.eval(`${EDITOR}.focus();`);
  await page.key('End');
  s = await state(page);
  check(
    'with no selection the note is the context',
    s.contextSummary === 'Note · README.md',
    s.contextSummary
  );
  let chat = await sendChat(page, 'What is this note about?');
  check(
    'streaming disables Send and says it is thinking',
    chat.streaming.sendDisabled && /Thinking/.test(chat.streaming.status),
    JSON.stringify(chat.streaming)
  );
  check(
    'the request carried the note',
    /Context received: Current document \/README\.md/.test(chat.reply),
    chat.reply
  );

  await page.click('.global-action[aria-label="Open arXiv news"]');
  await page.waitFor(`document.querySelector('.news-paper')`);
  s = await state(page);
  check('file tree stays visible in arXiv News', s.files?.width === 300);
  check(
    'News: the hidden note is not context',
    s.contextSummary === 'No note context',
    s.contextSummary
  );
  check(
    'News: details name the note as left out',
    /\/README\.md stays out/.test(s.contextDetails),
    s.contextDetails
  );
  chat = await sendChat(page, 'Anything new?');
  check(
    'News: the request carried no note',
    /Context received: No active document\./.test(chat.reply),
    chat.reply
  );
  await page.shot('2-news-ai-open');

  const newsDays = () =>
    page.eval(`
      const select = document.querySelector('.news-days select');
      return {
        options: [...(select?.options ?? [])].map((option) => option.textContent),
        value: select?.value,
        later: document.querySelector('[aria-label="Later day"]')?.disabled,
        first: document.querySelector('.news-paper .news-title')?.textContent
      };
    `);
  let days = await newsDays();
  check(
    'News: the day menu lists the kept days, latest first',
    days.options.length === 3 && /latest/.test(days.options[0]) && days.later,
    JSON.stringify(days)
  );
  await page.click('[aria-label="Earlier day"]');
  await page.waitFor(
    `document.querySelector('.news-paper .news-title')?.textContent.startsWith('Earlier fixture paper')`
  );
  days = await newsDays();
  check(
    'News: Earlier day shows that day’s listing',
    days.value !== '' && !days.later && /^Earlier fixture/.test(days.first),
    JSON.stringify(days)
  );
  await page.shot('2-news-earlier-day');
  await page.click('[aria-label="Later day"]');
  await page.waitFor(
    `document.querySelector('.news-paper .news-title')?.textContent.startsWith('Fixture paper')`
  );
  check('News: Later day returns to the latest listing', true);

  for (const [label, view] of [['Open tasks', 'Tasks']]) {
    await page.click(`.global-action[aria-label="${label}"]`);
    await sleep(300);
    s = await state(page);
    check(
      `${view}: files visible, no note context`,
      s.files && s.contextSummary === 'No note context' && s.title === view,
      `${s.title} / ${s.contextSummary}`
    );
  }
  const treeState = await page.eval(`return {
    rows: [...document.querySelectorAll('#files-panel .tree button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
    search: document.querySelector('#files-panel input[type=search]')?.value
  };`);
  const openRow = (name) =>
    page.eval(`const row = [...document.querySelectorAll('#files-panel .tree button')].find((b) => b.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('No tree row ' + ${JSON.stringify(name)} + ': ' + ${JSON.stringify(JSON.stringify(treeState))});
      row.click();`);
  if (!treeState.rows.some((row) => row.startsWith('conventions.md')))
    await openRow('meta');
  await page.waitFor(
    `[...document.querySelectorAll('.tree-name')].some((n) => n.textContent === 'conventions.md')`
  );
  await openRow('conventions.md');
  await page.waitFor(
    `/conventions/.test(document.querySelector('.current-file').textContent)`
  );
  s = await state(page);
  check(
    'opening a file makes it the context',
    s.contextSummary === 'Note · conventions.md',
    s.contextSummary
  );
  chat = await sendChat(page, 'Summarize');
  check(
    'the request followed the new file',
    /Current document \/meta\/conventions\.md/.test(chat.reply),
    chat.reply
  );
  await page.shot('2-note-ai-open');

  // 3. Refresh restores the layout, and only the layout is stored.
  await page.reload();
  await page.waitFor(
    `document.querySelector('.cm-content') && /conventions/.test(document.querySelector('.current-file').textContent)`
  );
  s = await state(page);
  check(
    'refresh restores widths and open panels',
    s.files?.width === 300 && s.ai?.width === 372,
    JSON.stringify({ files: s.files, ai: s.ai })
  );
  const stored = await page.eval(
    `return { layout: localStorage.getItem('webmd:layout'), all: JSON.stringify({ ...localStorage }) };`
  );
  check(
    'layout storage holds only layout fields',
    JSON.stringify(Object.keys(JSON.parse(stored.layout)).sort()) ===
      '["aiOpen","aiWidth","filesOpen","filesWidth"]',
    stored.layout
  );
  check(
    'no conversation text is stored',
    !/Stub reply|Anything new/.test(stored.all)
  );

  // 4. Widths: wide, laptop, small laptop, tablet, phone; AI open and closed.
  const desktopPrefs = stored.layout;
  for (const [width, height, name] of [
    [1920, 1080, 'wide'],
    [1280, 800, 'laptop'],
    [1024, 768, 'small-laptop'],
    [800, 1000, 'tablet'],
    [390, 844, 'phone']
  ]) {
    await page.viewport(width, height);
    s = await state(page);
    if (!s.ai) {
      await page.click('.global-action[aria-controls="ai-panel"]');
      s = await state(page);
    }
    check(
      `${name}: AI opens (${s.ai?.overlay ? 'overlay' : 'docked'}) with no horizontal overflow`,
      s.ai && s.overflow <= 0,
      `overflow ${s.overflow}, ai ${JSON.stringify(s.ai)}, files ${JSON.stringify(s.files)}`
    );
    const composer = await page.eval(`
      const r = document.querySelector('.ai-form').getBoundingClientRect();
      return r.bottom <= innerHeight && r.right <= innerWidth && r.left >= 0;`);
    check(`${name}: the composer is fully on screen`, composer);
    await page.shot(`4-${name}-ai-open`);
    await page.click(
      '.ai-header .panel-close-button[aria-controls="ai-panel"]'
    );
    s = await state(page);
    check(
      `${name}: AI closes with no horizontal overflow`,
      !s.ai && s.overflow <= 0,
      `overflow ${s.overflow}`
    );
    await page.shot(`4-${name}-ai-closed`);
    if (name !== 'phone') {
      // Put the desktop state back the way it was for the next width.
      await page.click('.global-action[aria-controls="ai-panel"]');
    }
  }
  const afterPhone = await page.eval(
    `return localStorage.getItem('webmd:layout');`
  );
  check(
    'squeezing to phone width did not rewrite the desktop layout',
    JSON.parse(afterPhone).filesOpen === true &&
      JSON.parse(afterPhone).filesWidth === 300,
    afterPhone
  );
  await page.viewport(1440, 900);
  s = await state(page);
  check(
    'back at desktop width the remembered panels return',
    s.files?.width === 300,
    JSON.stringify({
      files: s.files,
      ai: s.ai,
      stored: JSON.parse(desktopPrefs)
    })
  );

  // 5. Keyboard, overlays, focus, failure.
  await page.viewport(1024, 768);
  await page.eval(
    `document.querySelector('.global-action[aria-controls="ai-panel"]').focus();`
  );
  if ((await state(page)).ai) await page.key('Enter');
  await page.key('Enter');
  s = await state(page);
  check(
    'Enter on the rail opens the AI overlay into the composer',
    s.ai?.overlay && s.focus === 'Ask AI',
    JSON.stringify({ ai: s.ai, focus: s.focus })
  );
  await page.key('Escape');
  s = await state(page);
  check(
    'Escape closes the overlay and returns focus',
    !s.ai && s.focus !== 'Ask AI' && s.focus !== '',
    s.focus
  );

  await page.viewport(390, 844);
  await page.eval(
    `document.querySelector('.global-action[aria-controls="files-panel"]').focus();`
  );
  await page.key('Enter');
  s = await state(page);
  const inert = await page.eval(
    `return document.querySelector('.workspace').inert;`
  );
  check(
    'phone: files open over an inert workspace, focus in search',
    s.files?.overlay && inert && s.focus === 'Search files and contents',
    JSON.stringify({ files: s.files, focus: s.focus, inert })
  );
  await page.shot('5-phone-files-overlay');
  await page.key('Escape');
  s = await state(page);
  check(
    'phone: Escape closes files and focus returns to the rail',
    !s.files && s.focus === 'Show file sidebar',
    s.focus
  );

  await page.viewport(1440, 900);
  await page.goto(`${failing.url}/#/README.md`);
  await page.waitFor(`document.querySelector('.cm-content')`);
  if (!(await state(page)).ai)
    await page.click('.global-action[aria-controls="ai-panel"]');
  chat = await sendChat(page, 'Will this fail?');
  const failure = await page.eval(
    `return document.querySelector('.ai-status')?.textContent.trim() || '';`
  );
  check(
    'a provider failure is reported in the thread and status',
    /failed with 503/.test(chat.reply) && failure === 'AI request failed',
    `${failure} / ${chat.reply.slice(0, 120)}`
  );
  await page.shot('5-ai-failure');
} catch (error) {
  check('scenario run', false, error.stack);
} finally {
  chrome.kill();
  main.child.kill();
  failing.child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

finish();
