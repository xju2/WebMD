# WebMD

A remote-first Markdown workspace for editing notes through an SSH tunnel.

## Setup

```bash
npm install
WORKSPACE_ROOT=/absolute/path/to/notes npm run dev
```

To switch between server folders from the sidebar, pass a path-delimited list:

```bash
WORKSPACE_ROOTS="/absolute/path/to/notes:/absolute/path/to/other-notes" npm run dev
```

The backend refuses to start without `WORKSPACE_ROOT` or `WORKSPACE_ROOTS` and always binds to `127.0.0.1`.
The Vite dev server also binds to `127.0.0.1` and proxies `/api` to the backend.

## Environment

- `WORKSPACE_ROOT`: required absolute path to the Markdown workspace.
- `WORKSPACE_ROOTS`: optional path-delimited list of Markdown workspaces.
- `PORT`: backend port, defaults to `3000`.
- `VITE_API_PROXY_TARGET`: optional dev proxy target, set by `npm run dev`.

AI provider settings are planned but not wired in this pass. Keep provider keys server-side when that milestone lands.

## Scripts

- `npm run dev`: start backend and frontend locally.
- `npm run test`: run focused workspace safety tests.
- `npm run lint`: run syntax checks.
- `npm run build`: build the frontend into `dist/`.
