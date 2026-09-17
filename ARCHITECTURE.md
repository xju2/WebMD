# ARCHITECTURE.md

## 1. System Overview & Core Objectives

This document establishes the technical blueprint and architectural design for an open-source, remote-first, AI-native Markdown workspace. The core system operates under a strict data-ownership paradigm: **all Markdown files and intelligence layers must reside and execute on a remote target server**, accessible securely from any client browser through an encrypted SSH tunnel.

### 1.1 Core Objectives
* **Strict Remote Storage:** Absolute decoupled client/server boundary. Files are never cached permanently, synchronized locally, or exposed to vendor clouds on the client device. Temporary `sessionStorage` recovery buffers are allowed only for unsaved edits after transport failure and must be purged after successful resync.
* **AI-Native Interactions:** Deep situational context injection. Highlighting any text slice instantly updates the execution model's state for sidebar chat and inline multi-turn editing.
* **Sub-millisecond Typing Fidelity:** Zero-lag input response. Decoupled UI state frameworks from structural text-editing nodes to prevent keystroke execution blocking.

---

## 2. Technical Stack Matrix

The selected architectural ecosystem optimizes for runtime speed, developer velocity, explicit state management, and minimal binary footprint.


```

+-------------------------------------------------------------------------+
|                          CLIENT BROWSER LAYER                           |
|                                                                         |
|  +--------------------+  +-----------------------+  +----------------+  |
|  |     UI & State     |  |      Editor Core      |  | Styling Layer  |  |
|  |    Svelte + Vite   |  |     CodeMirror 6      |  |  Tailwind CSS  |  |
|  +--------+-----------+  +-----------+-----------+  +-------+--------+  |
+-----------|--------------------------|----------------------|-----------+
|                          |                      |
+------------+-------------+                      |
|                                    |
[ REST APIs / Server-Sent Events ]                |
|                                    |
+------------------------|------------------------------------|-----------+
|                        v                                    |           |
|         +-----------------------------+                     v           |
|         |     Node.js Express App     | <--------- [ @tailwindcss/  |           |
|         |    (127.0.0.1 Loopback)     |              typography ]   |           |
|         +-----+-----------------+-----+                             |           |
|               |                 |                                   |           |
|  +------------v------------+    |                                   |           |
|  |     Filesystem I/O      |    |                                   |           |
|  |   Target .md Directory  |    |                                   |           |
|  +-------------------------+    |                                   |           |
|                                 v                                   |           |
|                  +------------------------------+                   |           |
|                  |      Intelligence Layer      |                   |           |
|                  |  Ollama (Local DeepSeek/Llama)                   |           |
|                  |      or Secured API Proxy    |                   |           |
|                  +------------------------------+                   |           |
|                                                                     |
|                            REMOTE SERVER                            |
+-------------------------------------------------------------------------+

```

### 2.1 Frontend Matrix
* **Framework:** **Svelte 5** (Reactivity via Runes). Chosen for its compilation model which converts interactive logic into direct DOM micro-mutations, bypassing Virtual DOM diffing tax during massive text rendering cycles.
* **Editor Core:** **CodeMirror 6 (CM6)**. Chosen for its modular functional architecture, transaction-based document pipeline, fully responsive mobile viewport adaptation, and explicit viewport windowing performance.
* **Build System:** **Vite**. Leverages native ES modules for instantaneous Hot Module Replacement (HMR) cycles during remote tunnel building.
* **Styling:** One shared plain-CSS stylesheet, `src/styles.css`, built on the design tokens described in "Visual Design System" below. (An earlier plan named Tailwind CSS; it was never adopted.)

> **Current implementation note.** The component split sketched in §4.1
> (`Sidebar.svelte`, `Editor.svelte`, `ChatSidebar.svelte`) describes
> responsibilities, not files: the checkout keeps them together in
> `src/App.svelte`, with CodeMirror wiring in `src/editor.js`.

### 2.3 Visual Design System ("Quiet Workspace")

The interface is a calm reading-and-writing surface, so chrome recedes and
content carries the contrast.

* **Tokens first.** Colours, radii, control heights, shadows, and the focus
  ring are CSS custom properties on `:root` in `src/styles.css`. New UI uses
  the tokens rather than literal colours. Semantic colours that carry meaning
  (task urgency, diff lines, callout variants, syntax tokens, graph groups)
  stay literal on purpose.
