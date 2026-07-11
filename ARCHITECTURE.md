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
* **Styling Framework:** **Tailwind CSS v4** coupled with the `@tailwindcss/typography` (`prose`) plugin for hardware-accelerated fluid presentation layout and structured text translation.

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

### 3.2 File System Mutation Boundaries
1. **Root Directory Chroot-Jail Emulation:** The server must map execution context to an isolated `$WORKSPACE_ROOT` parameter. Directory traversal vectors (`../../etc/passwd`) must be aggressively blocked via strict canonical path validation hooks inside Express routers. Symlinks that resolve outside `$WORKSPACE_ROOT` are forbidden.
2. **Lockless Atomic Operations:** Overwriting active notes must utilize memory-staged atomic proxy execution swaps (`fs.promises.writeFile` to a temporary hidden file followed by immediate renamed sync steps) to completely nullify file fragmentation corruptions if tunnels abort mid-payload delivery.

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
workspace is a repository. Recently opened paths remain browser-local because
they are UI history rather than workspace content.

The first version contains Today, Continue, Recently modified, and Workspace
changes. Workspace-wide AI summaries, charts, and activity metrics remain
deferred until their underlying data exists.

`GET /api/workspace/graph` builds a server-side index of Markdown notes and
resolved wiki links, caches it until the workspace changes, and returns only
compact node and edge metadata. The client renders Wiki, Local, and All scopes
as an interactive native SVG graph, so note bodies and large workspace assets
do not cross a high-latency SSH tunnel.

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
  "contextSelection": "Client requires sub-millisecond typing responses and full SSH encapsulation loops."
}

```

* **Success Signature (`200 OK - Header: Content-Type: text/event-stream`):**

```
data: {"text": "Summarized"}
data: {"text": " technical"}
data: {"text": " scope:"}

```

---

## 7. Cross-Cutting Concerns: State Synchronization & Fault Tolerance

### 7.1 Input Synchronization & Throttled Background Saves

To prevent continuous structural remote writing cycles on every physical keystroke event while ensuring complete protection against terminal window drop events:

* **Keystroke De-bouncing Engine:** Instantiates explicit `3000ms` mutation delay pipelines for whole-file fallback saves. Collaborative sessions stream smaller CM6 updates immediately and let the server snapshot them to disk.
* **State Flag Architecture:** Explicitly displays atomic tracking visual layout indicators (`[Saved]`, `[Syncing...]`, `[Offline - Retrying]`) reflecting actual synchronization status.

### 7.2 Disconnection Recovery Strategy

If physical SSH tunnels or underlying transport sockets fracture mid-editing workflow:

1. **Local Storage Quarantine Buffer:** Upon hitting HTTP network request failure paths, Svelte application layers must intercept incoming document structural mutations and redirect transient delta modifications straight into browser volatile session memory space (`sessionStorage`).
2. **Re-connection Verification Protocol:** The frontend instantiates background network polling checks toward `/api/workspace/tree`. Once connection targets confirm operational viability, any local temporary buffer data states automatically forward a sync overwrite downstream to clean up the backend repository state, purging local client browser footprints entirely.
