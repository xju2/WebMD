# Plans.md

## Goal

Ship a remote-first, AI-native Markdown workspace that runs on a target server, binds only to `127.0.0.1`, serves a browser UI over an SSH tunnel, edits Markdown with CodeMirror, and keeps files inside `$WORKSPACE_ROOT`.

## Ground Rules

- Build the boring path first: tree, load, edit, save.
- Keep SSH tunnel isolation as the only auth layer for now.
- Never allow paths or symlinks to resolve outside `$WORKSPACE_ROOT`.
- Use whole-file saves for MVP and recovery; use collaborative CM6 updates for active multi-user editing.
- Keep git diff support server-side and raw: validate the note path, run `git diff`, show unified output.
- Keep AI provider keys server-side. Support local Ollama and remote API providers.
- Show inline AI edits as a diff before applying them.

## Current Status

- Done: Vite/Svelte frontend, Express backend bound to `127.0.0.1`, multi-root workspaces, safe file APIs, atomic saves, CodeMirror editing, failed-save `sessionStorage` recovery, workspace search, Markdown preview, media preview, daily-note calendar, wiki links, raw git diff preview, MVP collaborative editing, and streamed AI chat.
- Collaborative editing now uses server-owned document versions, CM6 `ChangeSet` updates through `POST /api/workspace/updates`, atomic disk snapshots, SSE update replay through `GET /api/workspace/events`, and client-side rebasing for pending local edits.
- AI chat keeps provider keys server-side, streams from Ollama or OpenAI-compatible Responses providers, and sends active document or selected-text context from the workspace.
- Inline AI diff edits now request replacement text server-side, show a diff
  preview in the editor, and apply accepted edits through the CodeMirror update
  path.
- Hardening added SSH tunnel startup docs, clearer server-unavailable errors,
  and a smoke test that starts the real server against a temporary workspace.
- Prompt presets let a selection be rewritten from a named prompt for paper,
  email, or note writing. Built-in presets ship with the server and
  `$WORKSPACE_ROOT/.webmd/prompts.json` overrides or extends them by id.
  `POST /api/ai/edit` now streams so long rewrites show progress.
- Meetings (milestone 11) follows Indico categories and events, including
  protected ones through a server-side token bound to one exact origin, and
  ties each meeting to a Markdown note.
- Meetings and Zoom (milestone 12) adds Join for Zoom meetings, keeps the past
  week listed, and attaches a recording link and transcript to a meeting, with
  an AI summary and action items written into its note.
- No remaining planned implementation items.

## Milestones

### 1. Project Skeleton

Status: Done.

Tasks:
- Create a Vite + Svelte 5 frontend.
- Create a Node.js + Express backend.
- Add shared dev scripts for frontend, backend, and combined local development.
- Add basic formatting, linting, and a minimal test runner.
- Document required env vars: `WORKSPACE_ROOT`, `PORT`, AI provider settings.

Done when:
- `npm run dev` starts the app locally.
- Server refuses to start without `WORKSPACE_ROOT`.
- Server binds to `127.0.0.1` only.

### 2. Workspace File API

Status: Done.

Tasks:
- Implement canonical path resolution.
- Reject traversal and symlink escapes.
- Implement `GET /api/workspace/tree`.
- Implement `GET /api/workspace/load`.
- Implement `POST /api/workspace/save` with temp-file-then-rename atomic writes.
- Add focused tests for path validation and atomic save behavior.

Done when:
- Markdown files can be listed, opened, edited, and saved.
- Attempts to read outside `$WORKSPACE_ROOT` fail.

### 3. Editor MVP

Status: Done.

Tasks:
- Build the main app layout: sidebar, editor pane, status area.
- Wire sidebar tree selection to document loading.
- Add CodeMirror 6 Markdown editing.
- Track selected text for AI context.
- Add debounced fallback saves.
- Add `[Saved]`, `[Syncing...]`, and `[Offline - Retrying]` status states.
- Buffer unsaved edits in `sessionStorage` only after failed network saves, then purge after successful resync.