* **Surfaces.** White for content; a near-white neutral for the rail and
  sidebar; hairline `--border` separators instead of boxes. Inactive controls
  are unboxed; only inputs and secondary buttons carry a light border.
* **One accent.** Teal (`--accent`, 5.4:1 on white) marks the active rail
  item, the selected file, segmented-control selection, primary actions, and
  links. Pale teal (`--accent-soft`) is the selection wash. Nothing else
  competes with it.
* **Contrast.** Body text and muted text meet WCAG AA (≥4.5:1) on every
  surface they sit on; only disabled controls fall below.
* **Focus.** Every interactive element shows the same 2px teal
  `:focus-visible` outline; rail tooltips also appear on keyboard focus.
* **View-aware toolbar.** Document actions (daily-note stepping, Upload,
  Delete, Reference, Edit/Preview, Diff) appear only in document views. The
  workspace views launched from the rail (Tasks, Calendar, arXiv News) own
  their own toolbars and keep only navigation and the overflow menu above.
  Meetings is one of them too. It stays mounted once visited, so its list and
  selection survive a trip to a note.
* **Mockup content is illustrative.** Titles, counts, and AI text always come
  from the workspace and APIs; titles are never truncated server-side.

### 2.4 Panel Layout

The shell is a grid: rail (52px) | file sidebar | center | AI panel. The side
panels are siblings of the center, so opening, closing, or resizing them only
changes grid columns; the editor, its selection, and the AI thread stay
mounted.

* **Preferences vs. transient state.** `src/layout.js` owns the model. What
  the user chose (`filesOpen`, `aiOpen`, `filesWidth`, `aiWidth`) persists in
  `localStorage` under `webmd:layout`; nothing else is stored there, never
  documents or conversations. Overlay flags on narrow screens are transient,
  so squeezing the window never rewrites the desktop layout.
* **Docking rules.** `resolveLayout` keeps at least `CENTER_MIN` (520px) for
  the center. Files docks first; AI docks only if the room left after the
  docked sidebar still fits its minimum, otherwise it opens as an overlay.
  At ≤760px both panels are overlays, one at a time, over an inert workspace
  with a backdrop; Escape or the close button returns focus to where it was.
* **Widths.** Files 180–480px (240 initial), AI 280–720px (340 initial).
  Handles are `role="separator"` window splitters: drag, arrow keys (Shift
  for larger steps), Home/End, and double-click to reset.
* **Quiet toolbar.** The document toolbar keeps only the Day stepper and
  the Edit/Preview toggle; Upload, Delete (in red), and Reference live in the
  ... menu at every width.
* **Honest status.** The sidebar footer (`src/save-status.js`) says saved
  only for an open note with nothing pending; offline, saving, and read-only
  states say so. It is the one save status: the bottom bar shows it only
  while the sidebar is hidden.

### 2.2 Backend Matrix
* **Runtime Environment:** **Node.js LTS**. Provides standard event-driven I/O loop performance perfect for handling parallel low-overhead streaming connections.
* **Application Framework:** **Express**. Configured explicitly to attach exclusively to loopback network interfaces, avoiding public port allocation vectors.
* **AI Orchestration Framework:** **Vercel AI SDK Core**. Standardizes downstream multi-modal LLM response streams directly into unified Web API standard streams across local Ollama and remote API providers.

---

## 3. Structural Constraints & Operational Guards

### 3.1 Network & Topology Constraints
1. **Loopback Binding Isolation:** The Node.js application must explicitly lock socket binding exclusively to `127.0.0.1`. Attempting to allocate `0.0.0.0` or missing structural parameters must abort server startup sequence immediately.
2. **Asymmetric Network Profile:** Client browsers interface with the environment completely within an active `ssh -L [LOCAL_PORT]:127.0.0.1:[REMOTE_PORT]` session. The architecture must gracefully absorb transient socket resets inherent to unstable physical tunnel channels.
3. **Authentication Boundary:** SSH tunnel access is the MVP security boundary. No separate app login or bearer token is required until the server is exposed beyond loopback or shared-host access becomes a real requirement.
4. **Outbound Credentials:** Third-party tokens (Indico) live only in the server's environment. Each is bound to one exact HTTPS origin and sent there only. Redirects are followed by hand and never across origins, and the browser learns only whether a token is configured. Server-side fetches of user-supplied addresses are limited to HTTPS Indico hosts on the default port, with no credentials in the URL.

