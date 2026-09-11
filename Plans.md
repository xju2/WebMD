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
- [x] Document toolbar folds Upload, Delete, and Reference into the ... menu by
      the center's width, so docked panels on a laptop do not crowd it.
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