Done when:
- A user can edit notes through the SSH tunnel without visible typing lag.
- Network failure does not silently lose unsaved text.

### 3.5 Git Diff Preview

Status: Done.

Tasks:
- Add `GET /api/workspace/diff` for the selected Markdown file.
- Run `git diff -- <file>` from the selected workspace root after existing path validation.
- Add a `Diff` button that saves pending edits, fetches the diff, and shows raw unified output in a read-only pane.

Done when:
- A changed tracked note can show its git diff from the editor without leaving the browser.
- Non-git workspaces report the git error instead of pretending there are changes.

### 4. Collaborative Editing

Status: Done.

Tasks:
- [x] Add server-owned document versions.
- [x] Implement `POST /api/workspace/updates`.
- [x] Implement `GET /api/workspace/events` using SSE.
- [x] Store per-document update logs in memory for active sessions.
- [x] Snapshot collaborative state back to disk with atomic writes.
- [x] Rebase pending local CM6 updates against remote updates.

Done when:
- Two browser sessions can edit the same file and see each other's changes without last-write-wins overwrite.
- Reloading the document preserves the merged result from disk.

### 5. AI Chat

Status: Done.

Tasks:
- [x] Add AI provider configuration for Ollama and remote API providers.
- [x] Implement `POST /api/ai/chat` as an SSE stream.
- [x] Send selected text, active document path, and prompt text to the server.
- [x] Keep provider secrets out of the browser.
- [x] Render streamed chat output in the sidebar.

Done when:
- The user can highlight text, ask a question, and receive streamed AI output.
- Switching providers does not require frontend code changes.

### 6. Inline AI Diff Edits

Status: Done.

Tasks:
- [x] Add an inline edit command using the current selection.
- [x] Ask the AI provider for replacement text.
- [x] Render a diff preview against the selected text.
- [x] Add accept and reject actions.
- [x] Apply accepted edits through the same editor update path as manual typing.

Done when:
- AI never mutates the document without user approval.
- Accepted AI edits participate in save and collaboration flow.

### 7. Hardening

Status: Done.

Tasks:
- [x] Add user-facing error states for unavailable server, failed saves, invalid paths, and AI failures.
- [x] Add browser checks for desktop and mobile layouts.
- [x] Add docs for SSH tunnel startup.
- [x] Add a minimal smoke test that starts the server against a temp workspace.

Done when:
- A fresh clone can run the app using the documented commands.
- Core file safety, save, collaboration, and AI flows have one runnable check each.

### 8. Prompt Presets

Status: Done.

Tasks:
- [x] Ship built-in rewrite presets grouped for paper, email, and note writing.
- [x] Let `$WORKSPACE_ROOT/.webmd/prompts.json` override built-ins by id and add new presets.
- [x] Add `GET /api/ai/presets`, keeping system prompts server-side.
- [x] Stream `POST /api/ai/edit` so long rewrites fill the diff preview live.
- [x] Add a preset list to the AI panel. AI controls stay in the panel so the
      editing surface stays free of floating overlays.

Done when:
- A selection can be rewritten from a named prompt without typing an instruction.
- A user's own presets survive a server restart and travel with the workspace.
- A malformed preset file degrades to the built-ins with a visible warning.

### 9. Quiet Workspace Visual Redesign

Status: Stage 1 done (visual and local presentation only). Stage 2 is
milestone 10.

Goal: a lighter, calmer research workspace. Light neutral surfaces, readable
dark text, hairline separators, and restrained teal accents replace the dark
rail, boxed controls, and heavy borders. Design decisions live in
`ARCHITECTURE.md` under "Visual Design System".

Tasks:
- [x] Baseline: `npm test`, `npm run lint`, `npm run build`, and desktop plus
      narrow screenshots against a local fixture workspace.
- [x] Shared design tokens in `src/styles.css` `:root` (surfaces, ink, borders,
      teal accent, radii, control heights, focus ring) and a global
      `:focus-visible` ring; hardcoded chrome colours move onto the tokens.