### 3.2 File System Mutation Boundaries
1. **Root Directory Chroot-Jail Emulation:** The server must map execution context to an isolated `$WORKSPACE_ROOT` parameter. Directory traversal vectors (`../../etc/passwd`) must be aggressively blocked via strict canonical path validation hooks inside Express routers. Symlinks that resolve outside `$WORKSPACE_ROOT` are forbidden.
   With no `$WORKSPACE_ROOT` configured, the root is the sandbox, a per-user copy (`~/.local/share/webmd/sandbox`) of the repository's `sandbox/` example workspace. The server never serves the in-repo `sandbox/` itself: edits would dirty the checkout, and auto-commit resolves the git repository from the root upward, so it would sweep WebMD's own repository. For the same reason, the sandbox is never auto-committed.
2. **Lockless Atomic Operations:** Overwriting active notes must utilize memory-staged atomic proxy execution swaps (`fs.promises.writeFile` to a temporary hidden file followed by immediate renamed sync steps) to completely nullify file fragmentation corruptions if tunnels abort mid-payload delivery.
3. **Create Without Overwrite:** Notes the server writes on the user's behalf (meeting notes) are created through a temp file and `link()`, which fails rather than replace an existing file, so a generated name can never clobber a user's note.
   Later changes the server makes to such a note at the user's request (a meeting's `recording:` link, an AI summary) go through `workspace.editFile`, which works out the change inside the document's write queue and broadcasts it as one ordinary collaborative version, so an editor with the note open rebases onto it. An existing `## Summary` is refused, never replaced.

---

## 4. Architectural Component Deep Dive

### 4.1 Frontend Architecture & Component Assembly
The client application structure is organized into isolated, reactive modules communicating through Svelte's global orchestration store context layer.

#### 4.1.1 Workspace Orchestrator (`App.svelte`)
Coordinates the baseline visual grid workspace. Manages viewport division ratios, layout states (Sidebar active vs collapsed), and global file focus registers (`currentFilePath`).

#### 4.1.2 File Navigation Core (`Sidebar.svelte`)
Queries recursive structural file payload trees from the backend. Dynamically updates localized states and tracks folder expansion states inside memory trees.

#### 4.1.3 The Editor Pipeline (`Editor.svelte`)
Wraps the CodeMirror 6 engine instance. It translates structural mutations into explicit actions.


```
   +---------------------------------------------+
   |             CodeMirror 6 Engine             |
   +--------------------+------------------------+
                        |
       [ Broadcasts State Changes / Selections ]
                        |
                        v
   +---------------------------------------------+
   |          EditorView.updateListener          |
   +--------------------+------------------------+
                        |
    [ Updates Context State / Sets Selections ]
                        |
                        v
   +---------------------------------------------+
   |          Svelte Context State Rune          |
   |  (bind:selectedText / activeDocumentState)  |
   +---------------------------------------------+

```

* **CM6 Extensions Attached:** `EditorView.lineNumbers()`, `markdown()`, `EditorView.theme()`, and a highly optimized `EditorView.updateListener`.
* **Selection State Capture:** The update listener monitors document range offsets. When a user highlights text strings, it calculates absolute document mutations and securely writes the targeted value into Svelte's reactive `$state` rune context string.
* **Collaborative Editing:** Use CodeMirror's collaborative update flow for multi-user documents. Clients push document updates with a base revision, subscribe to remote updates, and rebase automatically instead of overwriting each other.

#### 4.1.4 Intelligence Panels (`ChatSidebar.svelte` & `InlineOverlay.svelte`)
Consumes Svelte state selection states. Emits structured payloads downstream into backend APIs via continuous streaming architectures, feeding incoming line tokens back into markdown UI viewports via semantic block renderers. Inline AI edits must render a diff preview first; the editor applies the replacement only after user acceptance.

