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

- Done: Vite/Svelte frontend, Express backend bound to `127.0.0.1`, multi-root workspaces, safe file APIs, atomic saves, CodeMirror editing, failed-save `sessionStorage` recovery, workspace search, Markdown preview, media preview, daily notes, wiki links, raw git diff preview, MVP collaborative editing, and streamed AI chat.
- Collaborative editing now uses server-owned document versions, CM6 `ChangeSet` updates through `POST /api/workspace/updates`, atomic disk snapshots, SSE update replay through `GET /api/workspace/events`, and client-side rebasing for pending local edits.
- AI chat keeps provider keys server-side, streams from Ollama or OpenAI-compatible Responses providers, and sends active document or selected-text context from the workspace.
- Next: add inline AI diff edits.

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

Tasks:
- Add an inline edit command using the current selection.
- Ask the AI provider for replacement text.
- Render a diff preview against the selected text.
- Add accept and reject actions.
- Apply accepted edits through the same editor update path as manual typing.

Done when:
- AI never mutates the document without user approval.
- Accepted AI edits participate in save and collaboration flow.

### 7. Hardening

Tasks:
- Add user-facing error states for unavailable server, failed saves, invalid paths, and AI failures.
- Add browser checks for desktop and mobile layouts.
- Add docs for SSH tunnel startup.
- Add a minimal smoke test that starts the server against a temp workspace.

Done when:
- A fresh clone can run the app using the documented commands.
- Core file safety, save, collaboration, and AI flows have one runnable check each.

## First Implementation Pass

1. [x] Scaffold frontend and backend.
2. [x] Implement backend path validation, tree, load, and atomic save.
3. [x] Build Svelte shell with sidebar and CodeMirror editor.
4. [x] Wire debounced save and offline recovery.
5. [x] Add collaboration endpoints after single-user editing works.
6. [x] Wire CodeMirror collaboration clients to the backend update/event endpoints.
7. [x] Add AI chat after collaboration has a stable document state.
8. [ ] Add inline diff edits last.

## Deferred Until Needed

- Separate app authentication.
- Database-backed revision storage.
- Side-by-side diff rendering and commit history browsing.
- Markdown preview engine upgrade: keep the small renderer for now; consider `markdown-it` with lazy preview loading for fuller Markdown, images, and simple media embeds, or a unified/remark pipeline only if custom attachment/media transforms become central. Keep PDF viewing and annotations separate, likely via a PDF viewer path plus app-level annotation data keyed by file, page, and range/rect.
- Plugin system.
- Mobile-specific editor redesign.
- User/account management.
- Move the daily-note folder selector out of the always-visible global rail once there is a settings/preferences surface; it is useful setup but distracting after the first choice.
