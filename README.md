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
- `IMAGE_ASSET_FOLDER`: workspace folder for pasted and uploaded images and
  PDFs, defaults to `/assets`. It is created on the first upload if missing.
- `VITE_API_PROXY_TARGET`: optional dev proxy target, set by `npm run dev`.
- `AI_PROVIDER`: optional `ollama` or `openai`, defaults to `openai` when `OPENAI_API_KEY` is set and `ollama` otherwise.
- `AI_MODEL`: optional model override. Ollama defaults to `llama3.2`; OpenAI defaults to `gpt-5.6`.
- `OLLAMA_BASE_URL`: optional Ollama URL, defaults to `http://127.0.0.1:11434`.
- `OPENAI_API_KEY`: required for `AI_PROVIDER=openai`; never sent to the browser.
- `OPENAI_BASE_URL`: optional OpenAI-compatible base URL, defaults to `https://api.openai.com/v1`.
- `INDICO_<NAME>_TOKEN`: optional Indico personal access token, for protected
  meetings in the Meetings view and for naming pasted Indico links that need a
  login. Each token is bound to one exact origin: `INDICO_CERN_TOKEN` to
  `https://indico.cern.ch`, `INDICO_FNAL_TOKEN` to `https://indico.fnal.gov`,
  `INDICO_GLOBAL_TOKEN` to `https://indico.global`. It never leaves the backend
  and is sent to that origin only. See [Meetings](#meetings) for scopes.
- `INDICO_<NAME>_URL`: the `https://` address of any other Indico, paired with
  its token, as `INDICO_DESY_URL=https://indico.desy.de` beside
  `INDICO_DESY_TOKEN`. A token with no known or configured address is ignored.
- `ARXIV_NEWS_CATEGORIES`: optional comma-separated arXiv categories for the
  News view, defaults to `hep-ex,hep-ph,cs.LG,cs.AI,physics.data-an`.
- `ARXIV_NEWS_INTERESTS`: optional ranking instructions for the News view, used
  when the workspace has no `.webmd/news.md`.
- `WEBMD_CACHE_DIR`: where the News listing and its AI ranking are kept across
  restarts, defaults to `~/.cache/webmd`. Nothing there is needed; delete it
  any time.

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

## Titles name the file

A note's file name follows its title, the way Obsidian's does. Retitle a note —
the frontmatter `title:` field when it has one, otherwise the first heading —
and the next save renames the file to match: `# Reading list` in
`/wiki/Untitled.md` moves the note to `/wiki/Reading list.md`.

Every `[[wiki link]]` in the workspace that pointed at the old name is rewritten
to the new one, keeping its alias, heading anchor, and `!` embed marker, so
renaming never leaves a dead link behind. Characters a file name cannot carry
(`/`, `:`, `?`, and friends) are dropped from the name; the title in the note
keeps them.

Two notes are left alone: a daily note, which is addressed by its date rather
than its heading, and a note whose new name is already taken — that rename is
reported as an error instead of overwriting the other note.

## Wiki links

Typing `[[` in the editor offers the notes it could mean — matched on the name
and on the folder, so `iaas` finds `/raw/projects/iaas/triton.md` too. Accepting
one writes the shortest form that still resolves back to that note, so a
completed link is never ambiguous and never dead.

Typing `#` after the note name switches to that note's headings:
`[[hybrid-search#Setup]]` opens the note and scrolls to its `## Setup`, in the
preview or in the editor, whichever pane is open. `![[hybrid-search#Setup]]`
embeds that one section as a card.

A link to a note that is not in the workspace is drawn wavy and warm in the
preview, since a dead link is usually a typo worth seeing while reading.
Clicking one offers to create the note rather than opening an empty page that
belongs to no file.

The graph view counts the same dead links as the mentions it cannot draw, and
its footer lists them: every unresolved link in the workspace, with the note it
is written in. Clicking one opens that note in the editor with the cursor
already on the line the link sits on. The list is capped at 200 entries and
says so when there are more; the count above it is always the true total.

The bottom of every note lists its **linked mentions** — the notes that link
here, with the line each link sits on. Clicking a mention opens that note at
that line. Mentions are resolved rather than string-matched, so `[[triton]]`,
`[[iaas/triton]]` and `[[/raw/projects/iaas/triton|Triton]]` all count as the
same link.

## Citations

Keep bibliography entries in `references.bib` at the workspace root and cite
them with Pandoc syntax such as `[@Ju:2026abc]`. Typing `@` completes known
BibTeX keys. Preview shows inline citations, hover metadata, and a generated
References section; the graph connects notes to the papers they cite.

Pasting an arXiv, DOI, or INSPIRE literature link imports its BibTeX entry and
replaces the link with its `[@key]` citation. DOI metadata comes from doi.org;
arXiv and INSPIRE metadata comes from INSPIRE-HEP.

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

## Snippets

Typing `/date` and pressing Tab writes `2026-08-21` into the note. Tab anywhere
else still indents, so an unknown `/word` is left alone.

| Snippet                           | Inserts                               |
| --------------------------------- | ------------------------------------- |
| `/date` `/time` `/now`            | `2026-08-21`, `14:30`, or both        |
| `/lastupdate`                     | `Last update: 2026-08-21`             |
| `/today` `/tomorrow` `/yesterday` | a link to that day's note             |
| `/task`                           | `- [ ] `                              |
| `/log`                            | `- **14:30** `, for a running log     |
| `/meeting`                        | date heading, Present, Notes, Actions |
| `/table` `/code` `/details`       | a skeleton, caret in the first field  |
| `/note` `/idea` `/warning`        | the matching callout                  |

Snippets expand to plain Markdown, once, at the moment you type them: nothing
is re-evaluated when the note is rendered, so `Last update: 2026-08-21` keeps
saying the day it was written — in this editor, in Obsidian, and in
`git show HEAD:note.md`. Add or edit snippets in `src/snippets.js`.

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
| `10-01` `10/1`                          | The next time that day comes round           |
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

A term matches four things, so notes can be organised whichever way reads best:

| Source      | Example                           | Matches                                  |
| ----------- | --------------------------------- | ---------------------------------------- |
| Inline tag  | `- [ ] Read the GNN paper #paper` | `paper`                                  |
| Frontmatter | `tags: [paper, reading]`          | every task in the note                   |
| Heading     | `## Interesting papers`           | the whole heading, and each of its words |
| arXiv       | `- [ ] arxiv.org/abs/2608.00146`  | `paper`, tagged or not                   |

Singular and plural are the same term, and a leading `#` is optional, so `paper`
finds `#papers` and `## Papers` alike. A task that mentions arXiv anywhere on
the line counts as `#paper`, since pasting a link in is how a paper usually
arrives. **Edit sections** renames a section,
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
may use `{{date}}`, `{{title}}`, `{{weekday}}`, and `{{quote}}`. With nothing picked, WebMD
uses a conventionally named template — `dailynote_template.md`,
`daily-template.md`, or `template.md` — from the daily-note folder, or failing
that from the workspace root. Choosing **None** keeps the bare `# YYYY-MM-DD`
heading.

### Quote of the day

`{{quote}}` asks the configured model for one attributable quote on the day's
theme, written into the note as a single line so a `>
{{quote}}` template stays one blockquote. The line always reads
`{quote} -- {author} ({date})`, where the date is when the quote was said or
published, not the day of the note. An unattributed quote becomes `Unknown`
rather than a differently-shaped line, and a quote whose date the model does not
know drops the parentheses, so notes from different days line up. Three things
keep it from repeating itself:

- The theme rotates with the date, so consecutive days cannot land on the same
  subject, and the same day always asks for the same one. Set your own rotation
  with `QUOTE_THEMES` in the environment or `~/.webmd.conf`:

  ```conf
  QUOTE_THEMES=life,programming,finance
  ```

  Any comma-separated list works — `stoicism,music,physics` rotates over three
  days, a single theme asks for that one every day. Unset, it rotates over
  life, programming, and finance.

- Every quote already used is stored in `.webmd/quotes.json` and sent back to
  the model as an exclusion list, along with the authors of the last twenty.
- A reply that repeats one anyway is caught and asked again once.

Today's quote is written to that history, so reopening or recreating today's
note reuses it instead of spending another model call. If no model is reachable
the placeholder is simply left empty — the note is still created.

The Home dashboard shows the same quote under its heading, and asks for one on
the first visit of the day whether or not your template uses `{{quote}}`.
Whichever surface asks first pays for the call and the other reads it back, so
the dashboard and the note never disagree about today's quote.

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

## arXiv news

The newspaper button in the left bar opens today's arXiv announcements for the
categories in `ARXIV_NEWS_CATEGORIES`. They are read from arXiv's public RSS
feed, so no key is needed. The listing is cached for as long as arXiv says it
stands (until the next announcement), kept on disk so a restart does not
refetch it, and checked by ETag once stale, so an unchanged feed costs a 304.
The AI ranking is saved the same way: one model call per listing, until the
instructions change or you press **Re-rank**.

- **Filter** keeps papers whose title, authors, or abstract contain every word
  you type. The category chips narrow the list to the ones you pick. Both are
  remembered, so tomorrow's listing opens filtered the same way.
- **Updates** also shows replacements, which are new versions of older papers.
  They are hidden by default.
- **Clip** adds the paper to today's daily note, under a `## Reading` heading
  that is created the first time. The line is the same citation a pasted arXiv
  link becomes. If today's note does not exist yet, it is created from the
  daily template. A paper already linked from today's note shows as Clipped.

### Ranking

**For you** orders the listing for you. The configured AI model reads the day's
papers against three things:

- **Your instructions** in `.webmd/news.md`: your research, and how papers
  should be judged, in your own words. **Instructions** in the News view opens
  the note, and starts one the first time. HTML comments in it are not sent.
  With no note, `ARXIV_NEWS_INTERESTS` is used instead.
- **What you read**: the titles of arXiv papers cited in your notes, including
  clipped ones, and the titles in `references.bib`.
- **What you are working on**: your most recently edited notes.

The model picks up to 20 papers, each with a score from 1 to 10, the research
area it connects to, and a one-sentence reason. The five strongest are listed
first as **Top picks**, then **Also relevant**. Everything else follows,
ordered by how much of your profile's rarer vocabulary each paper uses. That
same lexical score chooses the 120 papers the model reads, which keeps a day
of listings to one call. Updates are not judged.

A listing is ranked once per day, so reloads and other tabs reuse it, and
clipping a paper does not reshuffle the page. Editing the instructions note
earns a fresh ranking the next time you open News. **Re-rank** asks again
straight away. Without a reachable model the order falls back to the lexical
score, with a note saying so. **arXiv** switches back to arXiv's own order.

arXiv publishes no listing on Saturday or Sunday, so the view is empty on
weekends.

## Meetings

The lectern button in the left bar opens **Meetings**: the upcoming meetings of
the Indico categories and events you follow, one meeting's agenda, and a
Markdown note for it.

- **Add source** takes an Indico category link (`…/category/1234/`) or event
  link (`…/event/5678/`, or any page of the event). The link is checked and
  stored in canonical form; **Remove** takes it off again.
- Categories are read two weeks ahead. Meetings are grouped into **Ongoing**,
  **Today**, **Tomorrow**, **This week**, **Next week**, and **Later** by your
  browser's local day. Times show in local time, with the event's own time
  beside them when its timezone reads differently. A meeting listed by two
  sources appears once.
- Choose a meeting to see when and where, its agenda (times, titles,
  speakers, and links to each contribution), and **Open in Indico**.
- **Create note** writes a note for the meeting and opens it. Pressing it again,
  now labelled **Open note**, opens the same note. **Refresh** asks Indico
  again, skipping the ten-minute cache.

### Sources file

Sources are kept per workspace in `.webmd/meetings.json`, which is safe to
commit: it never holds a token.

```json
{
  "version": 1,
  "noteFolder": "/meetings",
  "sources": [
    {
      "id": "indico.cern.ch-category-1234",
      "label": "Weekly meetings",
      "origin": "https://indico.cern.ch",
      "url": "https://indico.cern.ch/category/1234/",
      "enabled": true
    }
  ]
}
```

`id` and `origin` are derived from `url`. Set `"enabled": false` to pause a
source, and `noteFolder` to put meeting notes elsewhere. An entry that does not
check out is skipped with a warning naming it, and the others still load. If
the file is not valid JSON, Meetings says so and refuses to overwrite it.

### Tokens and scopes

Public meetings need no token. For protected ones, create a personal token in
Indico under **My profile → Settings → API tokens** and put it in
`~/.webmd.conf`, then restart WebMD:

```conf
INDICO_CERN_TOKEN=indp_REPLACE_WITH_YOUR_TOKEN
```

- Meetings reads only Indico's documented HTTP export API (`/export/categ/…`
  and `/export/event/…`), which needs the **`read:legacy_api`** scope ("Classic
  API (read only)"). That is the least privilege it needs.
- Naming a pasted protected link reads the event's page first, which needs
  `read:everything`. With a `read:legacy_api` token it falls back to the export
  API, which names events and contributions but not sessions.
- The token goes in an `Authorization: Bearer` header to its own origin only.
  A redirect to another host, or off HTTPS, is not followed. The browser is
  told only whether a token is set.

### Meeting notes

A note is created in `noteFolder` as `Title (YYYY-MM-DD).md`, with frontmatter
naming the event, the time in the event's timezone, the Indico link, the room,
a snapshot of the agenda, and empty `## Notes` and `## Action items` sections:

```markdown
---
type: meeting
indico: https://indico.cern.ch/event/5678/
date: 2026-09-11
tags: [meeting]
---

# Tracking weekly (2026-09-11)
```

The `indico:` line is what ties the note to the meeting, so retitling or moving
the note keeps the link. Creating never overwrites a file: if the name is taken
by another note, the event id is added to the name. After that the note is
yours. Refreshing Indico never touches it, including its agenda.

### Troubleshooting

- **"rejected INDICO_CERN_TOKEN"**: the token is expired, revoked, or lacks
  `read:legacy_api`. Create a new one and restart WebMD.
- **"No upcoming meetings visible without a login"**: without a token Indico
  answers a protected category with an empty list, not an error. Set the
  token.
- **"is not a known Indico"**: the host does not start with `indico.`. Add
  `INDICO_<NAME>_URL=https://…` for it.
- **Timeouts or "Could not reach"**: the server running WebMD needs outbound
  HTTPS to the Indico. Each request gives up after 15 seconds.
- To check a token from the shell without starting WebMD:
  `INDICO_SMOKE_SOURCE=https://indico.cern.ch/category/1234/ npm run smoke:indico`.
  It only reads, and never prints the token.

## Note dates

Saving a note stamps its frontmatter with `creation-date` and
`last-modified-date`, so you can tell at a glance how old the information in a
note is:

```markdown
---
creation-date: 2024-03-02
last-modified-date: 2026-08-19
---
```

Both are written automatically, with no frontmatter block needed up front — one
is added when the note has none. `creation-date` is written once and never
rewritten; a note that predates this feature is dated by the age of its file
rather than by the day you happened to reopen it. `last-modified-date` moves at
most once a day, so a note only changes when its contents actually do.

Daily notes are exempt: their file name is already the date.

## YAML frontmatter

WebMD understands the Open Knowledge Format fields `type`, `title`,
`description`, `resource`, `tags`, and `timestamp` in a Markdown file's leading
YAML frontmatter. Preview renders the Markdown body, and workspace search can
filter any field with `field:value`, for example `type:Playbook`, `tags:oncall`,
or `timestamp:2026-07`. Tag matching is exact; other fields support partial,
case-insensitive matching.

## Scripts

- `npm run dev`: start backend and frontend locally.
- `npm run test`: run focused workspace safety tests.
- `npm run lint`: run syntax checks.
- `npm run build`: build the frontend into `dist/`.
- `npm run fixture`: serve a seeded throwaway workspace with a stub AI provider,
  arXiv feed, and Indico on port 3197 (`AI_MODE=slow|error`,
  `NEWS_MODE=error|empty`, `MEETINGS_MODE=notoken|auth|offline|none`). It never
  reads `~/.webmd.conf`, and its Indico token is a placeholder.
- `npm run scenarios`: after `npm run build`, run the headless Chrome layout
  and AI-context acceptance checks against fixtures (`OUT_DIR` keeps
  screenshots). Needs Google Chrome, or `CHROME_PATH`.
- `npm run scenarios:meetings`: the same for Meetings: list, agenda, notes,
  add source, token failures, and narrow layouts.
- `npm run smoke:indico`: opt-in, read-only check of a real Indico source with
  your own token (`INDICO_SMOKE_SOURCE=<link>`). Not part of `npm test`.