The AI context shown in the composer and the context sent come from one object
(`chatContext` in `src/ai-context.js`), which mirrors the server's
`chatMessages`: a selection is sent alone; otherwise the open note is sent
(read from disk, up to 12,000 characters) only while it is visible, so Tasks,
Calendar, and arXiv News send no note even when one is open underneath. The
underlying note is never labelled as a paper; paper context is deferred.

---

## 5. System Data Flows & Core Integration Lifecycles

### 5.1 Document Initialization and Hydration Flow

```

Client Browser               SSH Tunnel               Node.js Server             Target Disk
|                           |                          |                         |
|--- Get Document --------->|------------------------->|                         |
|    (/api/load?path=...)   |                          |--- Read File String --->|
|                           |                          |<-- [Raw Markdown text] -|
|<-- JSON Payload ----------|<-------------------------|                         |
|    { content: "..." }     |                          |                         |
|                           |                          |                         |

```
1. Client issues explicit asynchronous `GET` requests detailing target documents.
2. Server validates paths against root storage boundary permissions, extracts real-time payloads via `utf8` character sets, and formats structural payloads inside uniform JSON blocks.
3. CodeMirror instances absorb the incoming payloads, purge active undo-history stacks, and instantiate clean UI document structures.

### 5.2 Threaded Intelligent Streaming Workflow

```

Client Browser               SSH Tunnel               Node.js Server             AI Endpoint
|                           |                          |                         |
|--- Send Prompt Packet --->|------------------------->|                         |
|    (Prompt + Selection)   |                          |--- Initialize SSE ----->|
|                           |                          |    Stream Loop          |
|                           |                          |<-- Token 1 -------------|
|<-- Stream Token 1 --------|<-------------------------|                         |
|                           |                          |<-- Token 2 -------------|
|<-- Stream Token 2 --------|<-------------------------|                         |
|                           |                          |                         |

```
1. User highlights text context inside CM6 views and invokes the prompt submission mechanism (`Cmd + Enter`).
2. Frontend encapsulates structural context payloads (Target string snippets + Global document markers + Active Prompt strings) and initiates requests toward endpoints.
3. Server receives request parameters, pipes configurations securely into Vercel AI SDK core engine wrappers, and proxies structural instructions directly into the configured LLM provider. Local Ollama is supported, and remote providers are supported through server-side API keys.
4. Response chains translate back to the primary Express context router which immediately activates a continuous `text/event-stream` Server-Sent Events (SSE) socket channel.
5. The frontend reads incoming streaming token elements securely via chunk stream decoders, incrementally resolving textual updates directly onto active visual presentation elements.

---

## 6. Comprehensive API Endpoints Specification

### 6.1 Workspace Core Operations

#### Workspace Home

The editor's no-file state is the Workspace Home. It stays inside `App.svelte`
instead of adding a router or a second application. It supports the core
research loop—capture, resume, and review—by reusing the existing file-opening,
daily-note, search, and workspace-switching flows.

`GET /api/workspace/overview` returns supported-file counts, the six most
recently modified Markdown notes, and changed Markdown paths from Git when the
workspace is a repository. Continue lists the notes this browser has edited,
not the ones it opened, so reading around the workspace never displaces the
work in progress; those paths stay browser-local because they are UI history
rather than workspace content.

The first version contains Today, Continue, Recently modified, and Workspace
changes. Workspace-wide AI summaries, charts, and activity metrics remain
deferred until their underlying data exists.

Daily notes have a separate Calendar view launched from the global rail. It
uses the workspace's daily-note folder (`GET /api/settings`) and browser-local dates, marks existing
date-named Markdown files, and lets a date either open its note or create it.

`GET /api/workspace/graph` builds a server-side index of Markdown notes and
resolved wiki links, caches it until the workspace changes, and returns only
compact node and edge metadata. The client renders Wiki, Local, and All scopes
as an interactive native SVG graph, so note bodies and large workspace assets
do not cross a high-latency SSH tunnel.

