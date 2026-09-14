import { createApp } from './app.js';
import { startAutoCommit } from './autocommit.js';
import { newsCategories, startNewsArchive } from './news.js';
import { prepareSandbox, sandboxDir } from './sandbox.js';
import path from 'node:path';
import os from 'node:os';

try {
  process.loadEnvFile(path.join(os.homedir(), '.webmd.conf'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const configuredRoots = (process.env.WORKSPACE_ROOTS || process.env.WORKSPACE_ROOT || '')
  .split(path.delimiter)
  .filter(Boolean);
const port = Number(process.env.PORT || 3000);
const autoCommitMinutes = Number(process.env.AUTO_COMMIT_MINUTES || 0);

// With no workspace configured, open a copy of the example workspace so a new
// user has something to try WebMD on.
let workspaceRoots = configuredRoots;
if (!configuredRoots.length) {
  try {
    const { dir, created } = await prepareSandbox(sandboxDir());
    workspaceRoots = [dir];
    console.log(
      `No WORKSPACE_ROOT set, so opening the sandbox ${created ? 'just created ' : ''}at ${dir}.`
    );
    console.log('Set WORKSPACE_ROOT in the environment or ~/.webmd.conf to open your own notes.');
  } catch (error) {
    console.error(`Could not prepare the sandbox: ${error.message}`);
    console.error('Set WORKSPACE_ROOT in the environment or ~/.webmd.conf.');
    process.exit(1);
  }
}

const cacheDir =
  process.env.WEBMD_CACHE_DIR || path.join(os.homedir(), '.cache', 'webmd');

try {
  const app = await createApp({ workspaceRoots, cacheDir });
  const server = app.listen(port, '127.0.0.1', () => {
    // EADDRINUSE lands just after this callback, so defer and let the error handler win.
    setImmediate(() => console.log(`WebMD listening on http://127.0.0.1:${port}`));
  });

  // Only the user's own workspaces: the sandbox is scratch space, and the
  // folder it sits in may belong to someone else's repository.
  const autoCommit = startAutoCommit({
    roots: configuredRoots,
    intervalMs: autoCommitMinutes * 60 * 1000,
    onError: (root, error) =>
      console.error(`Auto-commit failed for ${root}: ${error.message}`)
  });
  if (autoCommitMinutes > 0 && configuredRoots.length) {
    console.log(`Auto-committing every ${autoCommitMinutes} min.`);
  }

  // Keeps a month of arXiv listings even on days News is never opened.
  const newsArchive = startNewsArchive({
    categories: newsCategories(),
    cacheDir,
    onError: (error) =>
      console.warn(`Could not check the arXiv feed: ${error.message}`)
  });

  // listen() reports failures as an async event, so the try/catch never sees them.
  server.on('error', (error) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the running WebMD server, or set PORT in the environment or ~/.webmd.conf.`
        : error.message
    );
    process.exit(1);
  });

  // One last snapshot on the way out, so stopping the server does not strand
  // the edits made since the previous tick.
  process.on('SIGTERM', async () => {
    autoCommit.stop();
    newsArchive.stop();
    await autoCommit.runOnce();
    server.close(() => process.exit(0));
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