- [x] Light ~52px tool rail: outline icons, unboxed inactive buttons, pale teal
      active tile, CSS tooltips that also show on keyboard focus.
- [x] Quieter file sidebar: no large WebMD heading, compact workspace select,
      full-width search, folder/file icons with chevrons, muted counts, soft
      selected-file highlight.
- [x] View-aware toolbar: document actions only in document views (Home,
      editor, preview, diff, graph); Tasks, Calendar, and arXiv News show
      navigation, their title, and the overflow menu.
- [x] arXiv cards: title, author line, categories, relevance line, and abstract
      as distinct layers; top picks get a quiet teal edge. Clip, More/Less,
      filters, ranking, Re-rank, Refresh, and Instructions unchanged.
- [x] Editor, preview, calendar, tasks, dialogs, menus, and AI panel restyled
      on the same tokens.

Done when:
- No document control appears in arXiv News, Tasks, or Calendar.
- Body text and controls meet WCAG AA contrast on their surfaces.
- Tests, lint, and build match the baseline.

### 10. Files Left, AI Right: Panel Layout

Status: Done.

Goal: the Quiet Workspace shell becomes rail | file sidebar | center | AI
panel. Both side panels collapse and resize independently; opening or closing
either never recreates the editor, loses unsaved text, or drops the AI thread.
Layout decisions live in `ARCHITECTURE.md` under "Panel Layout".

Tasks:
- [x] Layout model in `src/layout.js`: persisted preferences (open flags and
      widths) apart from transient overlay state; pure `resolveLayout` decides
      docked, overlay, or hidden per panel from the viewport width.
- [x] File sidebar: collapse button, drag and keyboard resize handle
      (double-click resets), compact New plus a "More file actions" menu (Sync,
      Show current file, Collapse or expand all folders), and a save status
      footer that never says saved while work is pending or failed.
- [x] AI panel on the right with its own header, collapse, resize, and a
      "Hide Markdown" expand toggle; it opens from the rail independently of
      the sidebar and the current view.
- [x] Context indicator in the composer from `src/ai-context.js`: the chip
      and the request payload come from one object, so the label cannot claim
      context that is not sent.
- [x] Narrow screens (≤760px): panels become overlays with a backdrop, an
      inert workspace, Escape to close, and focus returned to where it was.
      Temporary collapse never overwrites the desktop preference.
- [x] Document toolbar keeps only Day and Edit/Preview; Upload, Delete (red),
      and Reference always live in the ... menu.
- [x] Fix: the editor's active-line wash hid the selection highlight.
- [x] `npm run fixture` (seeded workspace, stub AI and arXiv) and
      `npm run scenarios` (headless Chrome acceptance checks at five widths).

Done when:
- Edit, select, open AI, resize and collapse both panels, then keep editing
  with selection, undo, and save intact.
- File, News, Tasks, and Calendar navigation with AI open keeps the context
  label and the request in agreement.
- A refresh restores panel visibility and widths; storage holds nothing else.
- No horizontal overflow at 1920, 1440, 1280, 1024, 800, or 390px.

Deferred:
- Paper context: sending the arXiv card or paper in view as AI context.
- Contextual replacement of the file tree per view, and pin/unpin panel modes.

### 11. Meetings: Indico Meetings Linked to Notes

Status: Done.

Goal: follow selected Indico categories and events, including protected ones
on indico.cern.ch, see upcoming meetings, read an agenda, and create or reopen
the meeting's Markdown note, without a third permanent sidebar and without the
browser ever holding a token.

Tasks:
- [x] Token routing by exact origin (`indicoSites` in `server/indico.js`):
      `INDICO_<NAME>_TOKEN` binds to a built-in origin (cern, fnal, global) or
      to `INDICO_<NAME>_URL`. Fixes the old second-label rule, which would have
      sent the CERN token to `indico.cern.example`.
- [x] `indicoFetch`: HTTPS only, no credentials in URLs, no custom ports,
      redirects followed by hand and only within the origin, 15 s timeout, and
      typed failures (auth, config, network, timeout, redirect, not_found,
      upstream) whose messages name the variable, never the token. CERN's 400
      `invalid_token` counts as an authentication failure.
