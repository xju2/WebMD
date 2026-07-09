# Plans.md

## Goal

Ship a remote-first, AI-native Markdown workspace that runs on a target server, binds only to `127.0.0.1`, serves a browser UI over an SSH tunnel, edits Markdown with CodeMirror, and keeps files inside `$WORKSPACE_ROOT`.

## Ground Rules

- Build the boring path first: tree, load, edit, save.
- Keep SSH tunnel isolation as the only auth layer for now.
- Never allow paths or symlinks to resolve outside `$WORKSPACE_ROOT`.
- Use whole-file saves for MVP and recovery; use collaborative CM6 updates for active multi-user editing.
- Keep AI provider keys server-side. Support local Ollama and remote API providers.
- Show inline AI edits as a diff before applying them.

## Milestones

### 1. Project Skeleton

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

### 4. Collaborative Editing

Tasks:
- Add server-owned document versions.
- Implement `POST /api/workspace/updates`.
- Implement `GET /api/workspace/events` using SSE.
- Store per-document update logs in memory for active sessions.
- Snapshot collaborative state back to disk with atomic writes.
- Rebase pending local CM6 updates against remote updates.

Done when:
- Two browser sessions can edit the same file and see each other's changes without last-write-wins overwrite.
- Reloading the document preserves the merged result from disk.

### 5. AI Chat

Tasks:
- Add AI provider configuration for Ollama and remote API providers.
- Implement `POST /api/ai/chat` as an SSE stream.
- Send selected text, active document path, and prompt text to the server.
- Keep provider secrets out of the browser.
- Render streamed chat output in the sidebar.

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

1. Scaffold frontend and backend.
2. Implement backend path validation, tree, load, and atomic save.
3. Build Svelte shell with sidebar and CodeMirror editor.
4. Wire debounced save and offline recovery.
5. Add collaboration endpoints after single-user editing works.
6. Add AI chat after collaboration has a stable document state.
7. Add inline diff edits last.

## Deferred Until Needed

- Separate app authentication.
- Database-backed revision storage.
- Plugin system.
- Mobile-specific editor redesign.
- User/account management.
