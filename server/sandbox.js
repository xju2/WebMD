import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pristine example workspace shipped with WebMD. It is only ever copied,
// never served: edits would dirty the WebMD checkout, and auto-commit would
// find WebMD's own repository above it and sweep that instead.
export const SANDBOX_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'sandbox'
);

export function sandboxDir(env = process.env, home = os.homedir()) {
  return (
    env.WEBMD_SANDBOX_DIR ||
    path.join(home, '.local', 'share', 'webmd', 'sandbox')
  );
}

/**
 * Copies the example workspace to `dir` the first time, and leaves an existing
 * copy alone so edits made in the sandbox survive a restart. Deleting the copy
 * is how to start over. The copy goes to a sibling first and is renamed into
 * place, so an interrupted first run never leaves half a sandbox behind.
 */
export async function prepareSandbox(dir, { source = SANDBOX_SOURCE } = {}) {
  try {
    await fs.access(dir);
    return { dir, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });
  const staging = await fs.mkdtemp(`${dir}-`);
  try {
    await fs.cp(source, staging, { recursive: true });
    await fs.rename(staging, dir);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { dir, created: true };
}
