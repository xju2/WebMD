import fs from 'node:fs/promises';
import path from 'node:path';
import {
  check,
  finish,
  launchChrome,
  startFixture
} from './browser-harness.mjs';

const fixture = await startFixture(3196);
const { child: chrome, page, profile } = await launchChrome();
try {
  await fs.writeFile(
    path.join(fixture.dir, 'research', 'Reading.md'),
    '# Papers\n\n- [ ] Yu et al., "MEGABYTE: Predicting sequences" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185) #paper\n'
  );
  await page.viewport(1280, 900);
  await page.goto(fixture.url);
  await page.click('.global-action[aria-label="Open tasks"]');
  await page.waitFor('document.querySelector(".task-row")');
  check(
    'Tasks have completion controls',
    await page.eval(
      'return document.querySelectorAll(".task-complete").length > 0'
    )
  );
  await page.eval(
    '[...document.querySelectorAll(".tasks-grouping button")].find(b => b.textContent.trim() === "Sections").click();'
  );
  await page.waitFor('document.querySelector(".task-group")');
  check(
    'Readable citation and separate paper link',
    await page.eval(
      'return [...document.querySelectorAll(".task-title")].some(b => b.textContent.trim() === "MEGABYTE: Predicting sequences") && !!document.querySelector(".task-links a");'
    )
  );
  await page.eval(
    '[...document.querySelectorAll(".tasks-collections button")].find(b => b.textContent.trim() === "References & ideas").click();'
  );
  await page.waitFor('document.querySelectorAll(".task-row").length === 1');
  check(
    'Reference filter separates the reading list',
    await page.eval(
      'return document.querySelectorAll(".task-row").length === 1 && document.querySelector(".task-title").textContent.includes("MEGABYTE");'
    )
  );
  await page.click('.task-details summary');
  check(
    'Details retain original citation',
    await page.eval(
      'return document.querySelector(".task-details[open]").textContent.includes("Yu et al.");'
    )
  );
  await page.shot('tasks-references');
  await page.click('.task-complete');
  await page.waitFor('!document.querySelector(".task-row")');
  check(
    'Completion persists without opening the editor',
    (
      await fs.readFile(
        path.join(fixture.dir, 'research', 'Reading.md'),
        'utf8'
      )
    ).includes('- [x] Yu et al.') &&
      (await page.eval('return !!document.querySelector(".tasks-pane")'))
  );
  await page.click('.tasks-toggle input');
  await page.waitFor('document.querySelector(".task-complete")?.checked');
  await page.click('.task-complete');
  await page.waitFor('!document.querySelector(".task-complete")?.checked');
  check(
    'Completed references can be reopened',
    (
      await fs.readFile(
        path.join(fixture.dir, 'research', 'Reading.md'),
        'utf8'
      )
    ).includes('- [ ] Yu et al.')
  );
  await page.eval(
    '[...document.querySelectorAll(".tasks-collections button")].find(b => b.textContent.trim() === "All items").click();'
  );
  await page.viewport(390, 844);
  await page.shot('tasks-mobile');
  check(
    'Narrow view has no horizontal overflow',
    await page.eval(
      'return document.documentElement.scrollWidth <= innerWidth;'
    )
  );
} finally {
  page.socket.close();
  chrome.kill();
  fixture.child.kill();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(fixture.dir, { recursive: true, force: true });
}
finish();
