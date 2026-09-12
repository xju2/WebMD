// Shared plumbing for the headless-Chrome acceptance scripts
// (browser-scenarios.mjs, meetings-scenarios.mjs): a DevTools-protocol page
// driver over Node's built-in WebSocket, fixture servers (scripts/fixture.mjs),
// and pass/fail bookkeeping. No browser-automation dependency.
//
// Screenshots land in OUT_DIR (a temp directory by default). Set CHROME_PATH
// if Chrome is not in the usual place.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');
export const OUT =
  process.env.OUT_DIR ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-scenarios-')));
await fs.mkdir(OUT, { recursive: true });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

export async function waitForHttp(url, timeout = 10000) {
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

export async function startFixture(port, env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-fixture-'));
  const child = spawn(process.execPath, ['scripts/fixture.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), FIXTURE_DIR: dir, ...env },
    stdio: 'ignore'
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/workspace/roots`);
  return { child, dir, url: `http://127.0.0.1:${port}` };
}

export class Page {
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

export async function launchChrome() {
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

/** Prints the tally and exits non-zero if any check failed. */
export function finish() {
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`
  );
  process.exit(failed.length ? 1 : 0);
}
