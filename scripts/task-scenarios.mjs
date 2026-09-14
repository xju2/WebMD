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
    '# Papers\n\n- [ ] Yu et al., "MEGABYTE: Predicting sequences" — [arXiv:2305.07185](https://arxiv.org/abs/2305.07185) #paper\n- [ ] who:me sort the reading list\n'
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
      'return [...document.querySelectorAll(".task-title")].some(b => b.textContent.trim() === "MEGABYTE: Predicting sequences") && !!document.querySelector(".task-paper-link");'
    )
  );
  check(
    'Rows carry tags and no repeated labels',
    await page.eval(
      'return !!document.querySelector(".task-row-meta .task-tag") && !document.querySelector(".task-details, .task-kind, .tasks-collections, .tasks-options");'
    )
  );
  await page.eval(
    '[...document.querySelectorAll(".task-title .task-who")].find(b => b.textContent.trim() === "Me").click();'
  );
  check(
    'who:me is a clickable Me in the sentence',
    await page.eval(
      'return document.querySelector(".tasks-filter").value === "who:me" && document.querySelector(".tasks-pane") && [...document.querySelectorAll(".task-title")].every(t => t.textContent.includes("Me"));'
    )
  );
  await page.click('.tasks-filter');
  await page.eval(
    'const f = document.querySelector(".tasks-filter"); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true }));'
  );
  await page.type('MEGABYTE');
  await page.waitFor('document.querySelectorAll(".task-row").length === 1');
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
    'const f = document.querySelector(".tasks-filter"); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true }));'
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
