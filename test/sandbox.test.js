import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { prepareSandbox, sandboxDir, SANDBOX_SOURCE } from '../server/sandbox.js';

async function tempDir() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-sandbox-'));
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('puts the sandbox under the user data folder unless told otherwise', () => {
  assert.equal(
    sandboxDir({}, '/home/ada'),
    '/home/ada/.local/share/webmd/sandbox'
  );
  assert.equal(sandboxDir({ WEBMD_SANDBOX_DIR: '/tmp/box' }, '/home/ada'), '/tmp/box');
});

test('copies the example workspace once and keeps later edits', async () => {
  const dir = path.join(await tempDir(), 'nested', 'sandbox');

  assert.deepEqual(await prepareSandbox(dir), { dir, created: true });
  const welcome = path.join(dir, 'Welcome.md');
  assert.match(await fs.readFile(welcome, 'utf8'), /^# Welcome/);
  await fs.access(path.join(dir, '.webmd', 'settings.json'));

  await fs.writeFile(welcome, '# Mine\n');
  assert.deepEqual(await prepareSandbox(dir), { dir, created: false });
  assert.equal(await fs.readFile(welcome, 'utf8'), '# Mine\n');
  assert.deepEqual(await fs.readdir(path.dirname(dir)), ['sandbox']);
});

test('the example workspace links only to notes it has, bar the one it means to miss', async () => {
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [SANDBOX_SOURCE], env: {} })
  );

  try {
    const graph = await (await fetch(`${url}/api/workspace/graph`)).json();
    assert.deepEqual(
      graph.broken.map((link) => link.target),
      ['Seed catalogue']
    );

    const settings = await (await fetch(`${url}/api/settings`)).json();
    assert.equal(settings.warning, undefined);
    assert.equal(settings.dailyNoteFolder, '/daily');
    await fs.access(path.join(SANDBOX_SOURCE, settings.dailyNoteTemplate));

    const presets = await (await fetch(`${url}/api/ai/presets`)).json();
    assert.equal(presets.warning, undefined);
    assert.ok(presets.presets.some((preset) => preset.id === 'plain-english'));
  } finally {
    server.close();
  }
});

test('serves images from a sandbox kept inside a dot folder', async () => {
  const dir = path.join(await tempDir(), '.local', 'sandbox');
  await prepareSandbox(dir);
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [dir], env: {} })
  );

  try {
    const response = await fetch(
      `${url}/api/workspace/media?path=${encodeURIComponent('/assets/garden-beds.svg')}`
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  } finally {
    server.close();
  }
});