#### Workspace Settings
* **Endpoint:** `GET /api/settings?root=<id>`
* **Role:** The workspace's layout, read from `$WORKSPACE_ROOT/.webmd/settings.json` on every request and never created by it. `imageAssetFolder` falls back to `IMAGE_ASSET_FOLDER`, then `/assets`. `dailyNoteFolderConfigured` is false when the default `/raw/dailynotes` is in use, so the client may fall back to `/` if that folder does not exist. `dailyNoteTemplate` is `null` when unset (use a conventionally named template) and `""` for none. The UI has no controls for any of these; a value that cannot be used is dropped and named in `warning`.
* **Success Signature (`200 OK`):**
```json
{
  "imageAssetFolder": "/assets",
  "dailyNoteFolder": "/raw/dailynotes",
  "dailyNoteFolderConfigured": true,
  "dailyNoteTemplate": null
}
```

#### File Tree Retrieval
* **Endpoint:** `GET /api/workspace/tree`
* **Success Signature (`200 OK`):**
```json
[
  {
    "name": "Project Notes",
    "type": "directory",
    "path": "/Project Notes",
    "children": [
      {
        "name": "architecture.md",
        "type": "file",
        "path": "/Project Notes/architecture.md"
      }
    ]
  }
]

```

#### File Content Retrieval

* **Endpoint:** `GET /api/workspace/load`
* **Query Parameters:** `path=/Project Notes/architecture.md`
* **Success Signature (`200 OK`):**

```json
{
  "path": "/Project Notes/architecture.md",
  "content": "# Architecture System Docs\\n\\nSystem context records go here..."
}

```

#### Document Persistence

* **Endpoint:** `POST /api/workspace/save`
* **Role:** Atomic whole-file persistence for initial MVP saves, recovery flushes, and non-collaborative maintenance operations. Active editor sessions should prefer collaborative update endpoints.
* **Payload Interface Configuration:**

```json
{
  "path": "/Project Notes/architecture.md",
  "content": "# Architecture System Docs\\n\\nSystem context records go here... updated edits."
}

```

* **Success Signature (`200 OK`):**

```json
{ "success": true, "timestamp": "2026-07-08T23:20:00.000Z" }

```

#### Collaborative Document Updates

* **Endpoint:** `POST /api/workspace/updates`
* **Payload Interface Configuration:**

```json
{
  "path": "/Project Notes/architecture.md",
  "version": 12,
  "updates": []
}

```

* **Success Signature (`200 OK`):**

```json
{ "success": true, "version": 13 }

```

* **Endpoint:** `GET /api/workspace/events?path=/Project Notes/architecture.md&since=12`
* **Success Signature (`200 OK - Header: Content-Type: text/event-stream`):**

```
data: {"version":13,"updates":[]}

```

The server owns the revision log and periodically writes atomic snapshots to disk. Clients subscribe to document events, apply remote updates into CodeMirror, and rebase local pending edits before pushing.

### 6.2 Intelligence Operations

#### Contextual Assistant Vector

* **Endpoint:** `POST /api/ai/chat`
* **Payload Interface Configuration:**

```json
{
  "messages": [
    { "role": "user", "content": "Condense this client technical scope meeting note structure." }
  ],
  "contextSelection": "Client requires sub-millisecond typing responses and full SSH encapsulation loops.",
  "presetId": "ask-summarize"
}

```

`presetId` is optional and must name a `kind: "chat"` preset; its server-side system prompt replaces the default assistant persona, and a typed prompt narrows it. Like the edit route, the preset resolves before the stream opens so a bad id returns `400` rather than an SSE error event.

* **Success Signature (`200 OK - Header: Content-Type: text/event-stream`):**

```
data: {"text": "Summarized"}
data: {"text": " technical"}
data: {"text": " scope:"}

```

#### Prompt Presets

* **Endpoint:** `GET /api/ai/presets`
* **Role:** Lists the named prompts available for a workspace: built-in presets merged with `$WORKSPACE_ROOT/.webmd/prompts.json`, where a repeated `id` overrides the built-in. `kind` tells the client which route a preset belongs to — `edit` rewrites the selection via `POST /api/ai/edit`, `chat` asks about the whole note via `POST /api/ai/chat` — and `group` is the outer list in the panel's two-pane picker. Preset system prompts are deliberately omitted from the response and stay server-side alongside provider credentials.
* **Success Signature (`200 OK`):**

