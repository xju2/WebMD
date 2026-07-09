import { createApp } from './app.js';
import path from 'node:path';

const workspaceRoots = (process.env.WORKSPACE_ROOTS || process.env.WORKSPACE_ROOT || '')
  .split(path.delimiter)
  .filter(Boolean);
const port = Number(process.env.PORT || 3000);

if (!workspaceRoots.length) {
  console.error('WORKSPACE_ROOT or WORKSPACE_ROOTS is required.');
  process.exit(1);
}

try {
  const app = await createApp({ workspaceRoots });
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`WebMD listening on http://127.0.0.1:${port}`);
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
