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

## Auto-Commit

If a workspace root is a git repo, `AUTO_COMMIT_MINUTES` snapshots it on an
interval, and once more when the server shuts down:

```conf
AUTO_COMMIT_MINUTES=15
```

Unset or `0` disables it. Each tick runs `git add -A` and commits everything git
would track under that root — including changes you deliberately left unstaged —
as `WebMD autosave <date> <time>`. Nothing is pushed. A clean tree, a directory
that is not a repo, and a repo mid-merge or mid-rebase are all skipped. Commits
run with `--no-verify` and signing off, so no hook or passphrase prompt can
block an unattended snapshot; if git has no `user.email` configured anywhere,
the commit is attributed to `WebMD <webmd@localhost>`.

This is the safety net that outlives the browser: the editor's undo history is
per-note and dies with the tab, so `git show HEAD:note.md` (or
`git checkout HEAD -- note.md`) is what recovers a note deleted by mistake.

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

| Group | Kind    | Presets                                                                                                                 |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Paper | Rewrite | Tighten (academic), Active voice, Methods-section voice, Calibrate claims, Compress to abstract, Plain-language summary |
| Email | Rewrite | Polite reply, Concise reply, Soften a decline, Follow-up nudge                                                          |
| Notes | Rewrite | Condense to bullets, Clean up dictation, Extract action items, Expand shorthand                                         |
| Ask   | Chat    | Summarize this note, Open questions, Skeptical review, Suggest next steps                                               |

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

## Connect notes

**Connect notes** in the AI panel links the open note to notes you already have.
It ranks every Markdown file in the workspace by how much wording it shares with
the open note, sends the strongest dozen to the model as a shortlist, and asks
which ones a reader would want to follow.

The suggestions arrive as a review panel — one checkbox per link, showing the
exact bullet that will be written. Accepting appends them to a `## Related`
section at the end of the note, reusing a trailing `## Related pages` or
`## Related concepts` section when the note already has one:

```markdown
## Related

- [[concepts/hybrid-search]] — the retrieval scheme this run replaced
- [[2026-07-08]] — earlier pass over the same dataset
```

Links are one-directional and written only into the open note; no other file is
touched. Each link is emitted in the shortest form that resolves back to the
note it names, so it can never be a dead link. Notes the file already links to
are never suggested again, and the model can only choose from the shortlist, so
it cannot invent a path.

## Tasks

Any `- [ ]` checkbox is a task. Ticking one in the preview writes today's date
into the note, so a finished task records _when_ it was finished:

```markdown
- [ ] Write the intro
- [x] Draft outline ✅ 2026-08-14
```

Tasks can also carry a due date and a priority, in the Obsidian Tasks emoji
convention, so notes stay portable and readable as plain text:

| Field    | Syntax                   | Effect                                                   |
| -------- | ------------------------ | -------------------------------------------------------- |
| Due      | `📅 2026-08-20`          | Preview badges it red when overdue, amber when due today |
| Done     | `✅ 2026-08-14`          | Written and removed for you as the box is ticked         |
| Created  | `➕ 2026-08-01`          | Shown as typed; never written automatically              |
| Priority | `🔺` `⏫` `🔼` `🔽` `⏬` | Highest to lowest; sorts the Tasks view                  |

A note in preview shows how far along it is (`7/12 done`) above the text.
Anything unrecognised — including recurring tasks (`🔁`), which WebMD does not
support — is left in the task's text untouched.

### Typing shorthand

The emoji never have to be typed. On a task line, write `due:` and a date, or
`:p1:`–`:p5:` for priority, and the editor rewrites it as soon as the caret
leaves the line — so the file itself stays plain Obsidian syntax:

```markdown
- [ ] Submit the abstract due:friday :p2:
```

becomes

```markdown
- [ ] Submit the abstract ⏫ 📅 2026-08-21
```

| Shorthand                               | Means                                        |
| --------------------------------------- | -------------------------------------------- |
| `due:` `created:` (or `added:`) `done:` | `📅` `➕` `✅`                               |
| `:p1:` `:p2:` `:p3:` `:p4:` `:p5:`      | `🔺` `⏫` `🔼` `🔽` `⏬`                     |
| `2026-08-20`                            | That date                                    |
| `today` `tomorrow` `yesterday`          | Also `tod` and `tmr`                         |
| `monday` … `sunday`                     | The next one to come; `mon` … `sun` work too |
| `+3d` `+2w`                             | Days or weeks from today                     |