- [x] The pasted-link title lookup falls back to `/export/` when a
      `read:legacy_api` token cannot open the HTML page.
- [x] `server/meetings.js`: `.webmd/meetings.json` (version 1) per workspace
      root, validated and canonicalized on the server. Bad entries are skipped
      with a warning and kept on rewrite; a file that does not parse is never
      overwritten.
- [x] Export API client: category listings for a bounded window
      (`from`/`to`/`order`/`limit`, `oa=yes` with a token) and event detail
      with `detail=contributions`. Normalized model with exact-origin event
      keys, event-timezone wall time plus absolute instants, dedupe across
      sources, bounded 10-minute cache with shared in-flight requests, and
      Refresh bypassing it.
- [x] Meeting notes: `workspace.createFile` writes through a temp file and
      `link()`, so it never overwrites. Notes are found by their `indico:`
      frontmatter after a fresh walk, so renames keep the association.
      Creation is serialized per workspace, and a taken name falls back to
      one with the event id. Heading and file name agree, so title sync does
      not rename the note.
- [x] `Meetings` rail destination and `src/MeetingsView.svelte`: Quiet
      Workspace list and detail, source filter, Add source, Refresh, grouped
      local-day sections, detail with agenda, Open in Indico, and Create or
      Open note. It stays mounted, so returning keeps the selection. Narrow
      panes (by pane width) show list and detail in turn, with Back and focus
      handling.
- [x] Harness: `scripts/browser-harness.mjs` shared by `npm run scenarios` and
      the new `npm run scenarios:meetings`. The fixture gains a canned Indico
      (`MEETINGS_MODE`). `npm run smoke:indico` is an opt-in, read-only real
      check.

Done when:
- A valid CERN token lists protected meetings and opens one; no token gives an
  actionable hint; a rejected token is a distinct authentication error.
- The CERN token is never sent to another origin, including lookalike hosts and
  cross-origin redirects; public meetings work without a token.
- Create note writes valid Markdown in the selected workspace, and pressing it
  again opens the same note without touching user content.
- Switching Meetings, Files, News, Tasks, and Calendar keeps editor and panel
  state; desktop and narrow layouts pass the scenario checks with no overflow.

Deferred:
- Attachments, participants, calendar write-back, background polling or
  notifications, AI preparation (summaries came in milestone 12), agenda sync into existing notes,
  OAuth, and discovery across all of Indico.
- Session names from the export fallback of the title lookup (export names
  events and contributions only).

### 12. Meetings and Zoom: Join, Recordings, Transcripts, Summaries

Goal: for the Zoom meetings most Indico meetings are, join from the list, and
after the meeting tie its recording and transcript to its note and summarize
the transcript into it, without a Zoom account (the user rarely hosts).

- [x] `server/zoom.js`: Zoom join and recording links, meeting ID, and
      passcode from an event's location, room, and description (link targets
      and bare text), and the Zoom plugin's room from the event page, which
      the export API omits. Zoom hosts over HTTPS only; `pwd` is the only
      query kept.
- [x] `eventPageZoom`: the page is read with the token, then anonymously when
      a `read:legacy_api` token is turned away; failures only mean no Zoom.
      Read for the opened meeting and for up to 12 meetings within a day.
- [x] The listing keeps the past week (`MEETING_PAST_DAYS`), shown last as
      **Past week**, so a meeting is still there when its recording is.
- [x] `server/transcripts.js`: WebVTT, SubRip, voice tags, and Zoom saved
      captions become a `type: transcript` note beside the meeting note, one
      paragraph per speaker turn. `recording:` frontmatter set or removed line
      by line. Summary prompt, tolerant JSON reply parsing, and insertion of
      `## Summary` and deduplicated action items; an existing Summary is never
      replaced.
- [x] `workspace.editFile`: WebMD's own edits run in the document's write
      queue and are broadcast as one ordinary version, so open editors rebase.
