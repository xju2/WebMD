import { createApp } from './app.js';
import { startAutoCommit } from './autocommit.js';
import { newsCategories, startNewsArchive } from './news.js';
import path from 'node:path';
import os from 'node:os';

try {
  process.loadEnvFile(path.join(os.homedir(), '.webmd.conf'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const workspaceRoots = (process.env.WORKSPACE_ROOTS || process.env.WORKSPACE_ROOT || '')
  .split(path.delimiter)
  .filter(Boolean);
const port = Number(process.env.PORT || 3000);
const autoCommitMinutes = Number(process.env.AUTO_COMMIT_MINUTES || 0);

if (!workspaceRoots.length) {
  console.error('WORKSPACE_ROOT or WORKSPACE_ROOTS is required (set in the environment or ~/.webmd.conf).');
  process.exit(1);
}

const cacheDir =
  process.env.WEBMD_CACHE_DIR || path.join(os.homedir(), '.cache', 'webmd');

try {
  const app = await createApp({ workspaceRoots, cacheDir });
  const server = app.listen(port, '127.0.0.1', () => {
    // EADDRINUSE lands just after this callback, so defer and let the error handler win.
    setImmediate(() => console.log(`WebMD listening on http://127.0.0.1:${port}`));
  });

  const autoCommit = startAutoCommit({
    roots: workspaceRoots,
    intervalMs: autoCommitMinutes * 60 * 1000,
    onError: (root, error) =>
      console.error(`Auto-commit failed for ${root}: ${error.message}`)
  });
  if (autoCommitMinutes > 0) {
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