Shorthand replaces a field the line already has, so `due:tomorrow` on a task
that is already dated just moves it. Anything that does not resolve to a real
date — `due:someday`, or a typo — is left exactly as typed rather than guessed
at, and shorthand in ordinary prose or inside a fenced code block is ignored.
Priority carries its colons so that a task about the p2 bug keeps its own
words.

### Tasks view

The checklist button in the global bar (or `Cmd/Ctrl+Shift+T`) opens every open
task in the workspace. Clicking a row opens its note in preview, scrolled to
that task and ready to tick. A `[text](url)` link in a task shows as just its
text and opens in a new tab, without opening the note. Tasks inside fenced code
blocks are ignored, so an example in a how-to never turns into work.

There are three ways to look at the same list.

**Board** is what the view opens on: four short columns, ranked rather than
filed, for answering "what now" without reading everything.

| Lane      | Holds                                                      |
| --------- | ---------------------------------------------------------- |
| **Now**   | Overdue, due today, or marked `:p1:`                       |
| **Soon**  | Dated within the month, marked `:p2:`, or written recently |
| **Later** | Real work, but nothing about it is pressing yet            |
| **Shelf** | Reading and ideas — an unread paper is not late            |

A task's place comes from three things a note already carries: its **due date**
(the strongest signal — an overdue task reaches Now on its date alone), its
**priority** mark, and **how long ago it was written**, taken from its daily
note's filename or its `➕` created date. Age cuts both ways: something written
this week is surfaced, and something written two months ago and never dated
sinks, which is what keeps Now short. It also sets the card's ink, so old work
fades rather than earning another badge. Each card shows the section that
claimed it and, in a daily note, the `##` it sits under.

**Shelf** holds the sections marked as reading rather than work — Ideas,
Interesting papers and Interesting software, by default. Those skip the ranking
entirely, because scoring a paper against a deadline it never had would only
bury the actual backlog. Any section can be shelved or unshelved under **Edit
sections**; the catch-all never can.

**Filter** narrows the list before any of the three views slice it, matching a
task's prose, tags, headings and path alike, so `gnl` finds "GNLarge" halfway
through a word. `/` puts the cursor in it, and `Escape` clears it.

**Sections** is a dashboard: a task is filed under the first section whose terms
it matches, and whatever matches nothing lands in **Other tasks**. That keeps a
reading list, a stack of ideas, and real work in one `- [ ]` habit without them
crowding each other out. **Urgency** is the third view, grouped **Overdue /
Today / This week / Later / No date**. Both sort by due date then priority, and
both group a note's tasks under the note — except in a daily note, where they
group under the `##` they sit beneath, so a project's work reads as one pile
across the week rather than one per day.

A term matches three things, so notes can be organised whichever way reads best:

| Source      | Example                           | Matches                                  |
| ----------- | --------------------------------- | ---------------------------------------- |
| Inline tag  | `- [ ] Read the GNN paper #paper` | `paper`                                  |
| Frontmatter | `tags: [paper, reading]`          | every task in the note                   |
| Heading     | `## Interesting papers`           | the whole heading, and each of its words |

Singular and plural are the same term, and a leading `#` is optional, so `paper`
finds `#papers` and `## Papers` alike. **Edit sections** renames a section,
changes its terms, sets whether it shows open, done, or all tasks, marks it as
**Shelf**, and reorders or adds sections; the layout, the chosen view, and any
folded lanes are remembered in the browser. **Completed** loads
finished tasks as well, and shows them struck through in place.

### Opening today's note

The note button in the global bar (or `Cmd/Ctrl+Shift+D`) opens today's note
from wherever you are, creating it from the template if the day has none. The
dashboard's **Open today's note** card does the same thing.

### Daily note template

A new daily note starts from the template picked in the Calendar header, which
may use `{{date}}`, `{{title}}`, and `{{weekday}}`. With nothing picked, WebMD
uses a conventionally named template — `dailynote_template.md`,
`daily-template.md`, or `template.md` — from the daily-note folder, or failing
that from the workspace root. Choosing **None** keeps the bare `# YYYY-MM-DD`
heading.

### Unfinished tasks

A new daily note is the template and nothing else — yesterday's unfinished tasks
are not copied into it. An open task stays in the note that raised it, and the
Tasks view is where you see the whole backlog: it reads every note in the
workspace, so a task written weeks ago is one row there rather than a line
duplicated into every day since. Clicking a row opens that note in preview at
the task's line, where the box can be ticked once and for all.

Notes written before this carry `↩ [[origin]]` links from the old carry-over
behaviour. Nothing writes them any more, but they are still parsed and shown as
backlinks, so those notes keep reading the way they did.

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
