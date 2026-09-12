import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAiCompletion, streamAiChat, streamAiEdit } from './ai.js';
import { fetchArxivMetadata, isArxivId } from './arxiv.js';
import { fetchCitationBibtex } from './citations.js';
import { fetchIndicoTitle, indicoSites, isIndicoUrl } from './indico.js';
import {
  ensureMeetingNote,
  fetchMeeting,
  listMeetings,
  meetingFiles,
  meetingKey,
  meetingNotes,
  publicSource,
  readMeetingsConfig,
  updateMeetingSources
} from './meetings.js';
import { calendarEvents, calendarFeeds } from './gcal.js';
import {
  assertNoSummary,
  buildSummaryMessages,
  insertSummary,
  parseSummary,
  recordingUrl,
  saveTranscript,
  setRecordingField,
  transcriptForModel
} from './transcripts.js';
import { fetchXPost, isXPostUrl } from './x.js';
import {
  fetchArxivNews,
  isNewsDay,
  newsCategories,
  newsDay,
  newsHistory,
  oldestNewsDay,
  readCacheFile,
  readNewsDay,
  writeCacheFile
} from './news.js';
import {
  buildInterestProfile,
  buildRankMessages,
  orderByScore,
  parseRankedPicks,
  profileIsEmpty,
  rankCandidates,
  readNewsInstructions,
  scorePapers
} from './news-rank.js';
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
  calendarFetch = fetch,
  xFetch = fetch,
  newsFetch = fetch,
  // Where day-scoped fetches and model answers outlive a restart. Outside the
  // workspaces so autocommit never picks them up; unset keeps them in memory.
  cacheDir,
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
  // Indico tokens, each bound to one exact origin. Read once, like the rest
  // of the environment; they never leave this process.
  const sites = indicoSites(env);

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
        await fetchIndicoTitle(url.trim(), { fetchImpl: indicoFetch, sites })
      );
    })
  );

  // Google Calendar events for the daily-notes calendar. The feed address is a
  // secret, so only whether one is set reaches the browser.
  const feeds = calendarFeeds(env);
  app.get(
    '/api/calendar/events',
    asyncHandler(async (req, res) => {
      if (!feeds.length) return res.json({ configured: false, events: [], errors: [] });
      const { events, errors } = await calendarEvents(feeds, {
        from: String(req.query.from || ''),
        to: String(req.query.to || ''),
        fetchImpl: calendarFetch,
        refresh: req.query.refresh === '1'
      });
      res.json({ configured: true, events, errors });
    })
  );

  // Meetings: per-workspace Indico sources in .webmd/meetings.json, the
  // upcoming meetings they list, and the note that goes with each. Tokens stay
  // here; the browser only learns whether one is configured.
  async function meetingsState(root) {
    const workspace = workspaces.get(root);
    const config = await readMeetingsConfig(workspace, sites);
    return { workspace, config };
  }

  // By default the view is answered at once, from a copy up to a week old if
  // that is all there is (the answer then says `stale`), and asks again with
  // `fresh=1` for the copy fetched behind it. Refresh skips every cache.
  function meetingFreshness(query) {
    const refresh = query.refresh === '1';
    return { refresh, allowStale: !refresh && query.fresh !== '1' };
  }

  function meetingSourcesBody(config) {
    return {
      noteFolder: config.noteFolder,
      sources: config.sources.map((source) => publicSource(source, sites)),
      warnings: config.warnings
    };
  }

  app.get(
    '/api/meetings',
    asyncHandler(async (req, res) => {
      const { workspace, config } = await meetingsState(req.query.root);
      const listing = await listMeetings(config.sources, {
        sites,
        fetchImpl: indicoFetch,
        cacheDir,
        ...meetingFreshness(req.query)
      });
      const found = meetingFiles(await workspace.markdownFiles());
      res.json({
        ...meetingSourcesBody(config),
        ...listing,
        meetings: listing.meetings.map((meeting) => ({
          ...meeting,
          ...meetingExtras(found.get(meeting.key))
        }))
      });
    })
  );

  app.get(
    '/api/meetings/event',
    asyncHandler(async (req, res) => {
      const { workspace } = await meetingsState(req.query.root);
      const meeting = await fetchMeeting(req.query.origin, req.query.id, {
        sites,
        fetchImpl: indicoFetch,
        cacheDir,
        ...meetingFreshness(req.query)
      });
      const found = meetingFiles(await workspace.markdownFiles());
      res.json({ ...meeting, ...meetingExtras(found.get(meeting.key)) });
    })
  );

  app.post(
    '/api/meetings/sources',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body?.root);
      const config = await updateMeetingSources(
        workspace,
        { add: { url: req.body?.url, label: req.body?.label } },
        sites
      );
      res.json(meetingSourcesBody(config));
    })
  );

  app.delete(
    '/api/meetings/sources',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body?.root);
      const config = await updateMeetingSources(
        workspace,
        { remove: String(req.body?.id ?? '') },
        sites
      );
      res.json(meetingSourcesBody(config));
    })
  );

  // Creates the meeting's note from Indico's own data, fetched here rather
  // than taken from the request, or returns the note that already has it.
  app.post(
    '/api/meetings/note',
    asyncHandler(async (req, res) => {
      const { workspace, config } = await meetingsState(req.body?.root);
      const origin = String(req.body?.origin ?? '');
      const eventId = String(req.body?.id ?? '');
      workspace.forgetFiles();
      const existing = meetingNotes(await workspace.markdownFiles()).get(
        meetingKey(origin, eventId)
      );
      if (existing) {
        res.json({ path: existing, created: false });
        return;
      }
      const meeting = await fetchMeeting(origin, eventId, {
        sites,
        fetchImpl: indicoFetch,
        cacheDir
      });
      res.json(
        await ensureMeetingNote(workspace, meeting, {
          noteFolder: config.noteFolder,
          day: req.body?.day
        })
      );
    })
  );

  // What a meeting has in the workspace, by path: its note, the recording
  // link the note keeps, and its transcript note.
  function meetingExtras(found) {
    return {
      notePath: found?.notePath || '',
      recording: found?.recording || '',
      transcriptPath: found?.transcriptPath || ''
    };
  }

  // The meeting (from Indico, not the request) and its files, with the note
  // created first when there is none: a recording or transcript always has a
  // meeting note to belong to.
  async function meetingWork(body) {
    const { workspace, config } = await meetingsState(body?.root);
    const meeting = await fetchMeeting(
      String(body?.origin ?? ''),
      String(body?.id ?? ''),
      { sites, fetchImpl: indicoFetch, cacheDir }
    );
    workspace.forgetFiles();
    const found = meetingExtras(
      meetingFiles(await workspace.markdownFiles()).get(meeting.key)
    );
    let created = false;
    if (!found.notePath) {
      const note = await ensureMeetingNote(workspace, meeting, {
        noteFolder: config.noteFolder,
        day: body?.day
      });
      found.notePath = note.path;
      created = note.created;
    }
    return { workspace, meeting, found, created };
  }

  app.post(
    '/api/meetings/recording',
    asyncHandler(async (req, res) => {
      const url = recordingUrl(req.body?.url);
      const { workspace, found, created } = await meetingWork(req.body);
      await workspace.editFile(found.notePath, (content) =>
        setRecordingField(content, url)
      );
      res.json({ ...found, recording: url, created });
    })
  );

  app.post(
    '/api/meetings/transcript',
    asyncHandler(async (req, res) => {
      const { workspace, meeting, found, created } = await meetingWork(req.body);
      const saved = await saveTranscript(workspace, meeting, {
        notePath: found.notePath,
        transcriptPath: found.transcriptPath,
        fileName: String(req.body?.name ?? '').slice(0, 200),
        text: req.body?.text
      });
      res.json({
        ...found,
        transcriptPath: saved.path,
        created,
        turns: saved.turns
      });
    })
  );

  // Summarizes the transcript into the meeting note: a Summary section and
  // the action items, which the Tasks view then lists like any other task.
  app.post(
    '/api/meetings/summary',
    asyncHandler(async (req, res) => {
      const { workspace, meeting, found } = await meetingWork(req.body);
      if (!found.transcriptPath) {
        throw new WorkspaceError(400, 'Add the meeting’s transcript first.');
      }
      // Checked before the model is asked, so a refusal costs nothing.
      const note = await workspace.loadFile(found.notePath);
      assertNoSummary(note.content);

      const transcript = transcriptForModel(
        (await workspace.loadFile(found.transcriptPath)).content
      );
      const reply = await runAiCompletion({
        messages: buildSummaryMessages({
          meeting,
          transcript: transcript.text,
          truncated: transcript.truncated
        }),
        env: aiEnv,
        fetchImpl: aiFetch
      });
      const summary = parseSummary(reply);
      const paths = (await workspace.markdownFiles()).map((file) => file.path);
      const link = shortestWikiTarget(found.transcriptPath, found.notePath, paths);
      await workspace.editFile(found.notePath, (content) =>
        insertSummary(content, summary, {
          source: `[[${link}]]${transcript.truncated ? ' (its first part only)' : ''}`
        })
      );
      res.json({
        ...found,
        points: summary.summary.length,
        actions: summary.actions.length,
        truncated: transcript.truncated
      });
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

  // Today's arXiv listing for the News view, or with `day` one kept from the
  // last month. Proxied for the usual reasons: no CORS headers on
  // rss.arxiv.org, and one cached copy for every tab.
  app.get(
    '/api/news/arxiv',
    asyncHandler(async (req, res) => {
      const news = await newsListing(req.query.day, {
        refresh: req.query.refresh === '1'
      });
      res.json({
        ...news,
        day: newsDay(news.published),
        days: await newsHistory(newsCategories(env), { cacheDir })
      });
    })
  );

  async function newsListing(day, { refresh = false } = {}) {
    const categories = newsCategories(env);
    if (!day) {
      return fetchArxivNews(categories, {
        fetchImpl: newsFetch,
        refresh,
        cacheDir
      });
    }
    if (!isNewsDay(day)) {
      throw new WorkspaceError(400, 'The day must be written YYYY-MM-DD.');
    }
    return readNewsDay(categories, day, { cacheDir });
  }

  // One ranking per workspace per listing: a model call reads the whole day's
  // shortlist, so it runs once and every tab, reload, and restart reuses it.
  // Clipping a paper does not reshuffle the page under you; Re-rank asks again.
  // Rankings of earlier days are kept as long as their listings are.
  const newsRankings = new Map();
  const MAX_NEWS_RANKINGS = 64;
  const rankFileWrites = new Map();

  app.post(
    '/api/news/rank',
    asyncHandler(async (req, res) => {
      const workspace = workspaces.get(req.body?.root);
      const news = await newsListing(req.body?.day);
      // Editing the instructions note earns a fresh ranking; clipping a paper
      // (which also feeds the profile) does not.
      const instructions =
        (await readNewsInstructions(workspace)) ||
        String(env.ARXIV_NEWS_INTERESTS ?? '');
      const listing = [
        news.published,
        news.categories,
        sha1(instructions)
      ].join('|');
      const key = `${req.body?.root ?? '0'}|${listing}`;
      if (req.body?.refresh) newsRankings.delete(key);

      let ranking = newsRankings.get(key);
      if (!ranking) {
        const file =
          cacheDir &&
          path.join(cacheDir, 'news-rank', `${sha1(workspace.root)}.json`);
        ranking = (async () => {
          const saved =
            file && !req.body?.refresh ? await readCacheFile(file) : null;
          const hit =
            saved?.rankings?.[listing]?.ranking ??
            (saved?.listing === listing ? saved.ranking : null);
          if (hit) return hit;
          const fresh = await rankNews(workspace, news, instructions);
          // Only a model answer costs anything to redo.
          if (file && fresh.method === 'ai')
            await saveNewsRanking(
              file,
              listing,
              newsDay(news.published),
              fresh
            );
          return fresh;
        })().catch((error) => {
          newsRankings.delete(key);
          throw error;
        });
        newsRankings.set(key, ranking);
        for (const stale of newsRankings.keys()) {
          if (newsRankings.size <= MAX_NEWS_RANKINGS) break;
          newsRankings.delete(stale);
        }
      }
      res.json(await ranking);
    })
  );

  /**
   * Adds one listing's ranking to the workspace's file and drops the days no
   * longer kept. Writes to one file queue up, so two days ranked at once
   * cannot overwrite each other.
   */
  function saveNewsRanking(file, listing, day, ranking) {
    const write = (rankFileWrites.get(file) ?? Promise.resolve()).then(
      async () => {
        const saved = (await readCacheFile(file)) || {};
        const rankings = saved.rankings ?? {};
        const oldest = oldestNewsDay();
        for (const [kept, entry] of Object.entries(rankings)) {
          if (!(entry?.day >= oldest)) delete rankings[kept];
        }
        rankings[listing] = { day, ranking };
        await writeCacheFile(file, { rankings });
      }
    );
    rankFileWrites.set(
      file,
      write.catch(() => {})
    );
    return write;
  }

  async function rankNews(workspace, news, instructions) {
    const profile = buildInterestProfile({
      files: await workspace.markdownFiles(),
      references: await workspace.references(),
      interests: instructions
    });
    const scores = scorePapers(news.papers, profile);
    const base = { published: news.published, picks: [] };
    if (profileIsEmpty(profile)) {
      return {
        ...base,
        order: news.papers.map((paper) => paper.id),
        method: 'none',
        warning:
          'Nothing to rank against yet. Write your ranking instructions, or clip a few papers.'
      };
    }

    const lexical = orderByScore(news.papers, scores).map((paper) => paper.id);
    // Updates are hidden by default and were judged when they first came out.
    const candidates = rankCandidates(
      news.papers.filter((paper) => !/^replace/.test(paper.announceType)),
      scores
    );
    if (!candidates.length)
      return { ...base, order: lexical, method: 'similarity' };

    let picks;
    try {
      const reply = await runAiCompletion({
        messages: buildRankMessages(profile, candidates),
        env: aiEnv,
        fetchImpl: aiFetch
      });
      picks = parseRankedPicks(reply, candidates);
    } catch (error) {
      return {
        ...base,
        order: lexical,
        method: 'similarity',
        warning: `AI ranking failed, so papers are ordered by how closely they match your notes. ${error.message}`
      };
    }

    const picked = new Set(picks.map((pick) => pick.id));
    return {
      ...base,
      picks,
      order: [
        ...picks.map((pick) => pick.id),
        ...lexical.filter((id) => !picked.has(id))
      ],
      method: 'ai'
    };
  }

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
    res.status(status).json({
      error: error.message || 'Internal server error',
      // Indico failures say what kind they are (auth, network, ...).
      ...(error.kind ? { kind: error.kind } : {})
    });
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

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
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
