import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAiCompletion, streamAiChat, streamAiEdit } from './ai.js';
import { fetchArxivMetadata, isArxivId } from './arxiv.js';
import { fetchCitationBibtex } from './citations.js';
import { fetchIndicoTitle, indicoTokens, isIndicoUrl } from './indico.js';
import { fetchXPost, isXPostUrl } from './x.js';
import { fetchArxivNews, newsCategories } from './news.js';
import { listPresets, publicPresets, resolvePreset } from './prompts.js';
import {
  appendQuoteHistory,
  buildQuoteMessages,
  formatQuote,
  isRepeatQuote,
  parseQuote,
  quoteDayKey,
  quoteTheme,
  quoteThemes,
  readQuoteHistory,
  writeQuoteHistory
} from './quote.js';
import {
  buildRelatedMessages,
  parseRelatedSuggestions,
  rankRelatedCandidates
} from './related.js';
import { shortestWikiTarget } from '../src/related-links.js';
import {
  createWorkspace,
  normalizeWorkspaceFolder,
  WorkspaceError
} from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

export async function createApp({
  workspaceRoot,
  workspaceRoots,
  aiEnv = process.env,
  aiFetch = fetch,
  arxivFetch = fetch,
  citationFetch = fetch,
  indicoFetch = fetch,
  xFetch = fetch,
  newsFetch = fetch,
  env = process.env
}) {
  const roots = workspaceRoots?.length ? workspaceRoots : [workspaceRoot];
  const workspaces = await createWorkspaceRegistry(roots);
  const app = express();

  app.use(express.json({ limit: '100mb' }));

  // Workspace-wide settings the client cannot pick for itself. Configured in
  // the environment or ~/.webmd.conf so the UI does not have to spend toolbar
  // space on a control that is set once and then forgotten.
  const imageAssetFolder = normalizeWorkspaceFolder(
    env.IMAGE_ASSET_FOLDER || '/assets'
  );

  app.get('/api/settings', (_req, res) => {
    res.json({ imageAssetFolder });
  });

  app.get('/api/workspace/roots', (_req, res) => {
    res.json(workspaces.options);
  });

  app.get(
    '/api/workspace/overview',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).overview());
    })
  );

  app.get(
    '/api/workspace/graph',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).graph());
    })
  );

  app.get(
    '/api/workspace/references',
    asyncHandler(async (req, res) => {
      res.json({ entries: await workspaces.get(req.query.root).references() });
    })
  );

  app.post(
    '/api/workspace/citations',
    asyncHandler(async (req, res) => {
      const citation = await fetchCitationBibtex(req.body?.source, {
        fetchImpl: citationFetch
      });
      res.json(
        await workspaces.get(req.body?.root).addReference(citation.bibtex)
      );
    })
  );

  app.get(
    '/api/workspace/backlinks',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).backlinks(req.query.path));
    })
  );

  app.get(
    '/api/workspace/tree',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).readTree());
    })
  );

  app.get(
    '/api/workspace/load',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).loadFile(req.query.path));
    })
  );

  app.get(
    '/api/workspace/tasks',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces.get(req.query.root).listTasks({
          includeDone: req.query.include === 'all',
          limit: req.query.limit
        })
      );
    })
  );

  app.get(
    '/api/workspace/search',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces.get(req.query.root).searchFiles(req.query.q, {
          limit: req.query.limit
        })
      );
    })
  );

  app.get(
    '/api/workspace/media',
    asyncHandler(async (req, res) => {
      const file = await workspaces
        .get(req.query.root)
        .loadMediaFile(req.query.path);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(file.absolute);
    })
  );

  app.get(
    '/api/workspace/diff',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.query.root).diffFile(req.query.path));
    })
  );

  app.get(
    '/api/workspace/events',
    asyncHandler(async (req, res) => {
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
    })
  );

  app.post(
    '/api/workspace/save',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces
          .get(req.body.root)
          .saveFile(req.body.path, req.body.content)
      );
    })
  );

  app.post(
    '/api/workspace/folders',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.body.root).createFolder(req.body.path));
    })
  );

  app.post(
    '/api/workspace/images',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.body.root).saveMediaFile(req.body));
    })
  );

  app.post(
    '/api/workspace/files',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.body.root).saveMediaFile(req.body));
    })
  );

  app.post(
    '/api/workspace/rename',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces
          .get(req.body.root)
          .renameFile(req.body.from, req.body.to)
      );
    })
  );

  app.delete(
    '/api/workspace/files',
    asyncHandler(async (req, res) => {
      res.json(await workspaces.get(req.body.root).deleteFile(req.body.path));
    })
  );

  app.post(
    '/api/workspace/updates',
    asyncHandler(async (req, res) => {
      res.json(
        await workspaces
          .get(req.body.root)
          .applyUpdates(req.body.path, req.body.version, req.body.updates)
      );
    })
  );

  // Proxied because export.arxiv.org sends no CORS headers, and so lookups share
  // one cache and one rate limit across browser tabs. Workspace-independent.
  app.get(
    '/api/arxiv',
    asyncHandler(async (req, res) => {
      const id = req.query.id;
      if (!isArxivId(id)) {
        throw new WorkspaceError(400, 'An arXiv identifier is required.');
      }
      res.json(await fetchArxivMetadata(id.trim(), { fetchImpl: arxivFetch }));
    })
  );

  // Proxied for the same reasons as arXiv: no CORS headers on indico.cern.ch,
  // and one shared cache for pages every tab pastes.
  app.get(
    '/api/indico',
    asyncHandler(async (req, res) => {
      const url = req.query.url;
      if (!isIndicoUrl(url)) {
        throw new WorkspaceError(400, 'An Indico event link is required.');
      }
      res.json(
        await fetchIndicoTitle(url.trim(), {
          fetchImpl: indicoFetch,
          tokens: indicoTokens(env)
        })
      );
    })
  );

  // Proxied because publish.x.com sends no CORS headers, and so one cache
  // answers for every tab that pastes the same post.
  app.get(
    '/api/x',
    asyncHandler(async (req, res) => {
      const url = req.query.url;
      if (!isXPostUrl(url)) {
        throw new WorkspaceError(400, 'An X post link is required.');
      }
      res.json(await fetchXPost(url.trim(), { fetchImpl: xFetch }));
    })
  );

  // Today's arXiv listing for the News view. Proxied for the usual reasons: no
  // CORS headers on rss.arxiv.org, and one cached copy for every tab.
  app.get(
    '/api/news/arxiv',
    asyncHandler(async (req, res) => {
      res.json(
        await fetchArxivNews(newsCategories(env), {
          fetchImpl: newsFetch,
          refresh: req.query.refresh === '1'
        })
      );
    })
  );

  app.get(
    '/api/ai/presets',
    asyncHandler(async (req, res) => {
      const { presets, warning } = await listPresets(
        workspaces.get(req.query.root)
      );
      // System prompts stay server-side, like provider credentials.
      res.json({ presets: publicPresets(presets), warning });
    })
  );

  app.post(
    '/api/ai/chat',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body.root);
      // Resolve the preset before streaming starts: once SSE headers are out, a
      // bad request can only be reported as an error event, not a 400.
      const preset = req.body.presetId
        ? await resolvePreset(workspace, req.body.presetId, 'chat')
        : null;
      const prompt = chatPrompt(preset, req.body.prompt);
      if (!prompt) {
        throw new WorkspaceError(
          400,
          'A prompt preset or a question is required.'
        );
      }

      const document = req.body.path
        ? await workspace.loadFile(req.body.path)
        : { content: '' };

      await streamSse(
        res,
        chatEvents(
          streamAiChat({
            prompt,
            system: preset?.system,
            selectedText: req.body.selectedText,
            path: req.body.path,
            documentText: document.content,
            env: aiEnv,
            fetchImpl: aiFetch
          })
        )
      );
    })
  );

  app.post(
    '/api/ai/edit',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body.root);
      // Resolve the preset before streaming starts: once SSE headers are out, a
      // bad request can only be reported as an error event, not a 400.
      const preset = req.body.presetId
        ? await resolvePreset(workspace, req.body.presetId, 'edit')
        : null;
      const instruction = editInstruction(preset, req.body.instruction);
      if (!instruction) {
        throw new WorkspaceError(
          400,
          'A prompt preset or an edit instruction is required.'
        );
      }
      if (
        typeof req.body.selectedText !== 'string' ||
        !req.body.selectedText.length
      ) {
        throw new WorkspaceError(
          400,
          'Selected text is required for AI edits.'
        );
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
    })
  );

  app.post(
    '/api/ai/related',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body.root);
      const notePath = req.body.path;
      if (typeof notePath !== 'string' || !notePath) {
        throw new WorkspaceError(400, 'A note path is required.');
      }

      const note = await workspace.loadFile(notePath);
      const files = await workspace.markdownFiles();
      const candidates = rankRelatedCandidates(files, note);
      if (!candidates.length) {
        // Nothing to choose from, so there is no point spending a model call.
        res.json({
          suggestions: [],
          candidateCount: 0,
          warning:
            'No other note in this workspace shares enough wording to compare.'
        });
        return;
      }

      const reply = await runAiCompletion({
        messages: buildRelatedMessages(note, candidates),
        env: aiEnv,
        fetchImpl: aiFetch
      });
      const { suggestions, warning } = parseRelatedSuggestions(
        reply,
        candidates
      );
      const paths = files.map((file) => file.path);

      res.json({
        // Each link is written in the shortest form that resolves back to the
        // note it names, so an accepted suggestion can never be a dead link.
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          target: shortestWikiTarget(suggestion.path, note.path, paths, {
            dailyNoteFolder: req.body.dailyNoteFolder
          })
        })),
        candidateCount: candidates.length,
        warning
      });
    })
  );

  app.post(
    '/api/ai/quote',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body.root);
      const date = quoteDate(req.body.date);
      const day = quoteDayKey(date);
      const history = await readQuoteHistory(workspace);

      // A note recreated later the same day keeps the quote it opened with, and
      // costs no second model call.
      const existing = history.find((entry) => entry.date === day);
      if (existing) {
        res.json({ quote: formatQuote(existing), cached: true });
        return;
      }

      const theme = quoteTheme(date, quoteThemes(aiEnv));
      let quote = null;
      for (const avoidRepeat of [false, true]) {
        const reply = await runAiCompletion({
          messages: buildQuoteMessages({ date, theme, history, avoidRepeat }),
          env: aiEnv,
          fetchImpl: aiFetch
        });
        quote = parseQuote(reply);
        if (quote && !isRepeatQuote(quote, history)) break;
      }
      if (!quote)
        throw new WorkspaceError(502, 'The model did not return a quote.');

      await writeQuoteHistory(
        workspace,
        appendQuoteHistory(history, { date: day, ...quote })
      );
      res.json({ quote: formatQuote(quote), theme });
    })
  );

  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error, _req, res, _next) => {
    const status = error instanceof WorkspaceError ? error.status : 500;
    res
      .status(status)
      .json({ error: error.message || 'Internal server error' });
  });

  return app;
}

// The client sends the daily note's own date as YYYY-MM-DD, which must be read
// as a local calendar day rather than as UTC midnight.
function quoteDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!parts) return new Date();
  const date = new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3])
  );
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function asyncHandler(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
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

/** Same deal for chat: the preset asks the question, typed text narrows it. */
function chatPrompt(preset, typed) {
  const extra = typeof typed === 'string' ? typed.trim() : '';
  if (!preset) return extra;
  if (!extra) return preset.instruction;
  return `${preset.instruction}\n\nFocus on this in particular: ${extra}`;
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
