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

Instead of passing env vars on the command line, put them in `~/.webmd.conf` (`KEY=VALUE` per line, same format as `.env`). The backend loads it automatically on startup; real environment variables still take precedence:

```conf
WORKSPACE_ROOT=/absolute/path/to/notes
PORT=3000
```

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

## iPhone access

For persistent private access without keeping an SSH app open, install Tailscale
on the server and iPhone, sign both into the same tailnet, and run on the server:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

Open the HTTPS URL printed by Tailscale in Safari. Use **Share → Add to Home
Screen**, enable **Open as Web App**, and tap **Add**. Keep Tailscale connected
on the phone; do not use Tailscale Funnel, which would make WebMD public.

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

## Prompt presets

The AI panel's **Prompts** picker is a group rail with that group's prompts
beside it — one click runs a prompt. There are two kinds:

- **Rewrite prompts** (`kind: "edit"`) act on the selected text. Select text
  first, or they stay disabled. The result lands in the diff preview, so nothing
  changes until you accept it.
- **Ask prompts** (`kind: "chat"`, marked with a dot) act on the whole note and
  need no selection. They answer in the chat transcript and never touch the file.

Anything typed in the chat box refines the prompt you click.

Built-in presets:

| Group | Kind | Presets |
| --- | --- | --- |
| Paper | Rewrite | Tighten (academic), Active voice, Methods-section voice, Calibrate claims, Compress to abstract, Plain-language summary |
| Email | Rewrite | Polite reply, Concise reply, Soften a decline, Follow-up nudge |
| Notes | Rewrite | Condense to bullets, Clean up dictation, Extract action items, Expand shorthand |
| Ask | Chat | Summarize this note, Open questions, Skeptical review, Suggest next steps |

Add your own in `$WORKSPACE_ROOT/.webmd/prompts.json`. Reusing a built-in `id`
replaces that preset, so you can retune one without redefining the rest:

```json
{
  "presets": [
    {
      "id": "grant-aims",
      "label": "Specific Aims voice",
      "group": "Paper",
      "system": "You rewrite text in the voice of an NIH Specific Aims page. Return only the replacement Markdown, with no explanations or code fences.",
      "instruction": "Tighten to active voice and cut hedging."
    },
    {
      "id": "ask-reviewer",
      "label": "Reviewer 2",
      "group": "Ask",
      "kind": "chat",
      "system": "You review a note as a demanding but fair referee. Answer in concise Markdown and do not rewrite the note.",
      "instruction": "How would a hostile reviewer attack this?"
    }
  ]
}
```

`id`, `label`, and `system` are required; `group` defaults to `Custom`, `kind`
defaults to `edit`, and `instruction` is derived from the label when omitted. An
`edit` preset's `system` prompt should tell the model to return only the
replacement Markdown — anything else it says ends up in your document. System
prompts stay on the server and are never sent to the browser. Invalid entries
are skipped with a warning in the AI panel rather than dropping the whole file.

## Daily brief integration

WebMD displays today's Codex-generated daily brief from:

```text
raw/dailybrief/YYYY-MM-DD.md
```

For example, on 2026-07-17 it reads `raw/dailybrief/2026-07-17.md`.
`raw/dailybrief/latest.md` is still supported as a fallback.

## YAML frontmatter

WebMD understands the Open Knowledge Format fields `type`, `title`,
`description`, `resource`, `tags`, and `timestamp` in a Markdown file's leading
YAML frontmatter. Preview renders the Markdown body, and workspace search can
filter any field with `field:value`, for example `type:Playbook`, `tags:oncall`,
or `timestamp:2026-07`. Tag matching is exact; other fields support partial,
case-insensitive matching.

Recommended Markdown shape:

```markdown
# Daily Brief - 2026-07-16

_Generated: 2026-07-16 07:30 America/Los_Angeles_

## Focus

- ...

## Updates

- ...

## Follow-ups

- [ ] ...

## Sources

- raw/dailynotes/2026-07-16.md
- raw/projects/example.md
```

## Scripts

- `npm run dev`: start backend and frontend locally.
- `npm run test`: run focused workspace safety tests.
- `npm run lint`: run syntax checks.
- `npm run build`: build the frontend into `dist/`.
