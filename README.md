# WebMD

A remote-first Markdown workspace: your notes live on one machine, and you
edit them from any browser — laptop or phone — over your private Tailscale
network.

## Quick start

You need Node.js 20.12 or newer and git.

**1. Try it locally.** Clone, install, and start the dev server:

```bash
git clone https://github.com/xju2/WebMD.git
cd WebMD
npm install
npm run dev
```

Open the URL Vite prints (usually `http://127.0.0.1:5173`). With no workspace
configured you land in the sandbox, an example workspace with a
guided tour. Nothing you do there touches your own files.

**2. Point it at your notes.** Create `~/.webmd.conf` with a folder of Markdown
files (a git repo is best, so [auto-commit](#webmd-settings) can snapshot it):

```conf
WORKSPACE_ROOT=/absolute/path/to/notes
```

Restart `npm run dev` and your notes appear in the sidebar.

**3. Reach it from anywhere.** On the machine that holds your notes, build the
app and run it, then share it on your tailnet:

```bash
npm run build
npm start                                      # serves on 127.0.0.1:3000
tailscale serve --bg http://127.0.0.1:3000
```

Open the HTTPS URL that `tailscale serve` prints from any device signed into
the same tailnet. Do not use Tailscale Funnel: it would put WebMD, which has no
login, on the public internet.

### iPhone

Install Tailscale on the phone and keep it connected. Open the HTTPS URL in
Safari, then use **Share → Add to Home Screen**, enable **Open as Web App**,
and tap **Add**. WebMD then opens full-screen like an app.

## Workspace settings

How a workspace is laid out belongs to that workspace, so each one can carry a
`.webmd/settings.json`. Commit it with your notes and every machine gets the
same layout. There are no controls for these in the UI. Edit the file, then
switch to the workspace again or reload the page.

```json
{
  "imageAssetFolder": "/assets",
  "dailyNoteFolder": "/raw/dailynotes",
  "dailyNoteTemplate": "/raw/dailynotes/template.md"
}
```

Every key is optional:

- `imageAssetFolder`: where pasted and uploaded images and PDFs go. It is
  created on the first upload. If you leave it out, WebMD uses
  `IMAGE_ASSET_FOLDER` from the environment or `~/.webmd.conf`, and then
  `/assets`.
- `dailyNoteFolder`: where today's note, Tasks, and date links look for daily
  notes. If you leave it out, WebMD uses `/raw/dailynotes`, or `/` when the
  workspace has no such folder.
- `dailyNoteTemplate`: the note a new daily note starts from (see
  [Daily note template](docs/features.md#daily-note-template)). `""` means no template.

WebMD skips a value it cannot use, keeps the rest, and names the problem when
it next creates a daily note.

## WebMD settings

Settings for WebMD itself, rather than for one workspace, go in
`~/.webmd.conf`, one `KEY=VALUE` per line. Environment variables of the same
name take precedence. Restart WebMD after editing it.

```conf
WORKSPACE_ROOT=/absolute/path/to/notes
AUTO_COMMIT_MINUTES=15
OPENAI_API_KEY=sk-...
```

Every key is optional.

**Workspaces**

- `WORKSPACE_ROOT`: the folder of notes to open. Without it, WebMD opens the
  sandbox.
- `WORKSPACE_ROOTS`: several folders, separated by `:`, to switch between from
  the sidebar.
- `WEBMD_SANDBOX_DIR`: where the sandbox copy lives, defaults to
  `~/.local/share/webmd/sandbox`. Delete it to start the sandbox over.
- `IMAGE_ASSET_FOLDER`: where pasted images go when the workspace does not set
  `imageAssetFolder`, defaults to `/assets`.

**Server**

- `PORT`: defaults to `3000`. WebMD always binds to `127.0.0.1`.
- `WEBMD_CACHE_DIR`: cached News and Meetings data, defaults to
  `~/.cache/webmd`. Safe to delete.

**Auto-commit**

- `AUTO_COMMIT_MINUTES`: when a workspace is a git repo, commit everything in
  it on this interval and on shutdown. Nothing is pushed. Unset or `0` turns it
  off.
- `AUTO_COMMIT_SUMMARY_LINES`: snapshots larger than this many changed lines
  (default `5`) get an AI-written commit message.

**AI**

- `OPENAI_API_KEY`: turns on the AI features using OpenAI. It never reaches
  the browser.
- `AI_PROVIDER`: `openai` or `ollama`. Defaults to `openai` when a key is set,
  `ollama` otherwise.
- `AI_MODEL`: defaults to `gpt-5.6` for OpenAI and `llama3.2` for Ollama.
- `OPENAI_BASE_URL`, `OLLAMA_BASE_URL`: point at another OpenAI-compatible
  server or Ollama instance.

**Meetings and News**

- `INDICO_<NAME>_TOKEN`: an Indico personal access token, for protected
  meetings. `CERN`, `FNAL`, and `GLOBAL` are known; for any other Indico, also
  set `INDICO_<NAME>_URL=https://...`. See
  [Tokens and scopes](docs/features.md#tokens-and-scopes).
- `ARXIV_NEWS_CATEGORIES`: arXiv categories for the News view, defaults to
  `hep-ex,hep-ph,cs.LG,cs.AI,physics.data-an`.
- `ARXIV_NEWS_INTERESTS`: what you care about, used to rank papers when the
  workspace has no `.webmd/news.md`.
- `ARXIV_NEWS_MAX_CANDIDATES`: how many papers the ranking reads each day,
  defaults to `120`.
- `QUOTE_THEMES`: themes for the daily-note quote, defaults to
  `life,programming,finance`.

## Features

The sandbox tour shows the basics. [docs/features.md](docs/features.md)
describes everything else: tasks, daily notes, citations, meetings, arXiv
news, prompt presets, and more.

## Scripts

- `npm run dev`: start backend and frontend locally.
- `npm run test`: run focused workspace safety tests.
- `npm run lint`: run syntax checks.
- `npm run build`: build the frontend into `dist/`.
- `npm run fixture`: serve a seeded throwaway workspace with a stub AI provider,
  arXiv feed, and Indico on port 3197 (`AI_MODE=slow|error`,
  `NEWS_MODE=error|empty`, `MEETINGS_MODE=notoken|auth|offline|none|zoom`). It never
  reads `~/.webmd.conf`, and its Indico token is a placeholder.
- `npm run scenarios`: after `npm run build`, run the headless Chrome layout
  and AI-context acceptance checks against fixtures (`OUT_DIR` keeps
  screenshots). Needs Google Chrome, or `CHROME_PATH`.
- `npm run scenarios:meetings`: the same for Meetings: list, agenda, notes,
  add source, token failures, Zoom join, transcript and summary, and narrow
  layouts.
- `npm run smoke:indico`: opt-in, read-only check of a real Indico source with
  your own token (`INDICO_SMOKE_SOURCE=<link>`). Not part of `npm test`.
