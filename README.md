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

## SSH Tunnel

On the remote server:

```bash
npm install
npm run build
WORKSPACE_ROOT=/absolute/path/to/notes PORT=3000 npm start
```

From your local machine:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@remote-host
```

Then open `http://127.0.0.1:3000` locally. The app still binds only to
`127.0.0.1` on the remote host, so the SSH tunnel remains the access boundary.

## Environment

- `WORKSPACE_ROOT`: required absolute path to the Markdown workspace.
- `WORKSPACE_ROOTS`: optional path-delimited list of Markdown workspaces.
- `PORT`: backend port, defaults to `3000`.
- `VITE_API_PROXY_TARGET`: optional dev proxy target, set by `npm run dev`.
- `AI_PROVIDER`: optional `ollama` or `openai`, defaults to `openai` when `OPENAI_API_KEY` is set and `ollama` otherwise.
- `AI_MODEL`: optional model override. Ollama defaults to `llama3.2`; OpenAI defaults to `gpt-5.6`.
- `OLLAMA_BASE_URL`: optional Ollama URL, defaults to `http://127.0.0.1:11434`.
- `OPENAI_API_KEY`: required for `AI_PROVIDER=openai`; never sent to the browser.
- `OPENAI_BASE_URL`: optional OpenAI-compatible base URL, defaults to `https://api.openai.com/v1`.

## Scripts

- `npm run dev`: start backend and frontend locally.
- `npm run test`: run focused workspace safety tests.
- `npm run lint`: run syntax checks.
- `npm run build`: build the frontend into `dist/`.
