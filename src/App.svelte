<script>
  import { markdown } from '@codemirror/lang-markdown';
  import { EditorState } from '@codemirror/state';
  import { EditorView } from '@codemirror/view';
  import { basicSetup } from 'codemirror';
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    rebaseRemoteUpdate,
    updateFromChangeSet as createCollabUpdate
  } from './collab.js';
  import { buildReplacementDiffFile, parseUnifiedDiff } from './diff.js';
  import { renderMarkdown } from './markdown.js';
  import { resolveWikiLinkPath } from './wiki-links.js';

  const SEARCH_HISTORY_KEY = 'webmd:search-history';
  const SEARCH_HISTORY_LIMIT = 8;
  const DAILY_NOTE_FOLDER_KEY = 'webmd:daily-note-folder';
  const CLIENT_ID =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let tree = [];
  let workspaceRoots = [];
  let selectedRoot = '0';
  let selectedPath = '';
  let selectedFileKind = 'markdown';
  let content = '';
  let lastSaved = '';
  let status = '[Saved]';
  let error = '';
  let selectedText = '';
  let searchQuery = '';
  let searchHistory = [];
  let searchResults = [];
  let searchStatus = '';
  let chatPrompt = '';
  let chatMessages = [];
  let chatStatus = '';
  let chatStreaming = false;
  let chatAbort;
  let inlineEditStatus = '';
  let inlineEditLoading = false;
  let inlineEditPreview = null;
  let selectedRange = null;
  let viewMode = 'edit';
  let diffFiles = [];
  let diffStatus = '';
  let sidebarVisible = true;
  let dailyNoteFolder = '/';
  let expandedDirs = new Set();
  let loadedTreeOnce = false;
  let appShell;
  let editorHost;
  let treeHost;
  let editorView;
  let saveTimer;
  let retryTimer;
  let searchTimer;
  let searchRun = 0;
  let fileCache = new Map();
  let navigationBackStack = [];
  let navigationForwardStack = [];
  let applyingServerText = false;
  let documentVersion = 0;
  let collaborationEnabled = false;
  let documentEvents;
  let pendingUpdates = [];
  let inFlightUpdates = [];
  let sendingUpdates = false;
  let sendPromise = Promise.resolve();
  let sendRun = 0;
  let updateSequence = 0;

  $: workspaceTree = cleanTree(tree);
  $: workspaceFiles = collectFiles(workspaceTree);
  $: markdownFiles = workspaceFiles.filter(
    (file) => file.fileKind === 'markdown'
  );
  $: dailyNoteFolders = ['/', ...collectVisibleDirectories(tree)];
  $: flatTree = flattenTree(workspaceTree, expandedDirs);
  $: fileCount = workspaceFiles.length;
  $: selectedIsMarkdown = selectedFileKind === 'markdown';
  $: selectedIsMedia = selectedPath && !selectedIsMarkdown;
  $: canNavigateBack = navigationBackStack.length > 0;
  $: canNavigateForward = navigationForwardStack.length > 0;
  $: canInlineEdit = Boolean(
    selectedPath &&
      selectedIsMarkdown &&
      selectedRange &&
      selectedRange.from !== selectedRange.to
  );
  $: mediaPreviewUrl = selectedIsMedia ? mediaUrl(selectedPath) : '';
  $: renderedBlocks =
    selectedIsMarkdown && viewMode === 'preview' ? renderMarkdown(content) : [];
  $: queueWorkspaceSearch(searchQuery.trim(), selectedRoot, workspaceTree);
  $: statusClass = status.includes('Offline')
    ? 'offline'
    : status.includes('Syncing')
      ? 'syncing'
      : 'saved';

  onMount(async () => {
    searchHistory = readSearchHistory();
    createEditor('');
    document.addEventListener('selectionchange', updateBrowserSelectedText);
    window.addEventListener('popstate', openNavigationState);
    await loadRoots();
  });

  onDestroy(() => {
    document.removeEventListener('selectionchange', updateBrowserSelectedText);
    window.removeEventListener('popstate', openNavigationState);
    closeDocumentEvents();
    chatAbort?.abort();
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
              if (!applyingServerText) queueLocalUpdate(update.changes);
            }
            if (update.docChanged || update.selectionSet)
              updateSelectedText(update.state);
          })
        ]
      })
    });
  }

  async function requestJson(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error('Server unavailable. Check the SSH tunnel and backend.');
    }
    const payload = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? await response.json()
      : null;
    if (!response.ok) {
      const error = new Error(payload?.error || response.statusText);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function responseErrorMessage(response) {
    try {
      const payload = await response.json();
      if (payload?.error) return payload.error;
    } catch {
      // Fall back to the HTTP status text below.
    }
    return response.statusText || `HTTP ${response.status}`;
  }

  async function sendChat() {
    const prompt = chatPrompt.trim();
    if (!prompt || chatStreaming) return;

    chatPrompt = '';
    chatStatus = 'Thinking...';
    chatStreaming = true;
    chatAbort?.abort();
    chatAbort = new AbortController();
    chatMessages = [
      ...chatMessages,
      { role: 'user', text: prompt },
      { role: 'assistant', text: '' }
    ];

    try {
      let response;
      try {
        response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: chatAbort.signal,
          body: JSON.stringify({
            root: selectedRoot,
            path: selectedIsMarkdown ? selectedPath : '',
            selectedText,
            prompt
          })
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error('Server unavailable. Check the SSH tunnel and backend.');
      }
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      if (!response.body) throw new Error('AI provider did not stream.');

      await readSseStream(response.body, (event) => {
        if (event.text) appendAssistantText(event.text);
        if (event.error) throw new Error(event.error);
      });
      chatStatus = '';
    } catch (err) {
      if (err.name !== 'AbortError') {
        appendAssistantText(`\n\n${err.message}`);
        chatStatus = 'AI request failed';
      }
    } finally {
      chatStreaming = false;
    }
  }

  async function readSseStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  }

  function appendAssistantText(text) {
    const next = [...chatMessages];
    const index = next.length - 1;
    next[index] = {
      role: 'assistant',
      text: `${next[index]?.text || ''}${text}`
    };
    chatMessages = next;
  }

  function clearInlineEdit() {
    inlineEditPreview = null;
    inlineEditStatus = '';
  }

  async function requestInlineEdit() {
    const instruction = chatPrompt.trim();
    if (!instruction || inlineEditLoading || !canInlineEdit) return;

    const root = selectedRoot;
    const path = selectedPath;
    const range = { from: selectedRange.from, to: selectedRange.to };
    const original = editorView.state.sliceDoc(range.from, range.to);

    inlineEditLoading = true;
    inlineEditStatus = 'Drafting edit...';
    inlineEditPreview = null;
    error = '';

    try {
      const result = await requestJson('/api/ai/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root,
          path,
          selectedText: original,
          instruction
        })
      });
      if (root !== selectedRoot || path !== selectedPath) return;

      const replacement = result.replacement ?? '';
      inlineEditPreview = {
        root,
        path,
        range,
        original,
        replacement,
        diffFiles: [
          buildReplacementDiffFile(original, replacement, 'AI edit preview')
        ]
      };
      inlineEditStatus =
        original === replacement ? 'AI returned unchanged text' : 'Review edit';
      chatPrompt = '';
      setViewMode('edit');
    } catch (err) {
      inlineEditStatus = 'AI edit failed';
      error = err.message;
    } finally {
      inlineEditLoading = false;
    }
  }

  function acceptInlineEdit() {
    const preview = inlineEditPreview;
    if (!preview) return;
    if (preview.root !== selectedRoot || preview.path !== selectedPath) {
      error = 'AI edit no longer matches the open file.';
      return;
    }

    const current = editorView.state.sliceDoc(
      preview.range.from,
      preview.range.to
    );
    if (current !== preview.original) {
      error = 'Selected text changed before the AI edit was accepted.';
      inlineEditStatus = 'Reject and retry the edit';
      return;
    }

    setViewMode('edit');
    editorView.dispatch({
      changes: {
        from: preview.range.from,
        to: preview.range.to,
        insert: preview.replacement
      },
      selection: {
        anchor: preview.range.from,
        head: preview.range.from + preview.replacement.length
      },
      effects: EditorView.scrollIntoView(preview.range.from, { y: 'center' })
    });
    editorView.focus();
    inlineEditPreview = null;
    inlineEditStatus = '';
  }

  function rejectInlineEdit() {
    inlineEditPreview = null;
    inlineEditStatus = '';
    editorView?.focus();
  }

  async function loadRoots() {
    try {
      workspaceRoots = await requestJson('/api/workspace/roots');
      selectedRoot = workspaceRoots[0]?.id ?? '0';
      dailyNoteFolder = readDailyNoteFolder(selectedRoot);
      await loadTree(selectedRoot);
      const path = navigationPathFromLocation();
      if (path) await openFile(path, { historyMode: 'replace' });
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
        if (
          !['/', ...collectVisibleDirectories(nextTree)].includes(
            dailyNoteFolder
          )
        )
          chooseDailyNoteFolder('/');
        error = '';
      }
      return true;
    } catch (err) {
      if (root === selectedRoot) error = err.message;
      return false;
    }
  }

  async function switchWorkspace(root) {
    if (root === selectedRoot) return;
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();

    selectedRoot = root;
    dailyNoteFolder = readDailyNoteFolder(root);
    tree = [];
    selectedPath = '';
    selectedFileKind = 'markdown';
    content = '';
    lastSaved = '';
    status = '[Saved]';
    error = '';
    clearInlineEdit();
    searchQuery = '';
    searchResults = [];
    searchStatus = '';
    diffFiles = [];
    diffStatus = '';
    expandedDirs = new Set();
    loadedTreeOnce = false;
    fileCache = new Map();
    navigationBackStack = [];
    navigationForwardStack = [];
    setEditorContent('');
    await loadTree();
  }

  async function openFile(
    path,
    { historyMode = 'push', rememberNavigation = true } = {}
  ) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();

    const root = selectedRoot;
    const previousEntry = currentNavigationEntry();
    const fileKind = fileKindForPath(path);
    selectedPath = path;
    selectedFileKind = fileKind;
    diffFiles = [];
    diffStatus = '';
    error = '';
    clearInlineEdit();

    if (fileKind !== 'markdown') {
      showMediaFile(path);
      status = '[Read-only]';
      rememberNavigationEntry(previousEntry, path, {
        historyMode,
        rememberNavigation
      });
      updateNavigationState(path, historyMode);
      return;
    }

    status = '[Syncing...]';

    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (root !== selectedRoot || selectedPath !== path) return;
      const buffered = sessionStorage.getItem(storageKey(root, path));
      const nextContent = buffered ?? file.content;

      showFile(root, path, nextContent, file.content, file.version, {
        collaborate: !buffered
      });
      status = buffered ? '[Offline - Retrying]' : '[Saved]';
      rememberNavigationEntry(previousEntry, path, {
        historyMode,
        rememberNavigation
      });
      updateNavigationState(path, historyMode);
      if (buffered) queueRetry();
    } catch (err) {
      const buffered = sessionStorage.getItem(storageKey(root, path));
      if (buffered) {
        showFile(root, path, buffered, '', 0, { collaborate: false });
        status = '[Offline - Retrying]';
        rememberNavigationEntry(previousEntry, path, {
          historyMode,
          rememberNavigation
        });
        updateNavigationState(path, historyMode);
        queueRetry();
      } else {
        error = err.message;
        status = '[Offline - Retrying]';
      }
    }
  }

  async function openTodayNote() {
    const path = todayNotePath();
    const root = selectedRoot;
    const previousEntry = currentNavigationEntry();

    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();

    selectedPath = path;
    selectedFileKind = 'markdown';
    diffFiles = [];
    diffStatus = '';
    clearInlineEdit();
    viewMode = 'edit';
    selectedText = '';
    selectedRange = null;
    status = '[Syncing...]';
    error = '';

    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (root !== selectedRoot || selectedPath !== path) return;
      showFile(root, path, file.content, file.content, file.version);
      status = '[Saved]';
      rememberNavigationEntry(previousEntry, path);
      updateNavigationState(path);
    } catch (err) {
      if (root !== selectedRoot || selectedPath !== path) return;
      if (err.status !== 404) {
        error = err.message;
        status = '[Offline - Retrying]';
        return;
      }

      const nextContent = `# ${path.split('/').pop().replace(/\.md$/i, '')}\n\n`;
      try {
        await requestJson('/api/workspace/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, path, content: nextContent })
        });
        if (root !== selectedRoot || selectedPath !== path) return;
        showFile(root, path, nextContent, nextContent, 0);
        status = '[Saved]';
        rememberNavigationEntry(previousEntry, path);
        updateNavigationState(path);
        await loadTree(root);
      } catch (saveErr) {
        sessionStorage.setItem(storageKey(root, path), nextContent);
        showFile(root, path, nextContent, '', 0, { collaborate: false });
        error = saveErr.message;
        status = '[Offline - Retrying]';
        rememberNavigationEntry(previousEntry, path);
        updateNavigationState(path);
        queueRetry();
      }
    }
  }

  function todayNotePath(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const parent = dailyNoteFolders.includes(dailyNoteFolder)
      ? dailyNoteFolder
      : '/';
    const folder = parent === '/' ? '' : parent;
    return `${folder}/${year}-${month}-${day}.md`;
  }

  function showFile(
    root,
    path,
    nextContent,
    savedContent,
    version = 0,
    { collaborate = true } = {}
  ) {
    selectedFileKind = 'markdown';
    content = nextContent;
    lastSaved = savedContent;
    fileCache.set(rootPathKey(root, path), nextContent);
    expandToPath(path);
    setEditorContent(nextContent);
    resetCollaboration(version);
    if (collaborate) openDocumentEvents(root, path, version);
  }

  function showMediaFile(path) {
    stopCollaboration();
    content = '';
    lastSaved = '';
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    viewMode = 'preview';
    expandToPath(path);
    setEditorContent('');
  }

  function setEditorContent(nextContent) {
    applyingServerText = true;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: nextContent }
    });
    applyingServerText = false;
    updateSelectedText(editorView.state);
  }

  function resetCollaboration(version = 0) {
    documentVersion = Number(version) || 0;
    pendingUpdates = [];
    inFlightUpdates = [];
    sendingUpdates = false;
    sendPromise = Promise.resolve();
    collaborationEnabled = false;
    sendRun += 1;
    clearTimeout(saveTimer);
  }

  function stopCollaboration() {
    closeDocumentEvents();
    resetCollaboration(0);
  }

  function closeDocumentEvents() {
    documentEvents?.close();
    documentEvents = null;
  }

  function openDocumentEvents(root, path, version = 0) {
    closeDocumentEvents();
    documentVersion = Number(version) || 0;
    collaborationEnabled = true;

    const source = new EventSource(
      `/api/workspace/events?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&since=${documentVersion}`
    );
    documentEvents = source;
    source.onopen = () => {
      if (root === selectedRoot && path === selectedPath && !hasUnsavedChanges()) {
        error = '';
        status = '[Saved]';
      }
    };
    source.onmessage = (message) => {
      try {
        handleDocumentEvent(root, path, JSON.parse(message.data));
      } catch (err) {
        if (root === selectedRoot && path === selectedPath) error = err.message;
      }
    };
    source.onerror = () => {
      if (root === selectedRoot && path === selectedPath) {
        status = '[Offline - Retrying]';
      }
    };
  }

  function handleDocumentEvent(root, path, event) {
    if (
      root !== selectedRoot ||
      path !== selectedPath ||
      !selectedIsMarkdown ||
      !event ||
      event.version <= documentVersion
    )
      return;

    for (const update of event.updates || []) {
      if (update.clientID === CLIENT_ID) {
        acknowledgeUpdate(update);
      } else {
        applyRemoteUpdate(update);
      }
    }

    documentVersion = event.version;
    if (pendingUpdates.length) {
      status = '[Syncing...]';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushPendingUpdates, 0);
    } else if (
      !inFlightUpdates.length &&
      !sendingUpdates &&
      content === editorView.state.doc.toString()
    ) {
      lastSaved = content;
      status = '[Saved]';
    }
  }

  function acknowledgeUpdate(update) {
    pendingUpdates = pendingUpdates.filter((item) => item.id !== update.id);
    inFlightUpdates = inFlightUpdates.filter((item) => item.id !== update.id);
  }

  function applyRemoteUpdate(update) {
    const unconfirmed = [...inFlightUpdates, ...pendingUpdates];
    const { changesForEditor, rebasedUpdates } = rebaseRemoteUpdate(
      update,
      unconfirmed,
      newCollabUpdate
    );

    applyingServerText = true;
    editorView.dispatch({ changes: changesForEditor });
    applyingServerText = false;
    content = editorView.state.doc.toString();

    if (!unconfirmed.length) return;

    pendingUpdates = rebasedUpdates;
    inFlightUpdates = [];
    sendingUpdates = false;
    sendRun += 1;
  }

  function newCollabUpdate(changes) {
    updateSequence += 1;
    return createCollabUpdate(
      changes,
      CLIENT_ID,
      `${CLIENT_ID}:${updateSequence}`
    );
  }

  function queueLocalUpdate(changes) {
    if (!selectedPath || !selectedIsMarkdown) return;
    pendingUpdates = [...pendingUpdates, newCollabUpdate(changes)];
    status = '[Syncing...]';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPendingUpdates, 150);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!selectedPath || !selectedIsMarkdown) return;
    if (collaborationEnabled && (pendingUpdates.length || inFlightUpdates.length)) {
      await flushPendingUpdates();
      return;
    }
    if (content === lastSaved) return;

    await saveWholeFile();
  }

  async function saveWholeFile() {
    if (!selectedPath || !selectedIsMarkdown || content === lastSaved) return;

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
      if (
        selectedRoot === root &&
        selectedPath === path &&
        content === nextContent
      ) {
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

  async function flushPendingUpdates() {
    clearTimeout(saveTimer);
    if (sendingUpdates) return sendPromise;
    if (
      !collaborationEnabled ||
      !selectedPath ||
      !selectedIsMarkdown ||
      !pendingUpdates.length
    )
      return;

    const root = selectedRoot;
    const path = selectedPath;
    const version = documentVersion;
    const updates = pendingUpdates;
    const run = ++sendRun;

    pendingUpdates = [];
    inFlightUpdates = updates;
    sendingUpdates = true;
    status = '[Syncing...]';

    sendPromise = (async () => {
      const result = await requestJson('/api/workspace/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path, version, updates })
      });
      if (run !== sendRun || root !== selectedRoot || path !== selectedPath)
        return;

      documentVersion = Math.max(documentVersion, result.version);
      inFlightUpdates = [];
      sendingUpdates = false;
      sessionStorage.removeItem(storageKey(root, path));
      if (pendingUpdates.length) {
        await flushPendingUpdates();
      } else {
        lastSaved = content;
        fileCache.set(rootPathKey(root, path), content);
        status = '[Saved]';
        await loadTree(root);
      }
    })().catch((err) => {
      if (run !== sendRun || root !== selectedRoot || path !== selectedPath)
        return;

      pendingUpdates = [...inFlightUpdates, ...pendingUpdates];
      inFlightUpdates = [];
      sendingUpdates = false;
      sessionStorage.setItem(storageKey(root, path), content);
      error = err.message;
      status = '[Offline - Retrying]';
      if (err.status !== 409) queueRetry();
    });
    return sendPromise;
  }

  async function syncWorkspace() {
    const root = selectedRoot;
    const path = selectedPath;
    status = '[Syncing...]';
    error = '';

    if (path && hasUnsavedChanges()) await saveNow();
    if (root !== selectedRoot) return;

    fileCache = new Map();
    const synced = await loadTree(root);
    if (!synced) {
      status = '[Offline - Retrying]';
      return;
    }
    if (path && content === lastSaved)
      await openFile(path, { historyMode: 'replace' });
    else if (!path) status = '[Saved]';
  }

  async function showDiff() {
    if (!selectedPath || !selectedIsMarkdown) return;
    if (hasUnsavedChanges()) await saveNow();

    const root = selectedRoot;
    const path = selectedPath;
    viewMode = 'diff';
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    diffFiles = [];
    diffStatus = 'Loading diff...';
    error = '';

    try {
      const result = await requestJson(
        `/api/workspace/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (root !== selectedRoot || path !== selectedPath) return;
      diffFiles = parseUnifiedDiff(result.diff);
      diffStatus = result.diff
        ? diffFiles.length
          ? ''
          : 'No readable diff hunks'
        : 'No git changes';
    } catch (err) {
      if (root === selectedRoot && path === selectedPath) {
        diffStatus = '';
        error = err.message;
      }
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

  function hasUnsavedChanges() {
    return (
      selectedIsMarkdown &&
      (content !== lastSaved || pendingUpdates.length || inFlightUpdates.length)
    );
  }

  function updateSelectedText(state) {
    const selection = state.selection.main;
    if (selection.empty) {
      selectedText = '';
      selectedRange = null;
      return;
    }
    selectedText = state.sliceDoc(selection.from, selection.to);
    selectedRange = { from: selection.from, to: selection.to };
  }

  function updateBrowserSelectedText() {
    const selection = window.getSelection?.();
    const text = selection?.toString() ?? '';
    const anchorNode = selection?.anchorNode;
    const focusNode = selection?.focusNode;

    if (
      anchorNode &&
      focusNode &&
      editorHost?.contains(anchorNode) &&
      editorHost.contains(focusNode)
    )
      return;

    if (
      text &&
      appShell &&
      anchorNode &&
      focusNode &&
      appShell.contains(anchorNode) &&
      appShell.contains(focusNode)
    ) {
      selectedText = text;
      selectedRange = null;
    } else if (!text) {
      selectedText = '';
      selectedRange = null;
    }
  }

  function storageKey(root, path) {
    return `webmd:unsaved:${rootPathKey(root, path)}`;
  }

  function rootPathKey(root, path) {
    return `${root}:${path}`;
  }

  function mediaUrl(path) {
    return `/api/workspace/media?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(path)}`;
  }

  function wikiLinkHref(target) {
    const path = resolveWikiLinkPath(target, selectedPath, markdownFiles);
    return path ? `#${encodeURI(path)}` : '';
  }

  async function openWikiLink(event, target) {
    event.preventDefault();
    const path = resolveWikiLinkPath(target, selectedPath, markdownFiles);
    if (!path) {
      error = `Invalid wiki link: ${target}`;
      return;
    }

    await openFile(path);
  }

  async function openNavigationState(event) {
    const state = event.state || {};
    const path = state.path || navigationPathFromLocation();
    if (!path) return;

    if (state.root && state.root !== selectedRoot) return;
    await openFile(path, { historyMode: 'none', rememberNavigation: false });
  }

  async function navigateBack() {
    await navigateHistory('back');
  }

  async function navigateForward() {
    await navigateHistory('forward');
  }

  async function navigateHistory(direction) {
    const from = currentNavigationEntry();
    const source =
      direction === 'back' ? navigationBackStack : navigationForwardStack;
    const target = source[source.length - 1];
    if (!from || !target || target.root !== selectedRoot) return;

    if (direction === 'back') {
      navigationBackStack = navigationBackStack.slice(0, -1);
      navigationForwardStack = [...navigationForwardStack, from];
    } else {
      navigationForwardStack = navigationForwardStack.slice(0, -1);
      navigationBackStack = [...navigationBackStack, from];
    }

    await openFile(target.path, {
      historyMode: 'replace',
      rememberNavigation: false
    });
  }

  function currentNavigationEntry() {
    return selectedPath ? { root: selectedRoot, path: selectedPath } : null;
  }

  function rememberNavigationEntry(
    previousEntry,
    targetPath,
    { historyMode = 'push', rememberNavigation = true } = {}
  ) {
    if (!rememberNavigation || historyMode !== 'push' || !previousEntry) return;

    const targetEntry = { root: selectedRoot, path: targetPath };
    if (
      previousEntry.root === targetEntry.root &&
      previousEntry.path === targetEntry.path
    )
      return;

    navigationBackStack = [...navigationBackStack, previousEntry].slice(-100);
    navigationForwardStack = [];
  }

  function updateNavigationState(path, mode = 'push') {
    if (mode === 'none' || !path) return;

    const state = { root: selectedRoot, path };
    const url = `#${encodeURI(path)}`;
    const current = history.state || {};
    const method =
      mode === 'replace' ||
      (current.root === state.root && current.path === state.path)
        ? 'replaceState'
        : 'pushState';

    history[method](state, '', url);
  }

  function navigationPathFromLocation() {
    if (!location.hash.startsWith('#/')) return '';

    try {
      return decodeURI(location.hash.slice(1));
    } catch {
      return location.hash.slice(1);
    }
  }

  function basename(path) {
    return path.split('/').pop() || path;
  }

  function fileKindForPath(path) {
    return (
      findFileNode(workspaceTree, path)?.fileKind ||
      (/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(path)
        ? 'image'
        : /\.pdf$/i.test(path)
          ? 'pdf'
          : 'markdown')
    );
  }

  function findFileNode(nodes, path) {
    for (const node of nodes) {
      if (node.type === 'file' && node.path === path) return node;
      if (node.type === 'directory') {
        const match = findFileNode(node.children || [], path);
        if (match) return match;
      }
    }
    return null;
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

  function collectVisibleDirectories(nodes) {
    return nodes.flatMap((node) => {
      if (
        node.type !== 'directory' ||
        node.name.startsWith('.') ||
        node.name === 'node_modules'
      )
        return [];
      return [node.path, ...collectVisibleDirectories(node.children || [])];
    });
  }

  function chooseDailyNoteFolder(folder) {
    dailyNoteFolder = folder;
    try {
      localStorage.setItem(dailyNoteFolderStorageKey(selectedRoot), folder);
    } catch {
      // Ignore storage failures; the selected folder still works this session.
    }
  }

  function readDailyNoteFolder(root) {
    try {
      return localStorage.getItem(dailyNoteFolderStorageKey(root)) || '/';
    } catch {
      return '/';
    }
  }

  function dailyNoteFolderStorageKey(root) {
    return `${DAILY_NOTE_FOLDER_KEY}:${root}`;
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

  async function revealSelectedFileInSidebar() {
    if (!selectedPath) return;

    sidebarVisible = true;
    searchQuery = '';
    expandToPath(selectedPath);
    await tick();
    treeHost
      ?.querySelector('.tree button.active')
      ?.scrollIntoView({ block: 'center' });
  }

  function queueWorkspaceSearch(query, root, _nodes) {
    clearTimeout(searchTimer);
    const run = ++searchRun;

    if (!query) {
      searchResults = [];
      searchStatus = '';
      return;
    }

    searchStatus = 'Searching...';
    searchTimer = setTimeout(() => searchWorkspace(query, root, run), 250);
  }

  async function searchWorkspace(query, root, run) {
    try {
      const results = await requestJson(
        `/api/workspace/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`
      );
      if (run === searchRun && root === selectedRoot) {
        searchResults = results;
        searchStatus = results.length ? '' : 'No matches';
      }
    } catch (err) {
      if (run === searchRun && root === selectedRoot) searchStatus = err.message;
    }
  }

  async function openSearchResult(result) {
    rememberSearch(searchQuery);
    await openFile(result.path);
    if (result.from != null && result.fileKind === 'markdown')
      selectEditorRange(result.from, result.to);
  }

  function readSearchHistory() {
    try {
      const value = JSON.parse(
        localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'
      );
      return Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string')
            .slice(0, SEARCH_HISTORY_LIMIT)
        : [];
    } catch {
      return [];
    }
  }

  function rememberSearch(query) {
    const term = query.trim();
    if (!term) return;

    searchHistory = [
      term,
      ...searchHistory.filter((item) => item !== term)
    ].slice(0, SEARCH_HISTORY_LIMIT);

    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory));
    } catch {
      // Ignore storage failures; live search still works.
    }
  }

  function removeSearchHistory(term) {
    searchHistory = searchHistory.filter((item) => item !== term);

    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory));
    } catch {
      // Ignore storage failures; removing from the visible list is enough.
    }
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
    selectedText = '';
    selectedRange = null;
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
    {:else if segment.type === 'wikiLink'}
      <a
        class="wiki-link"
        href={wikiLinkHref(segment.target)}
        title={wikiLinkHref(segment.target)}
        on:click={(event) => openWikiLink(event, segment.target)}
        >{segment.text}</a
      >
    {:else if segment.type === 'strong'}
      <strong>{segment.text}</strong>
    {:else if segment.type === 'em'}
      <em>{segment.text}</em>
    {:else}
      {segment.text}
    {/if}
  {/each}
{/snippet}