```json
{
  "presets": [
    {
      "id": "academic-tighten",
      "label": "Tighten (academic)",
      "group": "Paper",
      "kind": "edit",
      "instruction": "Tighten this passage without changing what it claims."
    }
  ],
  "warning": "Ignored 1 preset(s) in /.webmd/prompts.json missing id, label, or system: #2."
}

```

#### Inline Edit Vector

* **Endpoint:** `POST /api/ai/edit`
* **Payload Interface Configuration:**

```json
{
  "path": "/Project Notes/architecture.md",
  "selectedText": "The results were possibly indicative of a trend.",
  "presetId": "academic-tighten",
  "instruction": "keep the citation"
}

```

Either `presetId` or `instruction` is required; supplying both refines the preset. `presetId` must name a `kind: "edit"` preset. Preset resolution happens before the stream opens, so a bad request still returns `400` instead of an SSE error event.

* **Success Signature (`200 OK - Header: Content-Type: text/event-stream`):**

```
data: {"text": "The results indicate"}
data: {"text": " a consistent trend."}
data: {"done": true, "replacement": "The results indicate a consistent trend."}

```

The final event is authoritative. Code fences can only be stripped once the whole reply has arrived, so clients apply `replacement` rather than their own concatenated deltas. The editor renders the accumulating text as a live diff and commits it only after the user accepts.

#### Project Filing Vector

* **Endpoint:** `POST /api/ai/project-log`
* **Role:** Given a daily note, names the project notes that day advanced and the one line each should gain. Offered only for a daily note in the workspace's daily-note folder, because the write lands in notes the reader is not looking at.
* **Payload Interface Configuration:**

```json
{
  "root": "/Users/me/notes",
  "path": "/raw/dailynotes/2026-07-09.md",
  "dailyNoteFolder": "/raw/dailynotes"
}

```

* **Success Signature (`200 OK`):**

```json
{
  "entries": [
    {
      "path": "/wiki/projects/triton.md",
      "title": "Triton serving",
      "summary": "Requests started dropping once the GPU instance count went past four.",
      "source": "2026-07-09"
    }
  ],
  "filed": ["/wiki/projects/retrieval.md"],
  "candidateCount": 9,
  "warning": null
}

```

Candidates are ranked by TF-IDF cosine similarity over the workspace's Markdown cache (`server/project-log.js`), which narrows a few hundred notes to a shortlist the model reads in full; the model does the judging and can only answer with paths it was offered. Notes inside `dailyNoteFolder` are never candidates, and notes that already link back to the day are returned as `filed` rather than offered again, so filing a day twice cannot double an entry. `source` is the backlink as the project note will carry it — shortened as seen from there, and verified to resolve back to the day.

**The endpoint only reads.** Filing is one ordinary `POST /api/workspace/updates` per project note, sent by the client as the reader works through the list, so it rides the same versioned-update path with 409 retry that a clipped paper takes into today's daily note. A run abandoned halfway leaves every note it never reached untouched. The bullet is appended under `## Log`, created at the end of the note when it has none.

---

## 7. Cross-Cutting Concerns: State Synchronization & Fault Tolerance

### 7.1 Input Synchronization & Throttled Background Saves

To prevent continuous structural remote writing cycles on every physical keystroke event while ensuring complete protection against terminal window drop events:

* **Keystroke De-bouncing Engine:** Instantiates explicit `3000ms` mutation delay pipelines for whole-file fallback saves. Collaborative sessions stream smaller CM6 updates immediately and let the server snapshot them to disk.
* **State Flag Architecture:** The editor tracks `[Saved]`, `[Syncing...]`, and `[Offline - Retrying]` internally; `src/save-status.js` turns them into the sidebar footer's wording.

### 7.2 Disconnection Recovery Strategy

If physical SSH tunnels or underlying transport sockets fracture mid-editing workflow:

1. **Local Storage Quarantine Buffer:** Upon hitting HTTP network request failure paths, Svelte application layers must intercept incoming document structural mutations and redirect transient delta modifications straight into browser volatile session memory space (`sessionStorage`).
2. **Re-connection Verification Protocol:** The frontend instantiates background network polling checks toward `/api/workspace/tree`. Once connection targets confirm operational viability, any local temporary buffer data states automatically forward a sync overwrite downstream to clean up the backend repository state, purging local client browser footprints entirely.
