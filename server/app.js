import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamAiChat, streamAiEdit } from './ai.js';
import { fetchArxivMetadata, isArxivId } from './arxiv.js';
import { listPresets, publicPresets, resolvePreset } from './prompts.js';
import { readDailyBrief } from './daily-brief.js';
import { createWorkspace, WorkspaceError } from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

export async function createApp({
  workspaceRoot,
  workspaceRoots,
  aiEnv = process.env,
  aiFetch = fetch,
  arxivFetch = fetch
}) {
  const roots = workspaceRoots?.length ? workspaceRoots : [workspaceRoot];
  const workspaces = await createWorkspaceRegistry(roots);
  const app = express();

  app.use(express.json({ limit: '100mb' }));

  app.get('/api/workspace/roots', (_req, res) => {
    res.json(workspaces.options);
  });

  app.get('/api/workspace/overview', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.query.root).overview());
  }));

  app.get('/api/workspace/graph', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.query.root).graph());
  }));

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

  app.get('/api/workspace/daily-brief', asyncHandler(async (req, res) => {
    res.json(await readDailyBrief(workspaces.get(req.query.root)));
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

  app.post('/api/workspace/folders', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.body.root).createFolder(req.body.path));
  }));

  app.post('/api/workspace/images', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.body.root).saveMediaFile(req.body));
  }));

  app.post('/api/workspace/files', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.body.root).saveMediaFile(req.body));
  }));

  app.delete('/api/workspace/files', asyncHandler(async (req, res) => {
    res.json(await workspaces.get(req.body.root).deleteFile(req.body.path));
  }));

  app.post('/api/workspace/updates', asyncHandler(async (req, res) => {
    res.json(
      await workspaces
        .get(req.body.root)
        .applyUpdates(req.body.path, req.body.version, req.body.updates)
    );
  }));

  // Proxied because export.arxiv.org sends no CORS headers, and so lookups share
  // one cache and one rate limit across browser tabs. Workspace-independent.
  app.get('/api/arxiv', asyncHandler(async (req, res) => {
    const id = req.query.id;
    if (!isArxivId(id)) {
      throw new WorkspaceError(400, 'An arXiv identifier is required.');
    }
    res.json(await fetchArxivMetadata(id.trim(), { fetchImpl: arxivFetch }));
  }));

  app.get('/api/ai/presets', asyncHandler(async (req, res) => {
    const { presets, warning } = await listPresets(workspaces.get(req.query.root));
    // System prompts stay server-side, like provider credentials.
    res.json({ presets: publicPresets(presets), warning });
  }));

  app.post('/api/ai/chat', asyncHandler(async (req, res) => {
    const workspace = workspaces.get(req.body.root);
    const document = req.body.path
      ? await workspace.loadFile(req.body.path)
      : { content: '' };

    await streamSse(
      res,
      chatEvents(
        streamAiChat({
          prompt: req.body.prompt,
          selectedText: req.body.selectedText,
          path: req.body.path,
          documentText: document.content,
          env: aiEnv,
          fetchImpl: aiFetch
        })
      )
    );
  }));

  app.post('/api/ai/edit', asyncHandler(async (req, res) => {
    const workspace = workspaces.get(req.body.root);
    // Resolve the preset before streaming starts: once SSE headers are out, a
    // bad request can only be reported as an error event, not a 400.
    const preset = req.body.presetId
      ? await resolvePreset(workspace, req.body.presetId)
      : null;
    const instruction = editInstruction(preset, req.body.instruction);
    if (!instruction) {
      throw new WorkspaceError(400, 'A prompt preset or an edit instruction is required.');
    }
    if (typeof req.body.selectedText !== 'string' || !req.body.selectedText.length) {
      throw new WorkspaceError(400, 'Selected text is required for AI edits.');
    }

    const document = req.body.path
      ? await workspace.loadFile(req.body.path)
      : { content: '' };

    await streamSse(
      res,
      streamAiEdit({
        instruction,
        system: preset?.system,
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

/**
 * Pipes an async generator to the client as SSE. Errors arrive as a final
 * `error` event because the status line is long gone by the time a provider
 * fails mid-stream.
 */
async function streamSse(res, events) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    for await (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    res.write(
      `data: ${JSON.stringify({ error: error.message || 'AI request failed.' })}\n\n`
    );
  } finally {
    res.end();
  }
}

async function* chatEvents(stream) {
  for await (const text of stream) yield { text };
  yield { done: true };
}

/** A preset supplies the instruction; a typed note refines it. Either alone works. */
function editInstruction(preset, typed) {
  const extra = typeof typed === 'string' ? typed.trim() : '';
  if (!preset) return extra;
  if (!extra) return preset.instruction;
  return `${preset.instruction}\n\nAlso apply this instruction: ${extra}`;
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
