<script>
  import { markdown } from '@codemirror/lang-markdown';
  import { EditorState } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { basicSetup } from 'codemirror';
  import { onDestroy, onMount } from 'svelte';
  import { renderMarkdown } from './markdown.js';

  let tree = [];
  let workspaceRoots = [];
  let selectedRoot = '0';
  let selectedPath = '';
  let content = '';
  let lastSaved = '';
  let status = '[Saved]';
  let error = '';
  let selectedText = '';
  let searchQuery = '';
  let searchResults = [];
  let searchStatus = '';
  let viewMode = 'edit';
  let expandedDirs = new Set();
  let loadedTreeOnce = false;
  let editorHost;
  let editorView;
  let saveTimer;
  let retryTimer;
  let searchTimer;
  let searchRun = 0;
  let fileCache = new Map();
  let applyingServerText = false;

  $: workspaceTree = cleanTree(tree);
  $: flatTree = flattenTree(workspaceTree, expandedDirs);
  $: fileCount = collectFiles(workspaceTree).length;
  $: renderedBlocks = renderMarkdown(content);
  $: queueWorkspaceSearch(searchQuery.trim(), workspaceTree);
  $: statusClass = status.includes('Offline')
    ? 'offline'
    : status.includes('Syncing')
      ? 'syncing'
      : 'saved';

  onMount(async () => {
    createEditor('');
    await loadRoots();
  });

  onDestroy(() => {
    editorView?.destroy();
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    clearTimeout(searchTimer);
  });

  function createEditor(doc) {
    editorView = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              content = update.state.doc.toString();
              if (!applyingServerText) scheduleSave();
            }
            if (update.docChanged || update.selectionSet)
              updateSelectedText(update.state);
          })
        ]
      })
    });
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const payload = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? await response.json()
      : null;
    if (!response.ok) throw new Error(payload?.error || response.statusText);
    return payload;
  }

  async function loadRoots() {
    try {
      workspaceRoots = await requestJson('/api/workspace/roots');
      selectedRoot = workspaceRoots[0]?.id ?? '0';
      await loadTree(selectedRoot);
    } catch (err) {
      error = err.message;
    }
  }

  async function loadTree(root = selectedRoot) {
    try {
      const nextTree = await requestJson(
        `/api/workspace/tree?root=${encodeURIComponent(root)}`
      );
      if (root === selectedRoot) {
        tree = nextTree;
        error = '';
      }
    } catch (err) {
      if (root === selectedRoot) error = err.message;
    }
  }

  async function switchWorkspace(root) {
    if (root === selectedRoot) return;
    if (selectedPath && content !== lastSaved) await saveNow();

    selectedRoot = root;
    tree = [];
    selectedPath = '';
    content = '';
    lastSaved = '';
    status = '[Saved]';
    error = '';
    searchQuery = '';
    searchResults = [];
    searchStatus = '';
    expandedDirs = new Set();
    loadedTreeOnce = false;
    fileCache = new Map();
    setEditorContent('');
    await loadTree();
  }

  async function openFile(path) {
    if (selectedPath && content !== lastSaved) await saveNow();

    const root = selectedRoot;
    selectedPath = path;
    status = '[Syncing...]';
    error = '';

    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (root !== selectedRoot || selectedPath !== path) return;
      const buffered = sessionStorage.getItem(storageKey(root, path));
      const nextContent = buffered ?? file.content;

      content = nextContent;
      lastSaved = file.content;
      fileCache.set(rootPathKey(root, path), nextContent);
      expandToPath(path);
      setEditorContent(nextContent);
      status = buffered ? '[Offline - Retrying]' : '[Saved]';
      if (buffered) queueRetry();
    } catch (err) {
      const buffered = sessionStorage.getItem(storageKey(root, path));
      if (buffered) {
        content = buffered;
        lastSaved = '';
        fileCache.set(rootPathKey(root, path), buffered);
        expandToPath(path);
        setEditorContent(buffered);
        status = '[Offline - Retrying]';
        queueRetry();
      } else {
        error = err.message;
        status = '[Offline - Retrying]';
      }
    }
  }

  function setEditorContent(nextContent) {
    applyingServerText = true;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: nextContent }
    });
    applyingServerText = false;
    updateSelectedText(editorView.state);
  }

  function scheduleSave() {
    if (!selectedPath) return;
    status = '[Syncing...]';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!selectedPath || content === lastSaved) return;

    const root = selectedRoot;
    const path = selectedPath;
    const nextContent = content;
    status = '[Syncing...]';

    try {
      await requestJson('/api/workspace/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path, content: nextContent })
      });
      sessionStorage.removeItem(storageKey(root, path));
      if (selectedRoot === root && selectedPath === path && content === nextContent) {
        lastSaved = nextContent;
        fileCache.set(rootPathKey(root, path), nextContent);
        status = '[Saved]';
      }
      await loadTree(root);
    } catch (err) {
      sessionStorage.setItem(storageKey(root, path), nextContent);
      error = err.message;
      status = '[Offline - Retrying]';
      queueRetry();
    }
  }

  function queueRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      await saveNow();
      if (
        selectedPath &&
        sessionStorage.getItem(storageKey(selectedRoot, selectedPath))
      )
        queueRetry();
    }, 2000);
  }

  function updateSelectedText(state) {
    const selection = state.selection.main;
    selectedText = selection.empty
      ? ''
      : state.sliceDoc(selection.from, selection.to);
  }

  function storageKey(root, path) {
    return `webmd:unsaved:${rootPathKey(root, path)}`;
  }

  function rootPathKey(root, path) {
    return `${root}:${path}`;
  }

  function flattenTree(nodes, expanded, level = 0) {
    return nodes.flatMap((node) => [
      {
        ...node,
        expanded: node.type === 'directory' && expanded.has(node.path),
        fileCount:
          node.type === 'directory'
            ? collectFiles(node.children || []).length
            : 0,
        level
      },
      ...(node.type === 'directory' && expanded.has(node.path)
        ? flattenTree(node.children || [], expanded, level + 1)
        : [])
    ]);
  }

  function cleanTree(nodes) {
    return nodes.flatMap((node) => {
      if (node.name.startsWith('.') || node.name === 'node_modules') return [];
      if (node.type === 'file') return [node];

      const children = cleanTree(node.children || []);
      return children.length ? [{ ...node, children }] : [];
    });
  }

  function collectFiles(nodes) {
    return nodes.flatMap((node) =>
      node.type === 'file' ? [node] : collectFiles(node.children || [])
    );
  }

  function collectDirectories(nodes) {
    return nodes.flatMap((node) =>
      node.type === 'directory'
        ? [node.path, ...collectDirectories(node.children || [])]
        : []
    );
  }

  function toggleFolder(path) {
    const next = new Set(expandedDirs);
    next.has(path) ? next.delete(path) : next.add(path);
    expandedDirs = next;
  }

  function expandAll() {
    expandedDirs = new Set(collectDirectories(workspaceTree));
  }

  function collapseAll() {
    expandedDirs = new Set();
  }

  function expandToPath(filePath) {
    const next = new Set(expandedDirs);
    const parts = filePath.split('/').filter(Boolean);
    let current = '';

    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      next.add(current);
    }

    expandedDirs = next;
  }

  function queueWorkspaceSearch(query, nodes) {
    clearTimeout(searchTimer);
    const run = ++searchRun;

    if (!query) {
      searchResults = [];
      searchStatus = '';
      return;
    }

    searchStatus = 'Searching...';
    searchTimer = setTimeout(() => searchWorkspace(query, nodes, run), 250);
  }

  async function searchWorkspace(query, nodes, run) {
    const needle = query.toLowerCase();
    const results = [];

    try {
      // ponytail: linear scan over visible Markdown files; add an index if big workspaces get slow.
      for (const file of collectFiles(nodes)) {
        if (run !== searchRun || results.length >= 50) return;

        if (file.path.toLowerCase().includes(needle)) {
          results.push({ ...file, kind: 'path' });
          continue;
        }

        const match = findContentMatch(
          await readSearchContent(file.path),
          needle
        );
        if (match) results.push({ ...file, kind: 'content', ...match });
      }

      if (run === searchRun) {
        searchResults = results;
        searchStatus = results.length ? '' : 'No matches';
      }
    } catch (err) {
      if (run === searchRun) searchStatus = err.message;
    }
  }

  async function readSearchContent(path) {
    if (path === selectedPath) return content;
    const key = rootPathKey(selectedRoot, path);
    if (fileCache.has(key)) return fileCache.get(key);

    const file = await requestJson(
      `/api/workspace/load?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(path)}`
    );
    fileCache.set(key, file.content);
    return file.content;
  }

  function findContentMatch(text, needle) {
    const index = text.toLowerCase().indexOf(needle);
    if (index === -1) return null;

    const lineStart = text.lastIndexOf('\n', index) + 1;
    const lineEnd = text.indexOf('\n', index);
    const line = text
      .slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      .trim();

    return {
      from: index,
      to: index + needle.length,
      lineNumber: text.slice(0, lineStart).split('\n').length,
      preview: line.length > 140 ? `${line.slice(0, 137)}...` : line
    };
  }

  async function openSearchResult(result) {
    await openFile(result.path);
    if (result.from != null) selectEditorRange(result.from, result.to);
  }

  function selectEditorRange(from, to) {
    setViewMode('edit');
    editorView.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    });
    editorView.focus();
  }

  function setViewMode(mode) {
    viewMode = mode;
    if (mode === 'edit')
      requestAnimationFrame(() => editorView?.requestMeasure());
  }

  $: if (!loadedTreeOnce && workspaceTree.length) {
    expandedDirs = new Set(
      workspaceTree
        .filter((node) => node.type === 'directory')
        .map((node) => node.path)
    );
    loadedTreeOnce = true;
  }
