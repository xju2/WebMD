// Layout acceptance scenarios, driven through headless Chrome's DevTools
// protocol with Node's built-in WebSocket: no browser-automation dependency.
// It starts its own fixture servers (see scripts/fixture.mjs), so the only
// prerequisite is a build:
//
//   npm run build && npm run scenarios
//
// Screenshots land in OUT_DIR (a temp directory by default). Set CHROME_PATH
// if Chrome is not in the usual place. Exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
const OUT =
  process.env.OUT_DIR ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-scenarios-')));
await fs.mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHttp(url, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startFixture(port, env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-fixture-'));
  const child = spawn(process.execPath, ['scripts/fixture.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), FIXTURE_DIR: dir, ...env },
    stdio: 'ignore'
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/workspace/roots`);
  return { child, dir, url: `http://127.0.0.1:${port}` };
}

class Page {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject })
    );
  }

  once(method) {
    return new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== method) return;
        this.listeners = this.listeners.filter((item) => item !== listener);
        resolve(message.params);
      };
      this.listeners.push(listener);
    });
  }

  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(250);
  }

  async goto(url) {
    const loaded = this.once('Page.loadEventFired');
    const { loaderId } = await this.send('Page.navigate', { url });
    // A fragment-only change is a same-document navigation: no load event.
    if (loaderId) await loaded;
    await this.waitFor('document.querySelector(".tree button")');
  }

  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
    await this.waitFor('document.querySelector(".tree button")');
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    }
    return result.result.value;
  }

  async waitFor(expression, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.eval(`return Boolean(${expression});`)) return true;
      await sleep(80);
    }
    return false;
  }

  async center(selector) {
    const box = await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    if (!box) throw new Error(`No element for ${selector}`);
    return box;
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      ...extra
    });
  }

  async click(selector) {
    const { x, y } = await this.center(selector);
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
    await sleep(120);
  }

  async drag(selector, dx) {
    const { x, y } = await this.center(selector);
    await this.mouse('mousePressed', x, y);
    for (let step = 1; step <= 6; step += 1) {
      await this.mouse('mouseMoved', x + (dx * step) / 6, y, { buttons: 1 });
    }
    await this.mouse('mouseReleased', x + dx, y);
    await sleep(150);
  }

  async key(key, { shift = false, meta = false } = {}) {
    const codes = {
      Tab: 9,
      Enter: 13,
      Escape: 27,
      End: 35,
      Home: 36,
      ArrowLeft: 37,
      ArrowRight: 39
    };
    const keyCode = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const modifiers =
      (shift ? 8 : 0) | (meta ? (process.platform === 'darwin' ? 4 : 2) : 0);
    const base = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      windowsVirtualKeyCode: keyCode,
      modifiers
    };
    if (meta && key === 'z') {
      // Headless Chrome does not map Cmd+Z to undo on its own.
      base.commands = ['undo'];
    }
    // Enter activates a focused button only when the key event carries its
    // text, so send it as a full keyDown rather than a raw one.
    const down =
      key === 'Enter'
        ? { type: 'keyDown', text: '\r', unmodifiedText: '\r' }
        : { type: 'rawKeyDown' };
    await this.send('Input.dispatchKeyEvent', { ...down, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  }

  async type(text) {
    await this.send('Input.insertText', { text });
    await sleep(60);
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png'
    });
    const file = path.join(OUT, `${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }
}

async function launchChrome() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  await waitForHttp(`http://127.0.0.1:${port}/json/version`);
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const target = targets.find((item) => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const page = new Page(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return { child, page, profile };
}

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

  for (const [label, view] of [
    ['Open tasks', 'Tasks'],
    ['Open daily notes calendar', 'Daily Notes']
  ]) {
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

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`
);
process.exit(failed.length ? 1 : 0);