{#snippet diffFile(file)}
  <article class="diff-file">
    <header class="diff-file-header">{file.title}</header>
    {#each file.hunks as hunk}
      <section class="diff-hunk">
        <div class="diff-hunk-header">
          <span>{hunk.header}</span>
          {#if hunk.summary}
            <strong>{hunk.summary}</strong>
          {/if}
        </div>
        {#each hunk.lines as line}
          <div class={`diff-line diff-line-${line.kind}`}>
            <span class="diff-line-number">{line.oldNumber}</span>
            <span class="diff-line-number">{line.newNumber}</span>
            <code>{line.text}</code>
          </div>
        {/each}
      </section>
    {/each}
  </article>
{/snippet}

<main
  bind:this={appShell}
  class:sidebar-hidden={!sidebarVisible}
  class="app-shell"
>
  <nav class="global-bar" aria-label="Global actions">
    <button
      aria-label="Add today's daily note"
      class="global-action"
      disabled={!workspaceRoots.length}
      title="Add today's daily note"
      type="button"
      on:click={openTodayNote}
    >
      +
    </button>
    <select
      aria-label="Daily notes folder"
      class="global-folder-select"
      disabled={!workspaceRoots.length}
      title={`Daily notes folder: ${dailyNoteFolder}`}
      value={dailyNoteFolder}
      on:change={(event) => chooseDailyNoteFolder(event.currentTarget.value)}
    >
      {#each dailyNoteFolders as folder}
        <option value={folder}>{folder}</option>
      {/each}
    </select>
  </nav>

  <aside
    class:sidebar-closed={!sidebarVisible}
    class="sidebar"
    aria-label="Workspace files"
  >
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
      <span>Files</span>
      <div class="sidebar-title-actions">
        <span>{fileCount} files</span>
        <button
          aria-label="Sync files"
          class="sync-button"
          title="Sync files"
          type="button"
          on:click={syncWorkspace}
        >
          Sync
        </button>
      </div>
    </div>
    <div class="sidebar-search">
      <input
        aria-label="Search files and contents"
        bind:value={searchQuery}
        name="webmd-search"
        on:blur={() => rememberSearch(searchQuery)}
        on:keydown={(event) => {
          if (event.key === 'Enter') rememberSearch(searchQuery);
        }}
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
      {#if searchHistory.length}
        <div class="search-history" aria-label="Recent searches">
          {#each searchHistory as term}
            <div class="search-history-item">
              <button
                aria-label={`Search for ${term}`}
                class="history-chip"
                title={term}
                type="button"
                on:click={() => {
                  searchQuery = term;
                  rememberSearch(term);
                }}
              >
                <span>{term}</span>
              </button>
              <button
                aria-label={`Remove ${term} from recent searches`}
                class="history-remove"
                title={`Remove ${term}`}
                type="button"
                on:click={() => removeSearchHistory(term)}
              >
                x
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <div bind:this={treeHost} class="tree">
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
          <p class="empty-copy">No supported files</p>
        {/if}
      </div>
    {/if}

    <section class="ai-panel" aria-label="AI chat">
      <div class="ai-messages" aria-live="polite">
        {#if chatMessages.length}
          {#each chatMessages as message}
            <article class={`ai-message ai-message-${message.role}`}>
              <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
              <p>{message.text || (chatStreaming ? '...' : '')}</p>
            </article>
          {/each}
        {:else}
          <p class="empty-copy">Ask about the current note or selection.</p>
        {/if}
      </div>
      <form
        class="ai-form"
        on:submit|preventDefault={sendChat}
      >
        <textarea
          aria-label="Ask AI"
          bind:value={chatPrompt}
          disabled={chatStreaming || inlineEditLoading}
          placeholder={selectedText ? 'Ask about the selection' : 'Ask about this note'}
          rows="2"
        ></textarea>
        <button
          disabled={!chatPrompt.trim() || chatStreaming || inlineEditLoading}
          type="submit"
        >
          {chatStreaming ? '...' : 'Ask'}
        </button>
        <button
          disabled={!chatPrompt.trim() || chatStreaming || inlineEditLoading || !canInlineEdit}
          title={canInlineEdit
            ? 'Preview edit for selected text'
            : 'Select text in the editor'}
          type="button"
          on:click={requestInlineEdit}
        >
          {inlineEditLoading ? '...' : 'Edit'}
        </button>
      </form>
      {#if chatStatus || inlineEditStatus}
        <p class="ai-status">{chatStatus || inlineEditStatus}</p>
      {/if}
    </section>
  </aside>

  <section class="workspace">
    <header class="topbar">
      <div class="file-heading">
        <button
          aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={sidebarVisible}
          class:active={sidebarVisible}
          class="sidebar-toggle"
          title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          type="button"
          on:click={() => (sidebarVisible = !sidebarVisible)}
        >
          Files
        </button>
        <div class="navigation-controls" aria-label="File navigation">
          <button
            aria-label="Go back"
            class="history-button"
            disabled={!canNavigateBack}
            title="Go back"
            type="button"
            on:click={navigateBack}
          >
            <span aria-hidden="true">&lt;</span>
          </button>
          <button
            aria-label="Go forward"
            class="history-button"
            disabled={!canNavigateForward}
            title="Go forward"
            type="button"
            on:click={navigateForward}
          >
            <span aria-hidden="true">&gt;</span>
          </button>
        </div>
        <button
          aria-label="Show current file in sidebar"
          class="current-file"
          disabled={!selectedPath}
          title={selectedPath ? 'Double-click to show in sidebar' : undefined}
          type="button"
          on:dblclick={revealSelectedFileInSidebar}
        >
          {selectedPath || 'No file selected'}
        </button>
      </div>
      <div class="topbar-actions">
        <div class="view-toggle" aria-label="View mode">
          <button
            class:active={viewMode === 'edit' && selectedIsMarkdown}
            disabled={!selectedPath || !selectedIsMarkdown}
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
          <button
            class:active={viewMode === 'diff' && selectedIsMarkdown}
            disabled={!selectedPath || !selectedIsMarkdown}
            type="button"
            on:click={showDiff}
          >
            Diff
          </button>
        </div>
        <button
          class="save-button"
          disabled={!selectedPath || !selectedIsMarkdown || !hasUnsavedChanges()}
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
        <div class="empty-state">Open a file from Files.</div>
      {/if}
      <div
        bind:this={editorHost}
        class:hidden={!selectedIsMarkdown || viewMode !== 'edit'}
        class="editor-host"
      ></div>
      {#if selectedPath && selectedIsMarkdown}
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
              {:else if block.type === 'callout'}
                <aside class={`callout callout-${block.variant}`}>
                  <p class="callout-title">{@render inline(block.title)}</p>
                  {#if block.children.length}
                    <p class="callout-body">{@render inline(block.children)}</p>
                  {/if}
                </aside>
              {:else if block.type === 'rule'}
                <hr />
              {:else if block.type === 'code'}
                <pre><code>{block.text}</code></pre>
              {:else if block.type === 'diff'}
                {#each block.files as file}
                  {@render diffFile(file)}
                {/each}
              {:else if block.type === 'table'}
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {#each block.headers as header, column}
                          <th class={`align-${block.alignments[column]}`}>
                            {@render inline(header)}
                          </th>
                        {/each}
                      </tr>
                    </thead>
                    <tbody>
                      {#each block.rows as row}
                        <tr>
                          {#each row as cell, column}
                            <td class={`align-${block.alignments[column]}`}>
                              {@render inline(cell)}
                            </td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
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
        <section
          aria-label="Git diff"
          class:hidden={viewMode !== 'diff'}
          class="diff-pane"
        >
          {#if diffStatus}
            <p class="preview-empty">{diffStatus}</p>
          {:else}
            {#each diffFiles as file}
              {@render diffFile(file)}
            {/each}
          {/if}
        </section>
      {:else if selectedPath}
        <section
          aria-label="Read-only media preview"
          class:image={selectedFileKind === 'image'}
          class:pdf={selectedFileKind === 'pdf'}
          class="media-pane"
        >
          {#if selectedFileKind === 'image'}
            <img src={mediaPreviewUrl} alt={basename(selectedPath)} />
          {:else if selectedFileKind === 'pdf'}
            <object
              class="media-pdf"
              data={mediaPreviewUrl}
              title={basename(selectedPath)}
              type="application/pdf"
            >
              <a href={mediaPreviewUrl} rel="noreferrer" target="_blank">
                Open {basename(selectedPath)}
              </a>
            </object>
          {/if}
        </section>
      {/if}
      {#if inlineEditPreview && inlineEditPreview.root === selectedRoot && inlineEditPreview.path === selectedPath}
        <section class="inline-edit-panel" aria-label="AI edit preview">
          <header class="inline-edit-header">
            <strong>AI edit preview</strong>
            <div class="inline-edit-actions">
              <button type="button" on:click={rejectInlineEdit}>Reject</button>
              <button class="primary" type="button" on:click={acceptInlineEdit}>
                Accept
              </button>
            </div>
          </header>
          <div class="inline-edit-diff">
            {#each inlineEditPreview.diffFiles as file}
              {@render diffFile(file)}
            {/each}
          </div>
        </section>
      {/if}
    </div>

    <footer class="statusbar">
      <span class={statusClass}>{status}</span>
      <span>Selected text: {selectedText.length}</span>
    </footer>
  </section>
</main>
