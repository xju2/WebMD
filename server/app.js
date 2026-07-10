import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiEdit, streamAiChat } from './ai.js';
import { createWorkspace, WorkspaceError } from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

export async function createApp({
  workspaceRoot,
  workspaceRoots,
  aiEnv = process.env,
  aiFetch = fetch
}) {
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

  app.get('/api/workspace/events', asyncHandler(async (req, res) => {
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const subscription = await workspaces
      .get(req.query.root)
      .subscribeEvents(req.query.path, req.query.since, send);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    for (const event of subscription.backlog) send(event);

    const heartbeat = setInterval(() => res.write(':\n\n'), 30000);
    req.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    });
  }));

  app.post('/api/workspace/save', asyncHandler(async (req, res) => {
    res.json(
      await workspaces.get(req.body.root).saveFile(req.body.path, req.body.content)
    );
  }));

  app.post('/api/workspace/updates', asyncHandler(async (req, res) => {
    res.json(
      await workspaces
        .get(req.body.root)
        .applyUpdates(req.body.path, req.body.version, req.body.updates)
    );
  }));

  app.post('/api/ai/chat', asyncHandler(async (req, res) => {
    const workspace = workspaces.get(req.body.root);
    const document = req.body.path
      ? await workspace.loadFile(req.body.path)
      : { content: '' };
    const stream = streamAiChat({
      prompt: req.body.prompt,
      selectedText: req.body.selectedText,
      path: req.body.path,
      documentText: document.content,
      env: aiEnv,
      fetchImpl: aiFetch
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      for await (const text of stream) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({ error: error.message || 'AI request failed.' })}\n\n`
      );
    } finally {
      res.end();
    }
  }));

  app.post('/api/ai/edit', asyncHandler(async (req, res) => {
    const workspace = workspaces.get(req.body.root);
    const document = req.body.path
      ? await workspace.loadFile(req.body.path)
      : { content: '' };

    res.json(
      await createAiEdit({
        instruction: req.body.instruction,
        selectedText: req.body.selectedText,
        path: req.body.path,
        documentText: document.content,
        env: aiEnv,
        fetchImpl: aiFetch
      })
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