- [x] Routes `POST /api/meetings/recording`, `/transcript`, `/summary`; each
      creates the meeting note first when it has none.
- [x] Meetings view: Join chip in the list while a call is on, **Join Zoom**
      in the detail, and a **Recording and transcript** section. Fixture
      `MEETINGS_MODE=zoom` and scenario checks.

Deferred:
- Signing in to Zoom to fetch recordings and transcripts automatically (only
  works for meetings the user hosts).

### 13. News: Learn From Up and Down Votes

Status: Done (Rocchio stage). Review the upgrade path around 2026-10-21, once
there are a month of votes.

Done:
- [x] ↑ / ↓ on every News paper, stored in `.webmd/news-votes.json` (id, vote,
      date, title, abstract; tracked with the notes). Pressing again takes the
      vote back. The page keeps its order; the next ranking or **Re-rank** uses
      the votes.
- [x] Keyword stage: Rocchio relevance feedback in `scorePapers`. The profile
      moves towards the average upvoted paper (`UPVOTE_WEIGHT` 4) and away from
      the average downvoted one (`DOWNVOTE_WEIGHT` 2); downvoted words score
      negative.
- [x] AI stage: the 20 most recent upvoted and downvoted titles go into the
      prompt, and a downvoted paper is never offered as a pick.

Upgrade path (do these in order, only when the previous stage falls short):
1. **Check it works.** `jq '[.votes[].vote] | group_by(.) | map({vote: .[0],
   n: length})' .webmd/news-votes.json` for the counts. If upvotes keep landing
   in "Everything else" or outside the AI's shortlist, tune the weights or go
   on to step 2.
2. **Logistic regression on TF-IDF, at about 50 votes.** What Scholar Inbox
   (arXiv:2504.08385) runs for 23k users; arxiv-sanity-lite uses a linear SVM
   on the same features. Train per workspace on the stored votes: upvotes are
   positives, downvotes are negatives weighted up (Scholar Inbox uses 5x), and
   a few thousand random unvoted papers from the kept listings are weak
   negatives. Class-balanced loss, L2 regularization (C around 0.03), plain
   gradient descent in JS over sparse vectors; no dependency needed. Keep the
   Rocchio profile as the fallback under the vote threshold. Its score
   replaces `scorePapers` for the shortlist and the tail.
3. **Embeddings, only if word matching is the bottleneck.** Scholar Inbox
   found TF-IDF slightly better on ranking (88.7 vs 85.8 nDCG) and GTE-Large
   slightly better on explicit downvotes, so this is the last step, not the
   next one. Needs an embedding model (local or API) and a vector cache.
4. **Active learning.** Ask for votes on papers near the classifier's decision
   boundary, as Scholar Inbox does, if votes come in too slowly.

## First Implementation Pass

1. [x] Scaffold frontend and backend.
2. [x] Implement backend path validation, tree, load, and atomic save.
3. [x] Build Svelte shell with sidebar and CodeMirror editor.
4. [x] Wire debounced save and offline recovery.
5. [x] Add collaboration endpoints after single-user editing works.
6. [x] Wire CodeMirror collaboration clients to the backend update/event endpoints.
7. [x] Add AI chat after collaboration has a stable document state.
8. [x] Add inline diff edits last.

## Deferred Until Needed

- Separate app authentication.
- Database-backed revision storage.
- Side-by-side diff rendering and commit history browsing.
- Graph exploration upgrades: keep `All notes` literal, add a `Hide unlinked`
  filter if daily or raw notes create noise, and consider an optional lazy-loaded
  Three.js 3D Explore mode only if users want visual discovery. Keep the native
  2D graph as the primary research interface.
- Markdown preview engine upgrade: keep the small renderer for now; consider `markdown-it` with lazy preview loading for fuller Markdown, images, and simple media embeds, or a unified/remark pipeline only if custom attachment/media transforms become central. Keep PDF viewing and annotations separate, likely via a PDF viewer path plus app-level annotation data keyed by file, page, and range/rect.
- Plugin system.
- Mobile-specific editor redesign.
- User/account management.
