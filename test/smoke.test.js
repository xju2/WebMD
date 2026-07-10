import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-smoke-'));
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForJson(url, child, stderr) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode != null) {
      throw new Error(`server exited early: ${stderr.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Retry until the server has started listening.
    }
    await delay(50);
  }
  throw new Error(`server did not start: ${stderr.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
}

test('server process starts against a temp workspace', async () => {
  const root = await tempRoot();
  const port = await freePort();
  await fs.writeFile(path.join(root, 'note.md'), '# Smoke\n');

  const stderr = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKSPACE_ROOT: root,
      WORKSPACE_ROOTS: '',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const roots = await waitForJson(
      `http://127.0.0.1:${port}/api/workspace/roots`,
      child,
      stderr
    );
    assert.equal(roots[0].name, path.basename(root));

    const tree = await waitForJson(
      `http://127.0.0.1:${port}/api/workspace/tree`,
      child,
      stderr
    );
    assert.equal(tree[0].path, '/note.md');
  } finally {
    await stopChild(child);
  }
});