</script>

{#snippet inline(segments)}
  {#each segments as segment}
    {#if segment.type === 'code'}
      <code>{segment.text}</code>
    {:else if segment.type === 'link' && segment.href}
      <a href={segment.href} rel="noreferrer" target="_blank">{segment.text}</a>
    {:else if segment.type === 'strong'}
      <strong>{segment.text}</strong>
    {:else if segment.type === 'em'}
      <em>{segment.text}</em>
    {:else}
      {segment.text}
    {/if}
  {/each}
{/snippet}

<main class="app-shell">
  <aside class="sidebar" aria-label="Workspace files">
    <div class="brand-row">
      <div class="brand">WebMD</div>
      {#if workspaceRoots.length}
        <select
          aria-label="Switch folder"
          class="workspace-select"
          value={selectedRoot}
          on:change={(event) => switchWorkspace(event.currentTarget.value)}
        >
          {#each workspaceRoots as root}
            <option value={root.id}>{root.name}</option>
          {/each}
        </select>
      {/if}
    </div>
    <div class="sidebar-title">
      <span>Notes</span>
      <span>{fileCount} files</span>
    </div>
    <div class="sidebar-search">
      <input
        aria-label="Search files and contents"
        bind:value={searchQuery}
        placeholder="Search files and contents"
        type="search"
      />
      <div class="tree-actions" aria-label="Folder controls">
        <button
          aria-label="Collapse all folders"
          title="Collapse all folders"
          type="button"
          on:click={collapseAll}
        >
          -
        </button>
        <button
          aria-label="Expand all folders"
          title="Expand all folders"
          type="button"
          on:click={expandAll}
        >
          +
        </button>
      </div>
    </div>

    {#if searchQuery.trim()}
      <div class="search-results" aria-live="polite">
        {#each searchResults as result}
          <button
            class:active={result.path === selectedPath}
            class="search-result"
            type="button"
            on:click={() => openSearchResult(result)}
          >
            <span>{result.name}</span>
            <small
              >{result.kind === 'content'
                ? `Line ${result.lineNumber}`
                : result.path}</small
            >
            {#if result.preview}
              <em>{result.preview}</em>
            {/if}
          </button>
        {/each}
        {#if searchStatus}
          <p class="empty-copy">{searchStatus}</p>
        {/if}
      </div>
    {:else}
      <div class="tree">
        {#each flatTree as node}
          <button
            class:active={node.path === selectedPath}
            class:folder={node.type === 'directory'}
            aria-expanded={node.type === 'directory'
              ? node.expanded
              : undefined}
            style={`--level: ${node.level}`}
            type="button"
            on:click={() =>
              node.type === 'directory'
                ? toggleFolder(node.path)
                : openFile(node.path)}
          >
            <span aria-hidden="true"
              >{node.type === 'directory'
                ? node.expanded
                  ? '-'
                  : '+'
                : ''}</span
            >
            <span>{node.name}</span>
            {#if node.type === 'directory'}
              <small>{node.fileCount}</small>
            {/if}
          </button>
        {/each}
        {#if !flatTree.length}
          <p class="empty-copy">No Markdown files</p>
        {/if}
      </div>
    {/if}
  </aside>

  <section class="workspace">
    <header class="topbar">
      <div class="current-file">{selectedPath || 'No file selected'}</div>
      <div class="topbar-actions">
        <div class="view-toggle" aria-label="View mode">
          <button
            class:active={viewMode === 'edit'}
            disabled={!selectedPath}
            type="button"
            on:click={() => setViewMode('edit')}
          >
            Edit
          </button>
          <button
            class:active={viewMode === 'preview'}
            disabled={!selectedPath}
            type="button"
            on:click={() => setViewMode('preview')}
          >
            Preview
          </button>
        </div>
        <button
          class="save-button"
          disabled={!selectedPath || content === lastSaved}
          on:click={saveNow}
        >
          Save
        </button>
      </div>
    </header>

    {#if error}
      <div class="error-banner" role="alert">{error}</div>
    {/if}

    <div class:empty={!selectedPath} class="editor-frame">
      {#if !selectedPath}
        <div class="empty-state">Open a Markdown file from Notes.</div>
      {/if}
      <div
        bind:this={editorHost}
        class:hidden={viewMode !== 'edit'}
        class="editor-host"
      ></div>
      {#if selectedPath}
        <article
          aria-label="Rendered Markdown preview"
          class:hidden={viewMode !== 'preview'}
          class="preview-pane"
        >
          {#if renderedBlocks.length}
            {#each renderedBlocks as block}
              {#if block.type === 'heading'}
                <svelte:element this={`h${block.level}`}>
                  {@render inline(block.children)}
                </svelte:element>
              {:else if block.type === 'paragraph'}
                <p>{@render inline(block.children)}</p>
              {:else if block.type === 'quote'}
                <blockquote>{@render inline(block.children)}</blockquote>
              {:else if block.type === 'rule'}
                <hr />
              {:else if block.type === 'code'}
                <pre><code>{block.text}</code></pre>
              {:else if block.type === 'list'}
                <svelte:element this={block.ordered ? 'ol' : 'ul'}>
                  {#each block.items as item}
                    <li class:task={item.task}>
                      {#if item.task}
                        <input
                          checked={item.checked}
                          disabled
                          type="checkbox"
                        />
                      {/if}
                      <span>{@render inline(item.children)}</span>
                    </li>
                  {/each}
                </svelte:element>
              {/if}
            {/each}
          {:else}
            <p class="preview-empty">Empty file</p>
          {/if}
        </article>
      {/if}
    </div>

    <footer class="statusbar">
      <span class={statusClass}>{status}</span>
      <span
        >{selectedText
          ? `${selectedText.length} selected`
          : 'Selected text: 0'}</span
      >
    </footer>
  </section>
</main>
