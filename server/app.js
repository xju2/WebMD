import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, WorkspaceError } from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

export async function createApp({ workspaceRoot, workspaceRoots }) {
  const roots = workspaceRoots?.length ? workspaceRoots : [workspaceRoot];
  const workspaces = await createWorkspaceRegistry(roots);
  const app = express();

  app.use(express.json({ limit: '10mb' }));

  app.get('/api/workspace/roots', (_req, res) => {
    res.json(workspaces.options);
  });

  app.get('/api/workspace/tree', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.query.root).readTree());
  }));

  app.get('/api/workspace/load', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.query.root).loadFile(req.query.path));
  }));

  app.get('/api/workspace/search', asyncHandler(async (req, res) => {
    res.json(
      await workspaces.get(req.query.root).searchFiles(req.query.q, {
        limit: req.query.limit
      })
    );
  }));

  app.get('/api/workspace/media', asyncHandler(async (req, res) => {
    const file = await workspaces.get(req.query.root).loadMediaFile(req.query.path);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file.absolute);
  }));

  app.get('/api/workspace/diff', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.query.root).diffFile(req.query.path));
  }));

  app.post('/api/workspace/save', asyncHandler(async (req, res) => {
    res.json(
      await workspaces.get(req.body.root).saveFile(req.body.path, req.body.content)
    );
  }));

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error, _req, res, _next) => {
    const status = error instanceof WorkspaceError ? error.status : 500;
    res.status(status).json({ error: error.message || 'Internal server error' });
  });

  return app;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export async function createWorkspaceRegistry(roots) {
  const workspaces = await Promise.all(roots.map(createWorkspace));
  const byId = new Map(
    workspaces.map((workspace, index) => [String(index), workspace])
  );

  return {
    options: workspaces.map((workspace, index) => ({
      id: String(index),
      name: path.basename(workspace.root) || workspace.root
    })),
    get(id = '0') {
      const workspace = byId.get(String(id));
      if (!workspace) throw new WorkspaceError(400, 'Unknown workspace root.');
      return workspace;
    }
  };
}
