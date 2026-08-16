<script>
  import { indentWithTab } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { EditorState, Transaction } from '@codemirror/state';
  import { EditorView, keymap } from '@codemirror/view';
  import katex from 'katex';
  import 'katex/dist/katex.min.css';
  import { basicSetup } from 'codemirror';
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    calendarDays as buildCalendarDays,
    dailyNoteContent as buildDailyNoteContent,
    dailyNoteDate,
    dailyNoteDateFromPath,
    dailyNotePath as buildDailyNotePath,
    defaultReferencePath,
    previousDailyNotePath,
    shiftMonth,
    stepDailyNote
  } from './calendar.js';
  import {
    rebaseRemoteUpdate,
    updateFromChangeSet as createCollabUpdate
  } from './collab.js';
  import { buildReplacementDiffFile, parseUnifiedDiff } from './diff.js';
  import {
    arxivCitation,
    arxivPasteId,
    quotedBlockPaste,
    sourceColumnForWord
  } from './editor.js';
  import { layoutGraph } from './graph.js';
  import { highlightCodeBlock, languageLabel } from './highlight.js';
  import { renderMarkdown } from './markdown.js';
  import { renderMermaid } from './mermaid.js';
  import {
    clampPaletteIndex,
    paletteResultLabel,
    recentPaletteResults,
    stepPaletteIndex
  } from './palette.js';
  import {
    pastedImageSources,
    uploadFilesForPastedImageSources,
    uploadPayloadForFile
  } from './uploads.js';
  import { relatedInsertion, shortestWikiTarget } from './related-links.js';
  import {
    carriedTaskLines,
    collectTasks,
    formatDueChip,
    formatDueLabel,
    groupTasksByUrgency,
    priorityGlyph,
    taskLinkSegments,
    taskShorthandEdits,
    taskProgress,
    taskUrgency,
    toggleTaskLine
  } from './tasks.js';
  import {
    DEFAULT_SECTIONS,
    SECTION_STATUSES,
    formatTermList,
    groupTasksIntoSections,
    parseTermList,
    sanitizeSections
  } from './task-sections.js';
  import { LANES, filterTasks, groupTasksIntoBoard } from './task-score.js';
  import { resolveWikiLinkPath } from './wiki-links.js';

  const SEARCH_HISTORY_KEY = 'webmd:search-history';
  const TASK_SECTIONS_KEY = 'webmd:task-sections';
  const TASK_BOARD_KEY = 'webmd:task-board';
  const TASK_GROUPINGS = ['board', 'sections', 'urgency'];
  const SEARCH_HISTORY_LIMIT = 8;
  const RECENT_FILES_KEY = 'webmd:recent-files';
  const RECENT_FILES_LIMIT = 5;
  const VIEW_MODE_KEY = 'webmd:view-mode';
  const WORKSPACE_VIEW_MODES = new Set(['edit', 'preview', 'diff', 'graph']);
  // 'tasks' and 'calendar' are workspace-wide views rather than ways of looking
  // at the open note, so neither is remembered as a file's view mode. They are
  // still navigation destinations, so back and forward can return to them.
  const WORKSPACE_VIEWS = new Set(['tasks', 'calendar']);
  const DAILY_NOTE_FOLDER_KEY = 'webmd:daily-note-folder';
  const DAILY_NOTE_TEMPLATE_KEY = 'webmd:daily-note-template';
  const LEGACY_DAILY_NOTE_FOLDER_PREFIX = `${DAILY_NOTE_FOLDER_KEY}:`;
  const DEFAULT_DAILY_NOTE_FOLDER = '/raw/dailynotes';
  const REFERENCE_PANE_KEY = 'webmd:reference-pane';
  const IMAGE_ASSET_FOLDER_KEY = 'webmd:image-asset-folder';
  const NEW_IMAGE_ASSET_FOLDER = '__new_image_asset_folder__';
  const IMAGE_EXTENSIONS = /\.(avif|gif|heic|heif|jpe?g|png|svg|webp)$/i;
  const UPLOAD_EXTENSIONS = /\.(avif|gif|heic|heif|jpe?g|png|svg|webp|pdf)$/i;
  const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function renderMath(source) {
    return katex.renderToString(source, { throwOnError: false });
  }

  const MERMAID_REDRAW_DELAY = 250;
  // Must match the single breakpoint in styles.css so the markup and the
  // stylesheet always agree on what counts as a narrow screen.
  const NARROW_LAYOUT_QUERY = '(max-width: 760px)';

  // Mermaid renders asynchronously, so diagrams are drawn by an action rather
  // than inline markup. The preview reparses the whole note on every keystroke,
  // so redraws are debounced and stale results are dropped.
  function mermaidDiagram(node, text) {
    const canvas = node.querySelector('.mermaid-canvas');
    const message = node.querySelector('.mermaid-error');
    let token = 0;
    let timer = null;

    async function draw(source) {
      const current = ++token;
      try {
        const svg = await renderMermaid(source);
        if (current !== token) return;
        canvas.innerHTML = svg;
        message.textContent = '';
        node.dataset.state = 'ready';
      } catch (error) {
        if (current !== token) return;
        canvas.innerHTML = '';
        message.textContent =
          error?.message || 'Could not render this diagram.';
        node.dataset.state = 'error';
      }
    }

    draw(text);

    return {
      update(next) {
        clearTimeout(timer);
        timer = setTimeout(() => draw(next), MERMAID_REDRAW_DELAY);
      },
      destroy() {
        clearTimeout(timer);
        token += 1;
      }
    };
  }
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
  let paletteOpen = false;
  let paletteQuery = '';
  let paletteResults = [];
  let paletteStatus = '';
  let paletteIndex = -1;
  let recentPaths = [];
  let overview = {
    fileCount: 0,
    markdownCount: 0,
    recent: [],
    gitAvailable: false,
    changes: []
  };
  let overviewStatus = 'Loading workspace...';
  let graphData = { nodes: [], edges: [], unresolved: 0 };
  let graphView = { nodes: [], edges: [] };
  let graphScope = 'wiki';
  let graphStatus = '';
  let graphViewport = { x: 0, y: 0, width: 1000, height: 700 };
  let graphSvg;
  let graphPointer;
  let hoveredGraphPath = '';
  let chatPrompt = '';
  let chatMessages = [];
  let chatStatus = '';
  let chatStreaming = false;
  let chatAbort;
  let chatScrollHost;
  let inlineEditStatus = '';
  let inlineEditLoading = false;
  let inlineEditPreview = null;
  let inlineEditAbort = null;
  let relatedLoading = false;
  let relatedStatus = '';
  let relatedPanel = null;
  let relatedAbort = null;
  let aiPresets = [];
  let aiPresetWarning = '';
  let activePresetGroup = '';
  let selectedRange = null;
  let viewMode = 'edit';
  // Refreshed whenever a task surface opens, so a session left running past
  // midnight does not keep grading due dates against yesterday.
  let todayText = dailyNoteDate(new Date());
  let workspaceTasks = [];
  let tasksStatus = '';
  // The Tasks view opens on the board: four ranked lanes, which is the only one
  // of the three that answers "what now". Sections (a dashboard of filters the
  // reader defines) and urgency (strictly by due date) stay as the other two
  // ways of looking at the same list.
  let taskSections = sanitizeSections(null);
  let taskGrouping = 'board';
  let taskFilter = '';
  let taskFilterInput = null;
  let collapsedLanes = [];
  let showCompletedTasks = false;
  let editingSections = false;
  let referenceOpen = false;
  let referencePath = '';
  let referenceContent = '';
  let referenceStatus = '';
  // Pinned once the reader picks a note by hand, so opening another file in the
  // editor no longer drags the reference along with it.
  let referencePinned = false;
  let referenceRun = 0;
  let markdownHelpOpen = false;
  let viewMenuOpen = false;
  // Phone-width layout. The toolbar has no room for every action there, so the
  // rarely used ones move into the ... menu instead of overflowing off-screen.
  let narrowLayout = false;
  let diffFiles = [];
  let diffStatus = '';
  let sidebarVisible = true;
  let sidebarView = 'files';
  let markdownViewsHidden = false;
  let dailyNoteFolder = DEFAULT_DAILY_NOTE_FOLDER;
  let dailyNoteTemplatePath = '';
  let dailyNoteFolderStored = false;
  let imageAssetFolder = '/assets';
  let imageAssetFolderDraft = '';
  let creatingImageAssetFolder = false;
  let calendarMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1
  );
  let expandedDirs = new Set();
  let loadedTreeOnce = false;
  let treeLoaded = false;
  let appShell;
  let editorHost;
  let treeHost;
  let searchInput;
  let paletteInput;
  let paletteHost;
  let uploadInput;
  let editorView;
  let saveTimer;
  let retryTimer;
  let searchTimer;
  let searchRun = 0;
  let paletteTimer;
  let paletteRun = 0;
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
  let copiedCode = null;
  let copiedCodeTimer;

  $: workspaceTree = cleanTree(tree);
  $: workspaceFiles = collectFiles(workspaceTree);
  $: markdownFiles = workspaceFiles.filter(
    (file) => file.fileKind === 'markdown'
  );
  $: dailyNoteFolders = ['/', ...collectVisibleDirectories(tree)];
  $: imageAssetFolders = dailyNoteFolders;
  $: activeDailyNoteFolder =
    !treeLoaded || dailyNoteFolders.includes(dailyNoteFolder)
      ? dailyNoteFolder
      : '/';
  $: dailyNoteFolderMissing =
    dailyNoteFolder !== '/' && activeDailyNoteFolder !== dailyNoteFolder;
  $: dailyNoteFolderOptions = dailyNoteFolderMissing
    ? [dailyNoteFolder, ...dailyNoteFolders]
    : dailyNoteFolders;
  $: dailyNoteTemplateMissing =
    dailyNoteTemplatePath &&
    !markdownFiles.some((file) => file.path === dailyNoteTemplatePath);
  $: imageAssetFolderOptions = imageAssetFolders.includes(imageAssetFolder)
    ? imageAssetFolders
    : [imageAssetFolder, ...imageAssetFolders];
  $: calendarDays = buildCalendarDays(calendarMonth);
  $: calendarMonthName = calendarMonth.toLocaleDateString([], {
    month: 'long',
    year: 'numeric'
  });
  $: dailyNotePaths = new Set(markdownFiles.map((file) => file.path));
  // Only notes that already exist in the daily note folder, oldest to newest.
  $: dailyNoteEntries = markdownFiles
    .map((file) => ({
      path: file.path,
      date: dailyNoteDateFromPath(file.path)
    }))
    .filter(
      (entry) =>
        entry.date &&
        entry.path === todayNotePath(entry.date, activeDailyNoteFolder)
    )
    .sort((left, right) => left.date - right.date);
  $: dailyNoteIndex = dailyNoteEntries.findIndex(
    (entry) => entry.path === selectedPath
  );
  // The entries and index are passed in rather than read inside the helper, so
  // the reactive statement actually depends on them and re-runs once the tree
  // loads. Reading them only inside adjacentNotePath left these stuck at ''.
  $: olderDailyNotePath = adjacentNotePath(
    dailyNoteEntries,
    dailyNoteIndex,
    -1
  );
  $: newerDailyNotePath = adjacentNotePath(dailyNoteEntries, dailyNoteIndex, 1);
  $: dailyNotePathList = dailyNoteEntries.map((entry) => entry.path);
  $: referenceIndex = dailyNoteEntries.findIndex(
    (entry) => entry.path === referencePath
  );
  $: olderReferencePath = adjacentNotePath(
    dailyNoteEntries,
    referenceIndex,
    -1
  );
  $: newerReferencePath = adjacentNotePath(dailyNoteEntries, referenceIndex, 1);
  // The Markdown views only collapse while the AI panel owns the sidebar, so
  // closing the panel always brings the editor back.
  $: markdownViewsCollapsed =
    markdownViewsHidden && sidebarVisible && sidebarView === 'chat';
  $: flatTree = flattenTree(workspaceTree, expandedDirs);
  $: fileCount = workspaceFiles.length;
  $: continueFiles = recentPaths
    .map((path) => findFileNode(workspaceTree, path))
    .filter(Boolean);
  $: activeWorkspaceName =
    workspaceRoots.find((root) => root.id === selectedRoot)?.name ||
    'Workspace';
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
  $: presetGroups = groupPresets(aiPresets);
  // Tracks presetGroups only. activePresetGroup is read inside the function so
  // this cannot retrigger itself when the fallback assigns to it.
  $: reconcilePresetGroup(presetGroups);
  $: activePresets =
    presetGroups.find((group) => group.name === activePresetGroup)?.items ?? [];
  $: mediaPreviewUrl = selectedIsMedia ? mediaUrl(selectedPath) : '';
  $: renderedBlocks =
    selectedIsMarkdown && viewMode === 'preview' ? renderMarkdown(content) : [];
  // The filter box narrows the list once, before any of the three views slice
  // it, so switching between them keeps whatever you were looking for.
  $: matchingTasks = filterTasks(workspaceTasks, taskFilter);
  $: taskGroups = groupTasksByUrgency(matchingTasks, todayText);
  $: taskBoard = groupTasksIntoBoard(matchingTasks, taskSections, {
    today: todayText,
    dailyNoteFolder: activeDailyNoteFolder,
    includeDone: showCompletedTasks
  });
  $: taskSectionGroups = groupTasksIntoSections(matchingTasks, taskSections, {
    dailyNoteFolder: activeDailyNoteFolder,
    includeDone: showCompletedTasks
  });
  $: openTaskCount = matchingTasks.filter((task) => !task.checked).length;
  $: doneTaskCount = matchingTasks.length - openTaskCount;
  $: hiddenTaskCount = workspaceTasks.length - matchingTasks.length;
  // The two list ways of slicing render through one shape: panes of piles.
  // Urgency has nothing to say about where a task came from, so its piles are
  // unlabelled and the rows show their own path.
  $: taskPanes =
    taskGrouping === 'urgency'
      ? taskGroups.map((group) => ({
          id: group.key || 'none',
          label: group.label,
          count: group.tasks.length,
          groups: [{ key: group.key || 'none', label: '', tasks: group.tasks }]
        }))
      : taskSectionGroups;
  // The views that take over the whole frame instead of showing the open file.
  $: workspacePaneOpen =
    viewMode === 'graph' || viewMode === 'calendar' || viewMode === 'tasks';
  $: noteProgress = taskProgress(
    selectedIsMarkdown && viewMode === 'preview' ? collectTasks(content) : []
  );
  $: referenceBlocks =
    referenceOpen && referencePath && !referenceStatus
      ? renderMarkdown(referenceContent)
      : [];
  $: queueWorkspaceSearch(searchQuery.trim(), selectedRoot, workspaceTree);
  $: if (paletteOpen) queuePaletteSearch(paletteQuery.trim(), selectedRoot);
  $: statusClass = status.includes('Offline')
    ? 'offline'
    : status.includes('Syncing')
      ? 'syncing'
      : 'saved';

  let narrowLayoutQuery = null;

  function syncNarrowLayout() {
    const next = Boolean(narrowLayoutQuery?.matches);
    if (next === narrowLayout) return;
    narrowLayout = next;
    // The ... menu carries different items on each side of the breakpoint, so
    // a resize should not leave a half-stale menu open.
    closeViewMenu();
  }

  onMount(async () => {
    searchHistory = readSearchHistory();
    taskSections = readTaskSections();
    readTaskBoard();
    createEditor('');
    narrowLayoutQuery = window.matchMedia(NARROW_LAYOUT_QUERY);
    syncNarrowLayout();
    narrowLayoutQuery.addEventListener('change', syncNarrowLayout);
    document.addEventListener('selectionchange', updateBrowserSelectedText);
    window.addEventListener('popstate', openNavigationState);
    await loadRoots();
  });

  onDestroy(() => {
    narrowLayoutQuery?.removeEventListener('change', syncNarrowLayout);
    document.removeEventListener('selectionchange', updateBrowserSelectedText);
    window.removeEventListener('popstate', openNavigationState);
    closeDocumentEvents();
    chatAbort?.abort();
    editorView?.destroy();
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    clearTimeout(searchTimer);
    clearTimeout(copiedCodeTimer);
  });

  function createEditor(doc) {
    editorView = new EditorView({
      parent: editorHost,
      state: editorState(doc)
    });
  }

  function editorState(doc) {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        // Tab indents by the default two-space unit instead of moving focus,
        // so a selected block shifts with Tab and back with Shift+Tab.
        // Escape then Tab still leaves the editor for keyboard-only use.
        keymap.of([indentWithTab]),
        markdown(),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          dragover: handleEditorDragOver,
          drop: handleEditorDrop,
          paste: handleEditorPaste
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            content = update.state.doc.toString();
            if (!applyingServerText) {
              queueLocalUpdate(update.changes);
              // Dispatching from inside an update is not allowed, and the
              // expansion is a separate edit for undo anyway.
              queueMicrotask(expandTaskShorthandInEditor);
            }
          }
          if (update.docChanged || update.selectionSet)
            updateSelectedText(update.state);
        })
      ]
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

  async function copyCodeBlock(block) {
    try {
      await navigator.clipboard.writeText(block.text);
      copiedCode = block;
      clearTimeout(copiedCodeTimer);
      copiedCodeTimer = setTimeout(() => (copiedCode = null), 1400);
      error = '';
    } catch {
      error = 'Could not copy code to the clipboard.';
    }
  }

  function sendChat() {
    return streamChat({ prompt: chatPrompt.trim() });
  }

  /** Runs a chat preset against the whole note, with no selection required. */
  function runChatPreset(preset) {
    return streamChat({
      prompt: chatPrompt.trim(),
      presetId: preset.id,
      label: preset.label
    });
  }

  async function streamChat({ prompt, presetId = '', label = '' }) {
    if ((!prompt && !presetId) || chatStreaming || inlineEditLoading) return;

    chatPrompt = '';
    chatStatus = 'Thinking...';
    chatStreaming = true;
    chatAbort?.abort();
    chatAbort = new AbortController();
    chatMessages = [
      ...chatMessages,
      // A preset with nothing typed would otherwise open an empty user bubble.
      { role: 'user', text: prompt || label },
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
            presetId,
            prompt
          })
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(
          'Server unavailable. Check the SSH tunnel and backend.'
        );
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

  async function scrollChatToBottom() {
    await tick();
    // Scroll through a plain local: assigning to chatScrollHost.scrollTop
    // directly compiles to a mutation of the bound element, which would mark it
    // dirty and re-run the statement below on every scroll.
    const host = chatScrollHost;
    if (host) host.scrollTop = host.scrollHeight;
  }

  // Track chatMessages only. chatScrollHost is read after the await above, so it
  // stays out of this statement's dependencies and cannot retrigger it.
  $: (chatMessages, scrollChatToBottom());

  function clearInlineEdit() {
    inlineEditAbort?.abort();
    inlineEditAbort = null;
    inlineEditLoading = false;
    inlineEditPreview = null;
    inlineEditStatus = '';
  }

  async function requestInlineEdit(presetId = '') {
    const instruction = chatPrompt.trim();
    if ((!instruction && !presetId) || inlineEditLoading || !canInlineEdit)
      return;

    const root = selectedRoot;
    const path = selectedPath;
    const range = { from: selectedRange.from, to: selectedRange.to };
    const original = editorView.state.sliceDoc(range.from, range.to);

    inlineEditAbort?.abort();
    inlineEditAbort = new AbortController();
    const abort = inlineEditAbort;
    inlineEditLoading = true;
    inlineEditStatus = 'Drafting edit...';
    dismissRelatedLinks();
    error = '';
    setViewMode('edit');

    // Show the panel before the first token so a slow local model reads as
    // working rather than hung.
    inlineEditPreview = {
      root,
      path,
      range,
      original,
      replacement: '',
      streaming: true,
      diffFiles: [buildReplacementDiffFile(original, '', 'AI edit preview')]
    };

    let streamed = '';
    let lastRender = 0;

    try {
      let response;
      try {
        response = await fetch('/api/ai/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            root,
            path,
            selectedText: original,
            presetId,
            instruction
          })
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(
          'Server unavailable. Check the SSH tunnel and backend.'
        );
      }
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      if (!response.body) throw new Error('AI provider did not stream.');

      await readSseStream(response.body, (event) => {
        if (event.error) throw new Error(event.error);
        if (event.text) {
          streamed += event.text;
          // Rebuilding the diff walks every line, so cap it at ~10fps instead
          // of running once per token.
          const now = performance.now();
          if (now - lastRender > 100) {
            lastRender = now;
            showInlineEditDraft(abort, original, streamed);
          }
        }
        // The final event is authoritative: fences can only be stripped once
        // the whole reply has arrived.
        if (event.done) streamed = event.replacement ?? streamed;
      });

      if (
        abort.signal.aborted ||
        root !== selectedRoot ||
        path !== selectedPath
      )
        return;

      inlineEditPreview = {
        root,
        path,
        range,
        original,
        replacement: streamed,
        streaming: false,
        diffFiles: [
          buildReplacementDiffFile(original, streamed, 'AI edit preview')
        ]
      };
      inlineEditStatus =
        original === streamed ? 'AI returned unchanged text' : 'Review edit';
      chatPrompt = '';
    } catch (err) {
      if (err.name === 'AbortError') return;
      // A half-streamed rewrite must never be acceptable.
      inlineEditPreview = null;
      inlineEditStatus = 'AI edit failed';
      error = err.message;
    } finally {
      if (inlineEditAbort === abort) {
        inlineEditAbort = null;
        inlineEditLoading = false;
      }
    }
  }

  function showInlineEditDraft(abort, original, replacement) {
    if (abort.signal.aborted || !inlineEditPreview) return;
    inlineEditPreview = {
      ...inlineEditPreview,
      replacement,
      diffFiles: [
        buildReplacementDiffFile(original, replacement, 'AI edit preview')
      ]
    };
  }

  function acceptInlineEdit() {
    const preview = inlineEditPreview;
    if (!preview || preview.streaming) return;
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

  /**
   * Asks the server which existing notes the open note should link to. Nothing
   * is written until the reader accepts, and only this note is ever touched.
   */
  async function requestRelatedNotes() {
    if (relatedLoading || !selectedIsMarkdown) return;

    const root = selectedRoot;
    const path = selectedPath;
    relatedAbort?.abort();
    relatedAbort = new AbortController();
    const abort = relatedAbort;
    relatedLoading = true;
    relatedStatus = 'Looking for related notes...';
    relatedPanel = null;
    // Both panels dock to the same corner of the editor.
    clearInlineEdit();
    error = '';

    try {
      let response;
      try {
        response = await fetch('/api/ai/related', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({ root, path, dailyNoteFolder })
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(
          'Server unavailable. Check the SSH tunnel and backend.'
        );
      }
      if (!response.ok) throw new Error(await responseErrorMessage(response));

      const result = await response.json();
      // The reader may have moved on while a slow model was thinking.
      if (
        abort.signal.aborted ||
        root !== selectedRoot ||
        path !== selectedPath
      )
        return;

      const suggestions = (result.suggestions ?? []).filter(
        (suggestion) => suggestion.target
      );
      relatedPanel = {
        root,
        path,
        suggestions,
        selected: new Set(suggestions.map((suggestion) => suggestion.path)),
        warning: result.warning ?? ''
      };
      relatedStatus = suggestions.length
        ? `Reviewed ${result.candidateCount} notes`
        : 'No related notes found';
    } catch (err) {
      if (err.name === 'AbortError') return;
      relatedStatus = 'Could not find related notes';
      error = err.message;
    } finally {
      if (relatedAbort === abort) {
        relatedAbort = null;
        relatedLoading = false;
      }
    }
  }

  function toggleRelatedSuggestion(suggestion) {
    if (!relatedPanel) return;
    const selected = new Set(relatedPanel.selected);
    if (selected.has(suggestion.path)) selected.delete(suggestion.path);
    else selected.add(suggestion.path);
    relatedPanel = { ...relatedPanel, selected };
  }

  function relatedBulletText(suggestion) {
    return suggestion.reason
      ? `[[${suggestion.target}]] — ${suggestion.reason}`
      : `[[${suggestion.target}]]`;
  }

  /**
   * Appends the checked links to the note's Related section through the editor,
   * so the write rides the existing autosave and collab path and stays undoable.
   */
  function applyRelatedLinks() {
    const panel = relatedPanel;
    if (!panel || !editorView) return;
    if (panel.root !== selectedRoot || panel.path !== selectedPath) {
      error = 'The suggested links no longer match the open file.';
      return;
    }

    const chosen = panel.suggestions.filter((suggestion) =>
      panel.selected.has(suggestion.path)
    );
    const insertion = relatedInsertion(editorView.state.doc.toString(), chosen);
    if (!insertion) {
      relatedStatus = 'Those links are already in this note';
      return;
    }

    setViewMode('edit');
    editorView.dispatch({
      changes: insertion,
      selection: { anchor: insertion.from + insertion.insert.length },
      effects: EditorView.scrollIntoView(insertion.from, { y: 'center' })
    });
    editorView.focus();
    dismissRelatedLinks();
  }

  function dismissRelatedLinks() {
    relatedAbort?.abort();
    relatedAbort = null;
    relatedLoading = false;
    relatedPanel = null;
    relatedStatus = '';
  }

  // Keyed on the item's source line rather than its position among the tasks:
  // counting tasks needed a second regex that did not skip code fences, so a
  // `- [ ]` inside one shifted every checkbox after it onto the wrong line.
  function toggleTask(sourceLine) {
    if (!editorView || !Number.isInteger(sourceLine) || sourceLine < 0) return;

    const doc = editorView.state.doc;
    if (sourceLine + 1 > doc.lines) return;

    const target = doc.line(sourceLine + 1);
    const insert = toggleTaskLine(target.text, dailyNoteDate(new Date()));
    if (insert === target.text) return;

    editorView.dispatch({
      changes: { from: target.from, to: target.to, insert }
    });
  }

  function rejectInlineEdit() {
    // Doubles as Cancel while streaming, so it must drop the in-flight request.
    clearInlineEdit();
    editorView?.focus();
  }

  async function loadRoots() {
    try {
      workspaceRoots = await requestJson('/api/workspace/roots');
      selectedRoot = workspaceRoots[0]?.id ?? '0';
      viewMode = readWorkspaceViewMode(selectedRoot);
      ({ folder: dailyNoteFolder, stored: dailyNoteFolderStored } =
        readDailyNoteFolder());
      dailyNoteTemplatePath = readDailyNoteTemplatePath();
      imageAssetFolder = readImageAssetFolder();
      recentPaths = readRecentFiles(selectedRoot);
      loadAiPresets(selectedRoot);
      await loadTree(selectedRoot);
      reconcileDailyNoteFolder();
      await loadOverview(selectedRoot);
      const path = navigationPathFromLocation();
      if (path) await openFile(path, { historyMode: 'replace' });
      else if (viewMode === 'graph') await loadGraph();
      await restoreReferencePane(selectedRoot);
    } catch (err) {
      error = err.message;
    }
  }

  async function loadAiPresets(root = selectedRoot) {
    try {
      const result = await requestJson(
        `/api/ai/presets?root=${encodeURIComponent(root)}`
      );
      if (root !== selectedRoot) return;
      aiPresets = result.presets ?? [];
      aiPresetWarning = result.warning ?? '';
    } catch {
      // Presets are an enhancement; a typed instruction still works without them.
      if (root !== selectedRoot) return;
      aiPresets = [];
      aiPresetWarning = '';
    }
  }

  function groupPresets(presets) {
    const groups = new Map();
    for (const preset of presets) {
      const name = preset.group || 'Custom';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(preset);
    }
    return [...groups].map(([name, items]) => ({ name, items }));
  }

  function reconcilePresetGroup(groups) {
    if (groups.some((group) => group.name === activePresetGroup)) return;
    activePresetGroup = groups[0]?.name ?? '';
  }

  /** Chat presets read the note; edit presets rewrite the selection. */
  function runPreset(preset) {
    if (preset.kind === 'chat') return runChatPreset(preset);
    return requestInlineEdit(preset.id);
  }

  function presetDisabled(preset) {
    if (chatStreaming || inlineEditLoading) return true;
    return preset.kind !== 'chat' && !canInlineEdit;
  }

  /** Group names come from user config, so they need slugging for an id. */
  function presetGroupId(name) {
    return `ai-preset-tab-${String(name).replace(/[^A-Za-z0-9]+/g, '-')}`;
  }

  function presetTitle(preset) {
    if (preset.kind !== 'chat' && !canInlineEdit) {
      return 'Select text in the editor';
    }
    return preset.instruction || preset.label;
  }

  async function loadTree(root = selectedRoot) {
    try {
      const nextTree = await requestJson(
        `/api/workspace/tree?root=${encodeURIComponent(root)}`
      );
      if (root === selectedRoot) {
        tree = nextTree;
        treeLoaded = true;
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
    recentPaths = readRecentFiles(root);
    tree = [];
    selectedPath = '';
    selectedFileKind = 'markdown';
    content = '';
    lastSaved = '';
    viewMode = readWorkspaceViewMode(root);
    graphData = { nodes: [], edges: [], unresolved: 0 };
    graphView = { nodes: [], edges: [] };
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
    treeLoaded = false;
    fileCache = new Map();
    navigationBackStack = [];
    navigationForwardStack = [];
    setEditorContent('');
    loadAiPresets(root);
    await loadTree();
    reconcileDailyNoteFolder();
    await loadOverview();
    if (viewMode === 'graph') await loadGraph();
    await restoreReferencePane(root);
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
    if (fileKind === 'markdown')
      setViewMode(readWorkspaceViewMode(root), { remember: false });
    diffFiles = [];
    diffStatus = '';
    error = '';
    clearInlineEdit();
    followReference(path);

    if (fileKind !== 'markdown') {
      showMediaFile(path);
      rememberRecentFile(path);
      status = '[Read-only]';
      rememberNavigationEntry(previousEntry, fileNavigationEntry(path), {
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
      rememberRecentFile(path);
      status = buffered ? '[Offline - Retrying]' : '[Saved]';
      rememberNavigationEntry(previousEntry, fileNavigationEntry(path), {
        historyMode,
        rememberNavigation
      });
      updateNavigationState(path, historyMode);
      if (buffered) queueRetry();
      await applyWorkspaceViewMode(root, path);
    } catch (err) {
      const buffered = sessionStorage.getItem(storageKey(root, path));
      if (buffered) {
        showFile(root, path, buffered, '', 0, { collaborate: false });
        status = '[Offline - Retrying]';
        rememberNavigationEntry(previousEntry, fileNavigationEntry(path), {
          historyMode,
          rememberNavigation
        });
        updateNavigationState(path, historyMode);
        queueRetry();
        await applyWorkspaceViewMode(root, path);
      } else {
        error = err.message;
        status = '[Offline - Retrying]';
      }
    }
  }

  async function openDailyNote(date = new Date()) {
    const path = todayNotePath(date);
    const root = selectedRoot;
    const previousEntry = currentNavigationEntry();

    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();

    selectedPath = path;
    selectedFileKind = 'markdown';
    setViewMode(readWorkspaceViewMode(root), { remember: false });
    diffFiles = [];
    diffStatus = '';
    clearInlineEdit();
    followReference(path);
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
      rememberRecentFile(path);
      status = '[Saved]';
      rememberNavigationEntry(previousEntry, fileNavigationEntry(path));
      updateNavigationState(path);
      await applyWorkspaceViewMode(root, path);
    } catch (err) {
      if (root !== selectedRoot || selectedPath !== path) return;
      if (err.status !== 404) {
        error = err.message;
        status = '[Offline - Retrying]';
        return;
      }

      const nextContent = await withCarriedTasks(
        buildDailyNoteContent(date, path, await loadDailyNoteTemplate(root)),
        root,
        path,
        date
      );
      try {
        await requestJson('/api/workspace/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, path, content: nextContent })
        });
        if (root !== selectedRoot || selectedPath !== path) return;
        showFile(root, path, nextContent, nextContent, 0);
        rememberRecentFile(path);
        status = '[Saved]';
        rememberNavigationEntry(previousEntry, fileNavigationEntry(path));
        updateNavigationState(path);
        await loadTree(root);
        await applyWorkspaceViewMode(root, path);
      } catch (saveErr) {
        sessionStorage.setItem(storageKey(root, path), nextContent);
        showFile(root, path, nextContent, '', 0, { collaborate: false });
        error = saveErr.message;
        status = '[Offline - Retrying]';
        rememberNavigationEntry(previousEntry, fileNavigationEntry(path));
        updateNavigationState(path);
        queueRetry();
        await applyWorkspaceViewMode(root, path);
      }
    }
  }

  /**
   * Appends the previous daily note's unfinished tasks to a daily note that is
   * about to be created.
   *
   * Runs only on creation, so a note can never be carried into twice — and
   * since yesterday's note carried its own backlog forward the same way, a task
   * keeps travelling until it is ticked, however long the gap between notes.
   * Carryover is a convenience: any failure leaves the template content alone
   * rather than blocking the new note.
   */
  async function withCarriedTasks(templateContent, root, path, date) {
    const previousPath = previousDailyNotePath(dailyNoteEntries, date);
    if (!previousPath) return templateContent;

    try {
      const previous = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(previousPath)}`
      );
      const origin = shortestWikiTarget(previousPath, path, workspaceFiles, {
        dailyNoteFolder: activeDailyNoteFolder
      });
      const lines = carriedTaskLines(previous.content, origin);
      if (!lines.length) return templateContent;

      return `${templateContent.replace(/\s+$/, '')}\n\n## Carried over\n\n${lines.join('\n')}\n`;
    } catch {
      return templateContent;
    }
  }

  async function createMarkdownNote() {
    const entered = prompt('New note path', defaultNewNotePath());
    if (entered === null) return;

    const path = normalizeMarkdownPath(entered);
    if (!path) {
      error = 'Invalid note path.';
      return;
    }

    if (selectedPath && hasUnsavedChanges()) await saveNow();

    const root = selectedRoot;
    const content = `# ${basename(path).replace(/\.(md|markdown)$/i, '')}\n\n`;
    status = '[Syncing...]';
    error = '';

    try {
      const loadUrl = `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
      try {
        await requestJson(loadUrl);
        await openFile(path);
        return;
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      await requestJson('/api/workspace/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path, content })
      });
      if (root !== selectedRoot) return;

      await loadTree(root);
      await openFile(path);
    } catch (err) {
      if (root === selectedRoot) {
        error = err.message;
        status = '[Saved]';
      }
    }
  }

  function todayNotePath(date = new Date(), folder = activeDailyNoteFolder) {
    return buildDailyNotePath(date, folder);
  }

  const shortcutKey =
    typeof navigator !== 'undefined' &&
    /Mac|iP(hone|ad)/.test(navigator.platform)
      ? 'Cmd'
      : 'Ctrl';

  // Every shortcut carries both Cmd/Ctrl and Shift. Plain Alt combinations are
  // unusable here because macOS turns Alt+letter into a dead key that would
  // type an accent into the editor instead.
  // Typing a `/` into a field means a slash, never a shortcut.
  function isTypingTarget(target) {
    const tag = target?.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      Boolean(target?.isContentEditable)
    );
  }

  function handleShortcut(event) {
    // A bare `/` reaches the Tasks filter, which is safe only there: the board
    // is the one full-frame view with nothing to type into.
    if (
      event.key === '/' &&
      viewMode === 'tasks' &&
      !paletteOpen &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !isTypingTarget(event.target)
    ) {
      event.preventDefault();
      focusTaskFilter();
      return;
    }

    // Quick open is the one plain Cmd/Ctrl combination. It reads the
    // platform modifier rather than either one, because Ctrl+K on macOS is
    // already the editor's delete-to-end-of-line.
    if (
      event.code === 'KeyK' &&
      !event.shiftKey &&
      !event.altKey &&
      (shortcutKey === 'Cmd' ? event.metaKey : event.ctrlKey)
    ) {
      event.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette();
      return;
    }

    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey)
      return;

    // Keyed by physical key because Shift rewrites event.key into < and >.
    const run = {
      Comma: () => openOlderDailyNote(),
      Period: () => openNewerDailyNote(),
      KeyE: () => selectedPath && selectedIsMarkdown && setViewMode('edit'),
      KeyP: () => selectedPath && setViewMode('preview'),
      KeyT: () => workspaceRoots.length && showTasks(),
      // Not KeyR: Chrome reserves Cmd/Ctrl+Shift+R for a hard reload.
      Backslash: () => toggleReferencePane()
    }[event.code];
    if (!run) return;

    event.preventDefault();
    run();
  }

  function adjacentNotePath(entries, index, step) {
    const target = stepDailyNote(entries.length, index, step);
    return target === null ? '' : entries[target].path;
  }

  // Opens through openFile so a missing note is never created on the way.
  async function openAdjacentDailyNote(path) {
    if (path) await openFile(path);
  }

  async function openOlderDailyNote() {
    await openAdjacentDailyNote(olderDailyNotePath);
  }

  async function openNewerDailyNote() {
    await openAdjacentDailyNote(newerDailyNotePath);
  }

  // Runs once the tree is loaded, so a stored path can be checked for survival.
  async function restoreReferencePane(root) {
    const stored = readReferencePane(root);
    referenceOpen = stored.open;
    referencePinned = false;
    referencePath = '';
    referenceContent = '';
    referenceStatus = '';
    if (!referenceOpen) return;

    const pinned =
      stored.path && markdownFiles.some((file) => file.path === stored.path);
    if (pinned) await setReferencePath(stored.path);
    else await autoPickReference();
  }

  async function toggleReferencePane() {
    if (referenceOpen) {
      closeReferencePane();
      return;
    }

    referenceOpen = true;
    rememberReferencePane(selectedRoot);
    if (!referencePinned || !referencePath) await autoPickReference();
    else await loadReferenceFile(selectedRoot, referencePath);
  }

  function closeReferencePane() {
    referenceOpen = false;
    referencePinned = false;
    referenceContent = '';
    referenceStatus = '';
    referenceRun += 1;
    rememberReferencePane(selectedRoot);
  }

  // The reference follows the editor until the reader pins a note by hand.
  async function autoPickReference(openPath = selectedPath) {
    const path = defaultReferencePath(dailyNotePathList, openPath);
    referencePinned = false;
    await setReferencePath(path, { pin: false });
  }

  function followReference(openPath) {
    if (referenceOpen && !referencePinned) autoPickReference(openPath);
  }

  async function setReferencePath(path, { pin = true } = {}) {
    referencePath = path;
    if (pin) referencePinned = true;
    referenceContent = '';
    referenceStatus = path ? '' : 'No other note to show yet.';
    rememberReferencePane(selectedRoot);
    if (path) await loadReferenceFile(selectedRoot, path);
  }

  async function stepReferenceNote(step) {
    const path = step < 0 ? olderReferencePath : newerReferencePath;
    if (path) await setReferencePath(path);
  }

  function chooseReferencePath(event) {
    setReferencePath(event.currentTarget.value);
  }

  // Read-only: never joins the collaboration stream, the save queue, or fileCache.
  async function loadReferenceFile(root, path) {
    const run = ++referenceRun;
    referenceStatus = 'Loading...';

    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (run !== referenceRun || root !== selectedRoot) return;
      referenceContent = file.content;
      referenceStatus = '';
    } catch (err) {
      if (run !== referenceRun || root !== selectedRoot) return;
      referenceContent = '';
      referenceStatus = err.status === 404 ? 'Note not found.' : err.message;
    }
  }

  async function loadDailyNoteTemplate(root) {
    if (!dailyNoteTemplatePath) return '';

    try {
      return (
        await requestJson(
          `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(dailyNoteTemplatePath)}`
        )
      ).content;
    } catch {
      return '';
    }
  }

  async function showCalendar({ remember = true } = {}) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    if (remember) rememberViewNavigation('calendar');
    viewMode = 'calendar';
    calendarMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1
    );
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    error = '';
  }

  async function showTasks({ remember = true } = {}) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    if (remember) rememberViewNavigation('tasks');
    viewMode = 'tasks';
    todayText = dailyNoteDate(new Date());
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    error = '';
    await loadTasks(selectedRoot);
  }

  async function loadTasks(root) {
    tasksStatus = 'Loading tasks...';
    // Completed tasks are fetched only when they are wanted, so the server's
    // cap is not spent on work that is already finished.
    const include = showCompletedTasks ? '&include=all' : '';
    try {
      const result = await requestJson(
        `/api/workspace/tasks?root=${encodeURIComponent(root)}${include}`
      );
      if (root !== selectedRoot) return;
      workspaceTasks = result.tasks;
      const kind = showCompletedTasks ? 'tasks' : 'open tasks';
      tasksStatus =
        result.total > result.tasks.length
          ? `Showing the first ${result.tasks.length} of ${result.total} ${kind}.`
          : '';
    } catch (err) {
      if (root !== selectedRoot) return;
      workspaceTasks = [];
      tasksStatus = err.message;
    }
  }

  /** Opens the note a task lives in and puts the cursor on its line. */
  async function openTask(task, event) {
    // A link in the task text belongs to the link, not to the row.
    if (event?.target?.closest?.('a')) return;

    await openFile(task.path);
    if (selectedPath !== task.path) return;

    // The reader came from a list of tasks, not from the editor, so the note
    // opens in preview — where the box can be ticked — rather than dropping a
    // cursor into the source. Not remembered, so it does not quietly replace
    // whichever mode the note is usually read in.
    setViewMode('preview', { remember: false });
    await tick();
    revealPreviewLine(task.line);
  }

  function openTaskOnKey(task, event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target?.closest?.('a')) return;
    event.preventDefault();
    openTask(task);
  }

  /** Scrolls a source line into view in the preview and marks it briefly. */
  function revealPreviewLine(line) {
    const target = document.querySelector(
      `.preview-pane [data-line="${line}"]`
    );
    if (!target) return;

    target.scrollIntoView({ block: 'center' });
    target.classList.add('line-flash');
    setTimeout(() => target.classList.remove('line-flash'), 1200);
  }

  function moveCalendarMonth(amount) {
    calendarMonth = shiftMonth(calendarMonth, amount);
  }

  function showCurrentMonth() {
    calendarMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1
    );
  }

  function calendarDayPath(day) {
    return todayNotePath(day.date);
  }

  function calendarDayLabel(day) {
    return new Intl.DateTimeFormat([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(day.date);
  }

  function showFile(
    root,
    path,
    nextContent,
    savedContent,
    version = 0,
    { collaborate = true } = {}
  ) {
    if (viewMode === 'calendar')
      setViewMode(readWorkspaceViewMode(root), { remember: false });
    if (!nextContent.trim() && viewMode === 'preview')
      setViewMode('edit', { remember: false });
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

  /**
   * Loading a file replaces the whole state rather than dispatching a change,
   * so the undo history starts empty on every note. Dispatching would leave the
   * load itself undoable: Cmd+Z would pull the previous note's text into this
   * one, and the autosave would then write it to disk.
   */
  function setEditorContent(nextContent) {
    editorView.setState(editorState(nextContent));
    content = editorView.state.doc.toString();
    updateSelectedText(editorView.state);
  }

  function handleEditorPaste(event, view) {
    if (!selectedPath || !selectedIsMarkdown) return false;
    const files = dataTransferUploadFiles(event.clipboardData);
    if (!files.length) {
      const sources = pastedImageSources(event.clipboardData);
      if (!sources.length) {
        const text = event.clipboardData?.getData('text/plain') || '';
        const beforeCursor = textBeforeCursor(view.state);
        const arxivId = arxivPasteId(text, { beforeCursor });
        const insert =
          (arxivId && arxivCitation({ id: arxivId })) ??
          quotedPasteText(view.state, text, beforeCursor);
        if (insert === null) return false;

        event.preventDefault();
        const from = view.state.selection.main.from;
        insertText(view, insert);
        // The bare link lands now; author and title arrive when arXiv answers.
        if (arxivId) {
          upgradeArxivCitation(arxivId, insert, {
            from,
            to: from + insert.length
          });
        }
        return true;
      }

      event.preventDefault();
      uploadPastedImageSources(sources, editorView.state.selection.main);
      return true;
    }

    event.preventDefault();
    uploadFiles(files, editorView.state.selection.main);
    return true;
  }

  /**
   * Replaces the bare link a paste just inserted with the full citation. Runs
   * un-awaited, so everything it touches may have moved on: the guards below
   * drop the upgrade rather than risk rewriting text the user has since edited.
   */
  async function upgradeArxivCitation(id, placeholder, range) {
    const root = selectedRoot;
    const path = selectedPath;

    let metadata;
    try {
      metadata = await requestJson(`/api/arxiv?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (root === selectedRoot) error = err.message;
      return;
    }

    if (root !== selectedRoot || path !== selectedPath || !selectedIsMarkdown) {
      return;
    }

    const citation = arxivCitation(metadata);
    if (citation === placeholder) return;

    const length = editorView.state.doc.length;
    const from = Math.min(range.from, length);
    const to = Math.min(range.to, length);
    if (editorView.state.doc.sliceString(from, to) !== placeholder) return;

    // Only carry the cursor along if it is still sitting right after the link.
    const cursor = editorView.state.selection.main;
    const followCursor = cursor.empty && cursor.head === to;
    editorView.dispatch({
      changes: { from, to, insert: citation },
      ...(followCursor ? { selection: { anchor: from + citation.length } } : {})
    });
  }

  function textBeforeCursor(state) {
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.from);
    return line.text.slice(0, selection.from - line.from);
  }

  function quotedPasteText(state, text, beforeCursor) {
    const line = state.doc.lineAt(state.selection.main.from);
    const previousLine =
      !beforeCursor.trim() && line.number > 1
        ? state.doc.line(line.number - 1).text
        : '';
    return quotedBlockPaste(text, { beforeCursor, previousLine });
  }

  function insertText(view, insert) {
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert },
      selection: { anchor: selection.from + insert.length }
    });
  }

  function handleEditorDragOver(event) {
    if (
      selectedPath &&
      selectedIsMarkdown &&
      dataTransferUploadFiles(event.dataTransfer).length
    ) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  function handleEditorDrop(event, view) {
    if (!selectedPath || !selectedIsMarkdown) return false;
    const files = dataTransferUploadFiles(event.dataTransfer);
    if (!files.length) return false;

    event.preventDefault();
    const position =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
      view.state.selection.main.head;
    uploadFiles(files, { from: position, to: position });
    return true;
  }

  function dataTransferUploadFiles(data) {
    const files = [...(data?.files || [])].filter(isUploadFile);
    if (files.length) return files;

    return [...(data?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(isUploadFile);
  }

  function isUploadFile(file) {
    return (
      file?.type?.startsWith('image/') ||
      file?.type === 'application/pdf' ||
      UPLOAD_EXTENSIONS.test(file?.name || '')
    );
  }

  async function uploadFiles(files, range) {
    const root = selectedRoot;
    const path = selectedPath;
    status = '[Syncing...]';
    error = '';

    try {
      const embeds = [];
      for (const file of files) {
        const upload = await uploadPayloadForFile(file);
        const result = await requestJson('/api/workspace/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            root,
            folder: imageAssetFolder,
            notePath: path,
            name: upload.name,
            mimeType: upload.mimeType,
            data: upload.data
          })
        });
        embeds.push(
          `${result.fileKind === 'image' ? '!' : ''}[[${result.path.replace(/^\//, '')}]]`
        );
      }
      if (root !== selectedRoot) return;

      await loadTree(root);
      if (path && path === selectedPath && selectedIsMarkdown && range) {
        insertUploadEmbeds(embeds, range);
        editorView.focus();
      } else if (embeds.length) {
        await openFile(`/${embeds[0].replace(/^!?\[\[|\]\]$/g, '')}`);
      }
    } catch (err) {
      if (root === selectedRoot) {
        error = err.message;
        status = hasUnsavedChanges() ? '[Offline - Retrying]' : '[Saved]';
      }
    }
  }

  async function uploadPastedImageSources(sources, range) {
    const root = selectedRoot;
    status = '[Syncing...]';
    error = '';

    try {
      const files = await uploadFilesForPastedImageSources(sources);
      if (root === selectedRoot) await uploadFiles(files, range);
    } catch (err) {
      if (root === selectedRoot) {
        error = err.message;
        status = hasUnsavedChanges() ? '[Offline - Retrying]' : '[Saved]';
      }
    }
  }

  function insertUploadEmbeds(embeds, range) {
    const insert = embeds.join('\n');
    const length = editorView.state.doc.length;
    const from = Math.max(0, Math.min(range.from, length));
    const to = Math.max(from, Math.min(range.to, length));
    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    });
  }

  async function chooseUploadFiles(event) {
    const files = [...(event.currentTarget.files || [])].filter(isUploadFile);
    event.currentTarget.value = '';
    if (!files.length) return;
    await uploadFiles(
      files,
      selectedIsMarkdown ? editorView.state.selection.main : null
    );
  }

  async function deleteSelectedFile() {
    if (
      !selectedPath ||
      !confirm(`Delete ${selectedPath}? This cannot be undone.`)
    )
      return;

    const root = selectedRoot;
    const path = selectedPath;
    const fallbackPath = [...navigationBackStack]
      .reverse()
      .find(
        (item) =>
          item.root === root &&
          item.path !== path &&
          findFileNode(tree, item.path)
      )?.path;
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    retryTimer = null;
    sessionStorage.removeItem(storageKey(root, path));
    stopCollaboration();
    status = '[Syncing...]';
    error = '';

    try {
      await requestJson('/api/workspace/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path })
      });
      if (root !== selectedRoot || path !== selectedPath) return;

      fileCache.delete(rootPathKey(root, path));
      recentPaths = recentPaths.filter((item) => item !== path);
      searchResults = searchResults.filter((item) => item.path !== path);
      navigationBackStack = navigationBackStack.filter(
        (item) => item.path !== path && item.path !== fallbackPath
      );
      navigationForwardStack = navigationForwardStack.filter(
        (item) => item.path !== path
      );
      tree = removePathFromTree(tree, path);
      try {
        localStorage.setItem(
          recentFilesStorageKey(root),
          JSON.stringify(recentPaths)
        );
      } catch {
        // Ignore storage failures; the visible list is already updated.
      }
      selectedPath = '';
      selectedFileKind = 'markdown';
      content = '';
      lastSaved = '';
      selectedText = '';
      selectedRange = null;
      viewMode = 'edit';
      diffFiles = [];
      diffStatus = '';
      clearInlineEdit();
      setEditorContent('');
      history.replaceState(
        { root: selectedRoot },
        '',
        location.pathname + location.search
      );
      await loadTree(root);
      await loadOverview(root);
      if (fallbackPath && findFileNode(tree, fallbackPath)) {
        await openFile(fallbackPath, {
          historyMode: 'replace',
          rememberNavigation: false
        });
        return;
      }
      status = '[Saved]';
    } catch (err) {
      if (root === selectedRoot && path === selectedPath) {
        error = err.message;
        status = '[Saved]';
      }
    }
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
      if (
        root === selectedRoot &&
        path === selectedPath &&
        !hasUnsavedChanges()
      ) {
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
    // A collaborator's edit is not this user's to undo; the history still maps
    // its own events over the incoming changes.
    editorView.dispatch({
      changes: changesForEditor,
      annotations: Transaction.addToHistory.of(false)
    });
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

  /**
   * Turns `due:friday` and `p2` into their emoji on every task line except the
   * one the caret sits on, which is very likely still half-typed. Switching
   * away from the editor passes `all`, so the last line typed is not left in
   * shorthand.
   */
  function expandTaskShorthandInEditor(all = false) {
    if (!editorView || !selectedPath || !selectedIsMarkdown) return;

    const { doc, selection } = editorView.state;
    const caretLine = doc.lineAt(selection.main.head).number;
    const changes = taskShorthandEdits(
      doc.toString(),
      dailyNoteDate(new Date())
    )
      .filter((edit) => all || edit.line + 1 !== caretLine)
      .map((edit) => {
        const line = doc.line(edit.line + 1);
        return { from: line.from, to: line.to, insert: edit.text };
      });

    if (changes.length) editorView.dispatch({ changes });
  }

  async function saveNow() {
    if (!selectedPath || !selectedIsMarkdown) return;
    // Before the timer is cleared, so the expansion's own edit is saved with
    // the rest rather than left waiting behind a cancelled flush.
    expandTaskShorthandInEditor(true);
    clearTimeout(saveTimer);
    if (
      collaborationEnabled &&
      (pendingUpdates.length || inFlightUpdates.length)
    ) {
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
    await loadOverview(root);
    if (viewMode === 'calendar') {
      status = '[Saved]';
      return;
    }
    if (viewMode === 'graph') {
      await loadGraph();
      status = '[Saved]';
      return;
    }
    if (path && content === lastSaved)
      await openFile(path, { historyMode: 'replace' });
    else if (!path) status = '[Saved]';
  }

  function closeViewMenu() {
    viewMenuOpen = false;
  }

  function closeViewMenuOnEscape(event) {
    if (event.key === 'Escape') closeViewMenu();
  }

  async function chooseDiffView() {
    closeViewMenu();
    await showDiff();
  }

  async function chooseGraphView() {
    closeViewMenu();
    await showGraph();
  }

  function openMarkdownHelp() {
    closeViewMenu();
    markdownHelpOpen = true;
  }

  function chooseUpload() {
    closeViewMenu();
    uploadInput?.click();
  }

  async function chooseDelete() {
    closeViewMenu();
    await deleteSelectedFile();
  }

  async function chooseReferencePane() {
    closeViewMenu();
    await toggleReferencePane();
  }

  async function showDiff() {
    if (!selectedPath || !selectedIsMarkdown) return;
    if (hasUnsavedChanges()) await saveNow();

    const root = selectedRoot;
    const path = selectedPath;
    setViewMode('diff');
    clearInlineEdit();
    await loadSelectedDiff(root, path);
  }

  async function loadSelectedDiff(root, path) {
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

  async function showGraph() {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    setViewMode('graph');
    graphScope = selectedPath && selectedIsMarkdown ? 'local' : 'wiki';
    graphStatus = 'Loading graph...';
    clearInlineEdit();

    await loadGraph();
  }

  async function applyWorkspaceViewMode(root, path) {
    if (root !== selectedRoot || path !== selectedPath) return;
    if (viewMode === 'diff') await loadSelectedDiff(root, path);
    else if (viewMode === 'graph') {
      graphScope = selectedPath && selectedIsMarkdown ? 'local' : 'wiki';
      if (graphData.nodes.length) updateGraphLayout();
      else await loadGraph();
    }
  }

  async function loadGraph() {
    graphStatus = 'Loading graph...';
    try {
      graphData = await requestJson(
        `/api/workspace/graph?root=${encodeURIComponent(selectedRoot)}`
      );
      graphStatus = '';
      updateGraphLayout();
    } catch (err) {
      graphStatus = err.message;
    }
  }

  function updateGraphLayout() {
    graphView = layoutGraph(graphData, graphScope, selectedPath);
    resetGraphViewport();
  }

  function chooseGraphScope(event) {
    graphScope = event.currentTarget.value;
    updateGraphLayout();
  }

  function resetGraphViewport() {
    if (!graphView.nodes.length) {
      graphViewport = { x: 0, y: 0, width: 1000, height: 700 };
      return;
    }
    const xs = graphView.nodes.map((node) => node.x);
    const ys = graphView.nodes.map((node) => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    let width = Math.max(500, maxX - minX + 320);
    let height = Math.max(280, Math.max(...ys) - Math.min(...ys) + 120);
    if (width / height < 1.6) width = height * 1.6;
    else height = width / 1.6;
    graphViewport = {
      x: minX - 70,
      y: centerY - height / 2,
      width,
      height
    };
  }

  function zoomGraph(event) {
    const rect = graphSvg.getBoundingClientRect();
    const requested = event.deltaY > 0 ? 1.12 : 0.88;
    const width = Math.max(
      250,
      Math.min(3000, graphViewport.width * requested)
    );
    const scale = width / graphViewport.width;
    const pointerX =
      graphViewport.x +
      ((event.clientX - rect.left) / rect.width) * graphViewport.width;
    const pointerY =
      graphViewport.y +
      ((event.clientY - rect.top) / rect.height) * graphViewport.height;
    graphViewport = {
      x: pointerX - (pointerX - graphViewport.x) * scale,
      y: pointerY - (pointerY - graphViewport.y) * scale,
      width,
      height: graphViewport.height * scale
    };
  }

  function startGraphPan(event) {
    if (event.button !== 0) return;
    graphSvg.setPointerCapture(event.pointerId);
    graphPointer = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      viewport: graphViewport
    };
  }

  function moveGraphPointer(event) {
    if (!graphPointer || graphPointer.pointerId !== event.pointerId) return;
    const rect = graphSvg.getBoundingClientRect();
    const dx = event.clientX - graphPointer.clientX;
    const dy = event.clientY - graphPointer.clientY;
    graphViewport = {
      ...graphPointer.viewport,
      x:
        graphPointer.viewport.x -
        (dx / rect.width) * graphPointer.viewport.width,
      y:
        graphPointer.viewport.y -
        (dy / rect.height) * graphPointer.viewport.height
    };
  }

  function endGraphPointer(event) {
    if (!graphPointer || graphPointer.pointerId !== event.pointerId) return;
    if (graphSvg.hasPointerCapture(event.pointerId))
      graphSvg.releasePointerCapture(event.pointerId);
    graphPointer = null;
  }

  async function openGraphNode(node) {
    await openFile(node.path);
  }

  function graphEdgeState(edge) {
    if (!hoveredGraphPath) return '';
    return edge.source.path === hoveredGraphPath ||
      edge.target.path === hoveredGraphPath
      ? 'active'
      : 'dimmed';
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
      // Focusing a control outside the editor collapses the DOM selection, but
      // CodeMirror still holds the real one. Keep it, or reaching for the
      // preset list would disarm the very action it is meant to run.
      if (editorView && !editorView.state.selection.main.empty) return;
      selectedText = '';
      selectedRange = null;
    }
  }

  function storageKey(root, path) {
    return `webmd:unsaved:${rootPathKey(root, path)}`;
  }

  async function showHome() {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();
    selectedPath = '';
    selectedFileKind = 'markdown';
    content = '';
    lastSaved = '';
    viewMode = 'edit';
    diffFiles = [];
    diffStatus = '';
    error = '';
    selectedText = '';
    selectedRange = null;
    navigationBackStack = [];
    navigationForwardStack = [];
    clearInlineEdit();
    setEditorContent('');
    history.replaceState(
      { root: selectedRoot },
      '',
      location.pathname + location.search
    );
    status = '[Saved]';
    await loadOverview();
  }

  function toggleSidebar(view) {
    if (sidebarVisible && sidebarView === view) {
      sidebarVisible = false;
      return;
    }
    sidebarView = view;
    sidebarVisible = true;
  }

  async function loadOverview(root = selectedRoot) {
    overviewStatus = 'Loading workspace...';
    try {
      const nextOverview = await requestJson(
        `/api/workspace/overview?root=${encodeURIComponent(root)}`
      );
      if (root === selectedRoot) {
        overview = nextOverview;
        overviewStatus = '';
      }
    } catch (err) {
      if (root === selectedRoot) overviewStatus = err.message;
    }
  }

  function rememberRecentFile(path) {
    recentPaths = [path, ...recentPaths.filter((item) => item !== path)].slice(
      0,
      RECENT_FILES_LIMIT
    );
    try {
      localStorage.setItem(
        recentFilesStorageKey(selectedRoot),
        JSON.stringify(recentPaths)
      );
    } catch {
      // Ignore storage failures; recent files still work this session.
    }
  }

  function readRecentFiles(root) {
    try {
      const value = JSON.parse(
        localStorage.getItem(recentFilesStorageKey(root)) || '[]'
      );
      return Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string')
            .slice(0, RECENT_FILES_LIMIT)
        : [];
    } catch {
      return [];
    }
  }

  function recentFilesStorageKey(root) {
    return `${RECENT_FILES_KEY}:${root}`;
  }

  function readWorkspaceViewMode(root) {
    try {
      const mode = localStorage.getItem(workspaceViewModeStorageKey(root));
      return WORKSPACE_VIEW_MODES.has(mode) ? mode : 'edit';
    } catch {
      return 'edit';
    }
  }

  function rememberWorkspaceViewMode(mode, root = selectedRoot) {
    if (!WORKSPACE_VIEW_MODES.has(mode)) return;
    try {
      localStorage.setItem(workspaceViewModeStorageKey(root), mode);
    } catch {
      // Ignore storage failures; the selected mode still works this session.
    }
  }

  function workspaceViewModeStorageKey(root) {
    return `${VIEW_MODE_KEY}:${root}`;
  }

  function readReferencePane(root) {
    try {
      const stored = JSON.parse(
        localStorage.getItem(referencePaneStorageKey(root)) || '{}'
      );
      return {
        open: stored.open === true,
        path: typeof stored.path === 'string' ? stored.path : ''
      };
    } catch {
      return { open: false, path: '' };
    }
  }

  function rememberReferencePane(root = selectedRoot) {
    try {
      localStorage.setItem(
        referencePaneStorageKey(root),
        JSON.stringify({
          open: referenceOpen,
          path: referencePinned ? referencePath : ''
        })
      );
    } catch {
      // Ignore storage failures; the pane still works this session.
    }
  }

  function referencePaneStorageKey(root) {
    return `${REFERENCE_PANE_KEY}:${root}`;
  }

  function rootPathKey(root, path) {
    return `${root}:${path}`;
  }

  function mediaUrl(path) {
    return `/api/workspace/media?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(path)}`;
  }

  function embeddedMediaPath(target) {
    const filePath = target.split('#')[0].trim();
    if (!IMAGE_EXTENSIONS.test(filePath)) return '';

    if (filePath.includes('/')) return normalizeWorkspaceFilePath(filePath);

    const matches = workspaceFiles.filter(
      (file) => file.fileKind === 'image' && basename(file.path) === filePath
    );
    return matches.length === 1
      ? matches[0].path
      : joinWorkspacePath(imageAssetFolder, filePath);
  }

  function wikiLinkPath(target) {
    return resolveWikiLinkPath(target, selectedPath, workspaceFiles, {
      dailyNoteFolder: activeDailyNoteFolder
    });
  }

  function wikiLinkHref(target) {
    const path = wikiLinkPath(target);
    return path ? `#${encodeURI(path)}` : '';
  }

  async function openWikiLink(event, target) {
    event.preventDefault();
    const path = wikiLinkPath(target);
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

  /**
   * The side buttons on a mouse drive the in-app history instead of the
   * browser's, so one thumb click returns from a note to wherever it was
   * opened from. Chrome only navigates on mouseup, so cancelling the mousedown
   * is what keeps the page itself from going back as well.
   */
  function handleMouseNavigation(event) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type !== 'mouseup') return;
    if (event.button === 3) navigateBack();
    else navigateForward();
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

    // Tasks and Calendar are places too, so going back to one reopens the view
    // rather than the note that happened to be selected underneath it.
    if (target.view === 'tasks') await showTasks({ remember: false });
    else if (target.view === 'calendar')
      await showCalendar({ remember: false });
    else
      await openFile(target.path, {
        historyMode: 'replace',
        rememberNavigation: false
      });
  }

  function rememberViewNavigation(view) {
    rememberNavigationEntry(currentNavigationEntry(), {
      root: selectedRoot,
      path: '',
      view
    });
  }

  function fileNavigationEntry(path) {
    return { root: selectedRoot, path, view: '' };
  }

  function currentNavigationEntry() {
    if (WORKSPACE_VIEWS.has(viewMode))
      return { root: selectedRoot, path: '', view: viewMode };
    return selectedPath
      ? { root: selectedRoot, path: selectedPath, view: '' }
      : null;
  }

  function rememberNavigationEntry(
    previousEntry,
    targetEntry,
    { historyMode = 'push', rememberNavigation = true } = {}
  ) {
    if (!rememberNavigation || historyMode !== 'push' || !previousEntry) return;

    if (
      previousEntry.root === targetEntry.root &&
      previousEntry.path === targetEntry.path &&
      previousEntry.view === targetEntry.view
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

  function joinWorkspacePath(folder, name) {
    return normalizeWorkspaceFilePath(
      `${folder === '/' ? '' : folder}/${name}`
    );
  }

  function defaultNewNotePath() {
    const folder = selectedPath.slice(0, selectedPath.lastIndexOf('/')) || '/';
    return joinWorkspacePath(folder, 'Untitled.md');
  }

  function normalizeMarkdownPath(path) {
    const normalized = normalizeWorkspaceFilePath(path.trim());
    return normalized
      ? /\.(md|markdown)$/i.test(normalized)
        ? normalized
        : `${normalized}.md`
      : '';
  }

  function normalizeWorkspaceFilePath(path) {
    const parts = (path.startsWith('/') ? path : `/${path}`)
      .split('/')
      .filter((part) => part && part !== '.');
    return parts.length && !parts.includes('..') ? `/${parts.join('/')}` : '';
  }

  function fileKindForPath(path) {
    return (
      findFileNode(workspaceTree, path)?.fileKind ||
      (IMAGE_EXTENSIONS.test(path)
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

  function removePathFromTree(nodes, path) {
    return nodes.flatMap((node) => {
      if (node.path === path) return [];
      if (node.type !== 'directory') return [node];
      return [
        { ...node, children: removePathFromTree(node.children || [], path) }
      ];
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
    dailyNoteFolderStored = true;
    calendarMonth = new Date(calendarMonth);
    try {
      localStorage.setItem(DAILY_NOTE_FOLDER_KEY, folder);
    } catch {
      // Ignore storage failures; the selected folder still works this session.
    }
  }

  function chooseDailyNoteTemplate(templatePath) {
    dailyNoteTemplatePath = templatePath;
    try {
      localStorage.setItem(DAILY_NOTE_TEMPLATE_KEY, templatePath);
    } catch {
      // Ignore storage failures; the selected template still works this session.
    }
  }

  function chooseImageAssetFolder(folder) {
    if (folder === NEW_IMAGE_ASSET_FOLDER) {
      creatingImageAssetFolder = true;
      imageAssetFolderDraft = '';
      return;
    }

    setImageAssetFolder(folder);
    creatingImageAssetFolder = false;
  }

  function setImageAssetFolder(folder) {
    imageAssetFolder = normalizeWorkspaceFolder(folder) || '/assets';
    try {
      localStorage.setItem(IMAGE_ASSET_FOLDER_KEY, imageAssetFolder);
    } catch {
      // Ignore storage failures; pasted images still use the selected folder.
    }
  }

  async function createImageAssetFolder() {
    const folder = newImageAssetFolderPath();
    if (!folder) return;

    try {
      const result = await requestJson('/api/workspace/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: selectedRoot, path: folder })
      });
      setImageAssetFolder(result.path);
      imageAssetFolderDraft = '';
      creatingImageAssetFolder = false;
      await loadTree(selectedRoot);
    } catch (err) {
      error = err.message;
    }
  }

  function newImageAssetFolderPath() {
    return imageAssetFolderDraft.trim()
      ? normalizeWorkspaceFolder(imageAssetFolderDraft)
      : '';
  }

  function readDailyNoteFolder() {
    try {
      const folder =
        localStorage.getItem(DAILY_NOTE_FOLDER_KEY) ||
        workspaceRoots
          .map((root) =>
            localStorage.getItem(`${LEGACY_DAILY_NOTE_FOLDER_PREFIX}${root.id}`)
          )
          .find((folder) => folder && folder !== '/') ||
        '';
      return {
        folder: folder || DEFAULT_DAILY_NOTE_FOLDER,
        stored: Boolean(folder)
      };
    } catch {
      return { folder: DEFAULT_DAILY_NOTE_FOLDER, stored: false };
    }
  }

  function readDailyNoteTemplatePath() {
    try {
      const templatePath = localStorage.getItem(DAILY_NOTE_TEMPLATE_KEY) || '';
      return templatePath ? normalizeMarkdownPath(templatePath) : '';
    } catch {
      return '';
    }
  }

  function reconcileDailyNoteFolder() {
    if (!dailyNoteFolderStored && !dailyNoteFolders.includes(dailyNoteFolder))
      dailyNoteFolder = '/';
  }

  function readImageAssetFolder() {
    try {
      return normalizeWorkspaceFolder(
        localStorage.getItem(IMAGE_ASSET_FOLDER_KEY) || '/assets'
      );
    } catch {
      return '/assets';
    }
  }

  function normalizeWorkspaceFolder(folder) {
    const normalized = normalizeWorkspaceFilePath(`${folder || '/assets'}/_`);
    return normalized
      ? normalized.slice(0, normalized.lastIndexOf('/')) || '/'
      : '';
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
    sidebarView = 'files';
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
      const results = await fetchWorkspaceSearch(query, root);
      if (run === searchRun && root === selectedRoot) {
        searchResults = results;
        searchStatus = results.length ? '' : 'No matches';
      }
    } catch (err) {
      if (run === searchRun && root === selectedRoot)
        searchStatus = err.message;
    }
  }

  function fetchWorkspaceSearch(query, root) {
    return requestJson(
      `/api/workspace/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`
    );
  }

  async function openSearchResult(result) {
    rememberSearch(searchQuery);
    if (result.fileKind === 'markdown') setViewMode('preview');
    await openFile(result.path);
  }

  async function openPalette() {
    paletteOpen = true;
    paletteQuery = '';
    await tick();
    paletteInput?.focus();
  }

  function closePalette() {
    clearTimeout(paletteTimer);
    paletteRun += 1;
    paletteOpen = false;
    paletteQuery = '';
    paletteResults = [];
    paletteStatus = '';
    paletteIndex = -1;
  }

  // An empty query lists the recent files, so the palette always opens onto
  // something to pick rather than an empty box.
  function queuePaletteSearch(query, root) {
    clearTimeout(paletteTimer);
    const run = ++paletteRun;

    if (!query) {
      setPaletteResults(recentPaletteResults(continueFiles), '');
      return;
    }

    paletteStatus = 'Searching...';
    paletteTimer = setTimeout(() => searchPalette(query, root, run), 150);
  }

  async function searchPalette(query, root, run) {
    try {
      const results = await fetchWorkspaceSearch(query, root);
      if (run === paletteRun && root === selectedRoot)
        setPaletteResults(results, results.length ? '' : 'No matches');
    } catch (err) {
      if (run === paletteRun && root === selectedRoot)
        setPaletteResults([], err.message);
    }
  }

  function setPaletteResults(results, status) {
    paletteResults = results;
    paletteStatus = status;
    paletteIndex = clampPaletteIndex(results.length, paletteIndex);
  }

  function movePaletteIndex(step) {
    paletteIndex = stepPaletteIndex(paletteResults.length, paletteIndex, step);
    paletteHost
      ?.querySelector(`.palette-result:nth-of-type(${paletteIndex + 1})`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  async function openPaletteResult(result) {
    if (!result) return;
    if (paletteQuery.trim()) rememberSearch(paletteQuery);
    closePalette();
    if (result.fileKind === 'markdown') setViewMode('preview');
    await openFile(result.path);
  }

  function handlePaletteKeydown(event) {
    const run = {
      ArrowDown: () => movePaletteIndex(1),
      ArrowUp: () => movePaletteIndex(-1),
      Enter: () => openPaletteResult(paletteResults[paletteIndex]),
      Escape: () => closePalette()
    }[event.key];
    if (!run) return;

    event.preventDefault();
    run();
  }

  // Which way of looking at the tasks you last chose, and which lanes you had
  // folded away. Kept apart from the section definitions so resetting sections
  // to defaults does not also reopen every lane.
  function readTaskBoard() {
    try {
      const stored = JSON.parse(localStorage.getItem(TASK_BOARD_KEY) || 'null');
      if (TASK_GROUPINGS.includes(stored?.grouping)) {
        taskGrouping = stored.grouping;
      }
      collapsedLanes = Array.isArray(stored?.collapsed)
        ? stored.collapsed.filter((key) =>
            LANES.some((lane) => lane.key === key)
          )
        : [];
    } catch {
      // A corrupt preference is not worth reporting; the defaults still apply.
    }
  }

  function commitTaskBoard() {
    try {
      localStorage.setItem(
        TASK_BOARD_KEY,
        JSON.stringify({ grouping: taskGrouping, collapsed: collapsedLanes })
      );
    } catch {
      // Ignore storage failures; the choice still holds for this session.
    }
  }

  function setTaskGrouping(grouping) {
    taskGrouping = grouping;
    commitTaskBoard();
  }

  function toggleLane(key) {
    collapsedLanes = collapsedLanes.includes(key)
      ? collapsedLanes.filter((lane) => lane !== key)
      : [...collapsedLanes, key];
    commitTaskBoard();
  }

  function focusTaskFilter() {
    taskFilterInput?.focus();
    taskFilterInput?.select();
  }

  // A tag chip narrows the view to that tag, or clears back to everything when
  // it is already the filter, so the same chip undoes itself. The card and row
  // around it open the note, which is not what a click on the chip meant.
  function filterByTag(tag, event) {
    event.stopPropagation();
    const next = `#${tag}`;
    taskFilter = taskFilter === next ? '' : next;
  }

  function readTaskSections() {
    try {
      return sanitizeSections(
        JSON.parse(localStorage.getItem(TASK_SECTIONS_KEY) || 'null')
      );
    } catch {
      return sanitizeSections(null);
    }
  }

  // Every edit runs through sanitizeSections, so the stored shape stays valid
  // however the editor is used — including keeping the catch-all last.
  function commitTaskSections(sections) {
    taskSections = sanitizeSections(sections);
    try {
      localStorage.setItem(TASK_SECTIONS_KEY, JSON.stringify(taskSections));
    } catch {
      // Ignore storage failures; the sections still apply for this session.
    }
  }

  function updateTaskSection(index, changes) {
    commitTaskSections(
      taskSections.map((section, position) =>
        position === index ? { ...section, ...changes } : section
      )
    );
  }

  function moveTaskSection(index, offset) {
    const next = [...taskSections];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commitTaskSections(next);
  }

  function removeTaskSection(index) {
    commitTaskSections(
      taskSections.filter((_, position) => position !== index)
    );
  }

  function addTaskSection() {
    commitTaskSections([
      ...taskSections.filter((section) => !section.catchAll),
      { id: `section-${taskSections.length + 1}`, label: 'New section' },
      ...taskSections.filter((section) => section.catchAll)
    ]);
  }

  function resetTaskSections() {
    commitTaskSections(DEFAULT_SECTIONS);
  }

  async function toggleCompletedTasks() {
    showCompletedTasks = !showCompletedTasks;
    await loadTasks(selectedRoot);
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
    // The editor host was display:none, so wait for setViewMode's remeasure before scrolling.
    requestAnimationFrame(() => {
      editorView.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' })
      });
      editorView.focus();
    });
  }

  /** Double-clicking rendered text opens the editor on the matching source line. */
  function handlePreviewDoubleClick(event) {
    if (!editorView || !selectedIsMarkdown) return;
    if (
      event.target.closest(
        'a, input, button, summary, .mermaid-block, .code-block-bar'
      )
    )
      return;

    const host = event.target.closest('[data-line]');
    const line = Number(host?.dataset.line);
    if (!Number.isInteger(line) || line < 0) return;

    const doc = editorView.state.doc;
    const target = doc.line(Math.min(line + 1, doc.lines));
    const word = sourceColumnForWord(
      target.text,
      window.getSelection()?.toString() ?? ''
    );
    selectEditorRange(
      target.from + (word ? word.from : 0),
      target.from + (word ? word.to : 0)
    );
  }

  function setViewMode(mode, { remember = true } = {}) {
    viewMode = mode;
    if (mode === 'preview') todayText = dailyNoteDate(new Date());
    selectedText = '';
    selectedRange = null;
    if (remember) rememberWorkspaceViewMode(mode);
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
    {:else if segment.type === 'math'}
      <span class="math-inline">{@html renderMath(segment.text)}</span>
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
    {:else if segment.type === 'wikiEmbed'}
      {@const imagePath = embeddedMediaPath(segment.target)}
      {#if imagePath}
        <img
          alt={segment.text}
          class="embedded-image"
          src={mediaUrl(imagePath)}
        />
      {:else}
        {segment.text}
      {/if}
    {:else if segment.type === 'tag'}
      <span class="tag-chip">#{segment.text}</span>
    {:else if segment.type === 'strong'}
      <strong>{segment.text}</strong>
    {:else if segment.type === 'em'}
      <em>{segment.text}</em>
    {:else}
      {segment.text}
    {/if}
  {/each}
{/snippet}

{#snippet markdownBlocks(blocks, readOnly = false)}
  {#each blocks as block}
    {#if block.type === 'frontmatter'}
      <dl class="frontmatter" data-line={block.line}>
        {#each block.fields as field}
          <div data-line={field.line}>
            <dt>{field.key}</dt>
            <dd class:frontmatter-list={field.list}>
              {#each field.values as value}
                <span>{@render inline(value)}</span>
              {/each}
            </dd>
          </div>
        {/each}
      </dl>
    {:else if block.type === 'heading'}
      <svelte:element this={`h${block.level}`} data-line={block.line}>
        {@render inline(block.children)}
      </svelte:element>
    {:else if block.type === 'paragraph'}
      <p data-line={block.line}>{@render inline(block.children)}</p>
    {:else if block.type === 'quote'}
      <blockquote data-line={block.line}>
        {@render inline(block.children)}
      </blockquote>
    {:else if block.type === 'callout'}
      <aside class={`callout callout-${block.variant}`} data-line={block.line}>
        <p class="callout-title">{@render inline(block.title)}</p>
        {#if block.children.length}
          <div class="callout-body">
            {@render markdownBlocks(block.children, readOnly)}
          </div>
        {/if}
      </aside>
    {:else if block.type === 'details'}
      <details data-line={block.line}>
        <summary>{@render inline(block.summary)}</summary>
        {@render markdownBlocks(block.children, readOnly)}
      </details>
    {:else if block.type === 'rule'}
      <hr data-line={block.line} />
    {:else if block.type === 'mermaid'}
      <div
        class="mermaid-block"
        data-line={block.line}
        data-state="loading"
        use:mermaidDiagram={block.text}
      >
        <div
          class="mermaid-canvas"
          role="img"
          aria-label="Mermaid diagram"
        ></div>
        <pre class="mermaid-source"><code>{block.text}</code></pre>
        <p class="mermaid-error"></p>
      </div>
    {:else if block.type === 'code'}
      <div class="code-block" data-line={block.line}>
        <div class="code-block-bar">
          <span class="code-block-label">
            {#if block.title}
              <span class="code-title">{block.title}</span>
            {/if}
            <span class="code-lang" class:code-lang-muted={block.title}
              >{languageLabel(block.lang)}</span
            >
          </span>
          <span class="code-copy-zone">
            {#if copiedCode === block}
              <span class="code-copy-message">Copied</span>
            {/if}
            <button
              aria-label={copiedCode === block
                ? 'Code copied to clipboard'
                : 'Copy code block'}
              title={copiedCode === block ? 'Copied to clipboard' : 'Copy code'}
              type="button"
              on:click={() => copyCodeBlock(block)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <rect x="8" y="7" width="10" height="13" rx="2" />
                <path
                  d="M6 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"
                />
              </svg>
            </button>
          </span>
        </div>
        <pre><code>{@html highlightCodeBlock(block.lang, block.text)}</code
          ></pre>
      </div>
    {:else if block.type === 'diff'}
      {#each block.files as file}
        {@render diffFile(file)}
      {/each}
    {:else if block.type === 'table'}
      <div class="table-scroll" data-line={block.line}>
        <table>
          <thead>
            <tr data-line={block.line}>
              {#each block.headers as header, column}
                <th class={`align-${block.alignments[column]}`}>
                  {@render inline(header)}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row, rowIndex}
              <tr data-line={block.rowLines[rowIndex]}>
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
      <svelte:element this={block.ordered ? 'ol' : 'ul'} data-line={block.line}>
        {#each block.items as item}
          <li
            class:task={item.task}
            class:task-done={item.task && item.checked}
            data-line={item.line}
            data-priority={item.meta?.priority || null}
          >
            {#if item.task}
              <input
                checked={item.checked}
                disabled={readOnly}
                type="checkbox"
                on:change={() => toggleTask(item.line)}
              />
            {/if}
            <!-- Column two is the sentence and everything that belongs to it:
                 tags read as words, and the done stamp and origin link trail the
                 text the way a footnote would. Long text wraps here beside the
                 checkbox rather than below it. -->
            <div class="task-body">
              <span>{@render inline(item.children)}</span>
              {#if item.meta}
                {#if item.meta.done}
                  <span class="task-stamp" title={`Done ${item.meta.done}`}>
                    {`Done ${formatDueLabel(item.meta.done)}`}
                  </span>
                {/if}
                {#if item.meta.origin}
                  <a
                    class="task-origin wiki-link"
                    href={wikiLinkHref(item.meta.origin)}
                    title={`Carried over from ${item.meta.origin}`}
                    on:click={(event) => openWikiLink(event, item.meta.origin)}
                  >
                    {`↩︎ ${item.meta.origin}`}
                  </a>
                {/if}
              {/if}
            </div>
            <!-- Column three is the rail. Priority and due date leave the
                 sentence so they line up down the page: with the pills trailing
                 the text they landed at a different x on every row, and orphaned
                 onto a line of their own whenever the text wrapped. The priority
                 slot is always emitted so the dates share one left edge. -->
            {#if item.task}
              <div class="task-meta">
                <span
                  aria-hidden={item.meta?.priority ? null : 'true'}
                  aria-label={item.meta?.priority
                    ? `${item.meta.priority} priority`
                    : null}
                  class={`task-priority task-priority-${item.meta?.priority || 'none'}`}
                  title={item.meta?.priority
                    ? `${item.meta.priority} priority`
                    : null}
                >
                  {priorityGlyph(item.meta?.priority)}
                </span>
                {#if item.meta?.due}
                  <span
                    class={`task-due task-due-${taskUrgency(item.meta.due, todayText)}`}
                    title={`Due ${item.meta.due}`}
                  >
                    {formatDueChip(item.meta.due, todayText)}
                  </span>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </svelte:element>
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

<!-- Rendered in the toolbar on a wide screen and inside the ... menu on a
     narrow one, so the control itself only exists once. -->
{#snippet assetFolderControl()}
  <div class="asset-folder-control">
    <label>
      Assets
      <select
        aria-label="Image asset folder"
        value={imageAssetFolder}
        on:change={(event) => chooseImageAssetFolder(event.currentTarget.value)}
      >
        {#each imageAssetFolderOptions as folder}
          <option value={folder}>{folder}</option>
        {/each}
        <option value={NEW_IMAGE_ASSET_FOLDER}>New folder...</option>
      </select>
    </label>
    {#if creatingImageAssetFolder}
      <form
        class="asset-folder-new"
        on:submit|preventDefault={createImageAssetFolder}
      >
        <input
          aria-label="New image asset folder"
          bind:value={imageAssetFolderDraft}
          placeholder="/assets"
        />
        <button disabled={!newImageAssetFolderPath()} type="submit">
          Create
        </button>
      </form>
    {/if}
  </div>
{/snippet}

<svelte:window
  on:keydown={handleShortcut}
  on:mousedown={handleMouseNavigation}
  on:mouseup={handleMouseNavigation}
  on:auxclick={handleMouseNavigation}
/>

<main
  bind:this={appShell}
  class:markdown-hidden={markdownViewsCollapsed}
  class:sidebar-hidden={!sidebarVisible}
  class="app-shell"
>
  <nav class="global-bar" aria-label="Global actions">
    <button
      aria-label="Open dashboard"
      class:active={!selectedPath && viewMode === 'edit'}
      class="global-action"
      disabled={!workspaceRoots.length}
      title="Dashboard"
      type="button"
      on:click={showHome}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5.5 10.5V20h13v-9.5" />
        <path d="M9.5 20v-6h5v6" />
      </svg>
    </button>
    <button
      aria-label={sidebarVisible && sidebarView === 'files'
        ? 'Hide files'
        : 'Show files'}
      aria-pressed={sidebarVisible && sidebarView === 'files'}
      class:active={sidebarVisible && sidebarView === 'files'}
      class="global-action"
      title="Files"
      type="button"
      on:click={() => toggleSidebar('files')}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 6.5h6l2 2h8v9H4z" />
        <path d="M4 9h16" />
      </svg>
    </button>
    <button
      aria-label="Open daily notes calendar"
      class:active={viewMode === 'calendar'}
      class="global-action calendar-launcher"
      disabled={!workspaceRoots.length}
      title="Daily notes calendar"
      type="button"
      on:click={() => showCalendar()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M5 5.5h14v14H5z" />
        <path d="M8 3.5v4" />
        <path d="M16 3.5v4" />
        <path d="M5 9h14" />
        <path d="M8.5 12.5h2" />
        <path d="M13.5 12.5h2" />
        <path d="M8.5 16h2" />
      </svg>
    </button>
    <button
      aria-label="Open tasks"
      class:active={viewMode === 'tasks'}
      class="global-action tasks-launcher"
      disabled={!workspaceRoots.length}
      title={`Tasks (${shortcutKey}+Shift+T)`}
      type="button"
      on:click={() => showTasks()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 7.5 6 9.5l3.5-4" />
        <path d="M4 16.5 6 18.5l3.5-4" />
        <path d="M12.5 7.5H20" />
        <path d="M12.5 16.5H20" />
      </svg>
    </button>
    <button
      aria-label={sidebarVisible && sidebarView === 'chat'
        ? 'Hide AI chat'
        : 'Show AI chat'}
      aria-pressed={sidebarVisible && sidebarView === 'chat'}
      class:active={sidebarVisible && sidebarView === 'chat'}
      class="global-action"
      title="AI chat"
      type="button"
      on:click={() => toggleSidebar('chat')}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3.5v3" />
        <path d="M12 17.5v3" />
        <path d="M4.5 12h3" />
        <path d="M16.5 12h3" />
        <path d="m6.5 6.5 2.2 2.2" />
        <path d="m15.3 15.3 2.2 2.2" />
        <path d="m17.5 6.5-2.2 2.2" />
        <path d="m8.7 15.3-2.2 2.2" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
    </button>
  </nav>

  <aside
    class:chat-open={sidebarView === 'chat'}
    class:sidebar-closed={!sidebarVisible}
    class="sidebar"
    aria-label={sidebarView === 'files' ? 'Workspace files' : 'AI chat'}
  >
    <div class="brand-row">
      <button class="brand" type="button" on:click={showHome}>WebMD</button>
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
          aria-label="Create markdown note"
          class="sync-button"
          title="Create markdown note"
          type="button"
          on:click={createMarkdownNote}
        >
          New
        </button>
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
        bind:this={searchInput}
        bind:value={searchQuery}
        name="webmd-search"
        on:blur={() => rememberSearch(searchQuery)}
        on:keydown={(event) => {
          if (event.key === 'Enter') rememberSearch(searchQuery);
        }}
        placeholder="Search or type:Playbook"
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
                : result.kind === 'metadata'
                  ? result.field
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
    <section class:ai-panel-hidden={sidebarView !== 'chat'} class="ai-panel">
      <div class="sidebar-title ai-title">
        <span>AI chat</span>
        <div class="sidebar-title-actions">
          <button
            aria-pressed={markdownViewsHidden}
            class="sync-button"
            title={markdownViewsHidden
              ? 'Show the Markdown views'
              : 'Hide the Markdown views and widen this panel'}
            type="button"
            on:click={() => (markdownViewsHidden = !markdownViewsHidden)}
          >
            {markdownViewsHidden ? 'Show Markdown' : 'Hide Markdown'}
          </button>
        </div>
      </div>
      <div class="ai-messages" aria-live="polite" bind:this={chatScrollHost}>
        {#if chatMessages.length}
          {#each chatMessages as message}
            <article class={`ai-message ai-message-${message.role}`}>
              <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
              <div class="ai-bubble">
                {#if !message.text && chatStreaming}
                  <span aria-hidden="true" class="ai-typing"
                    ><span></span><span></span><span></span></span
                  >
                {:else}
                  <p>{message.text}</p>
                {/if}
              </div>
            </article>
          {/each}
        {:else}
          <p class="empty-copy">Ask about the current note or selection.</p>
        {/if}
      </div>
      <form class="ai-form" on:submit|preventDefault={sendChat}>
        <div class="ai-connect">
          <button
            class="ai-connect-button"
            disabled={relatedLoading || !selectedIsMarkdown}
            title={selectedIsMarkdown
              ? 'Suggest existing notes to link this note to'
              : 'Open a Markdown note first'}
            type="button"
            on:click={requestRelatedNotes}
          >
            {relatedLoading ? 'Connecting...' : 'Connect notes'}
          </button>
          {#if relatedStatus}
            <span class="ai-connect-status">{relatedStatus}</span>
          {/if}
        </div>
        {#if presetGroups.length}
          <div class="ai-preset">
            <span class="ai-preset-label" id="ai-preset-heading">Prompts</span>
            <div class="ai-preset-picker">
              <div
                aria-labelledby="ai-preset-heading"
                class="ai-preset-groups"
                role="tablist"
              >
                {#each presetGroups as group}
                  <button
                    aria-controls="ai-preset-items"
                    aria-selected={group.name === activePresetGroup}
                    class="ai-preset-group"
                    class:active={group.name === activePresetGroup}
                    id={presetGroupId(group.name)}
                    role="tab"
                    type="button"
                    on:click={() => (activePresetGroup = group.name)}
                  >
                    {group.name}
                  </button>
                {/each}
              </div>
              <div
                aria-labelledby={presetGroupId(activePresetGroup)}
                class="ai-preset-items"
                id="ai-preset-items"
                role="tabpanel"
              >
                {#each activePresets as preset}
                  <button
                    class="ai-preset-chip"
                    class:chat={preset.kind === 'chat'}
                    disabled={presetDisabled(preset)}
                    title={presetTitle(preset)}
                    type="button"
                    on:click={() => runPreset(preset)}
                  >
                    {preset.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
        {#if aiPresetWarning}
          <p class="ai-preset-warning">{aiPresetWarning}</p>
        {/if}
        <textarea
          aria-label="Ask AI"
          bind:value={chatPrompt}
          disabled={chatStreaming || inlineEditLoading}
          placeholder={selectedText
            ? 'Ask about the selection'
            : 'Ask about this note'}
          rows="2"
        ></textarea>
        <div class="ai-form-actions">
          <button
            aria-label="Preview edit for selected text"
            class="ai-icon-button"
            disabled={!chatPrompt.trim() ||
              chatStreaming ||
              inlineEditLoading ||
              !canInlineEdit}
            title={canInlineEdit
              ? 'Preview edit for selected text'
              : 'Select text in the editor'}
            type="button"
            on:click={() => requestInlineEdit()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path
                d="M4 20.5 4.8 16.2 15.8 5.2a1.8 1.8 0 0 1 2.5 0l1.5 1.5a1.8 1.8 0 0 1 0 2.5L8.8 19.7z"
              />
              <path d="m14 7 3 3" />
            </svg>
          </button>
          <button
            aria-label="Send"
            class="ai-send-button"
            disabled={!chatPrompt.trim() || chatStreaming || inlineEditLoading}
            title="Send"
            type="submit"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 12 20 4l-6 16-3-7-7-1z" />
            </svg>
          </button>
        </div>
      </form>
      {#if chatStatus || inlineEditStatus}
        <p class="ai-status">{chatStatus || inlineEditStatus}</p>
      {/if}
    </section>
  </aside>

  <section class="workspace">
    <header class="topbar">
      <div class="file-heading">
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
          {viewMode === 'calendar'
            ? 'Daily Notes'
            : selectedPath || 'Workspace Home'}
        </button>
      </div>
      <div class="topbar-actions">
        {#if !narrowLayout}
          {@render assetFolderControl()}
        {/if}
        <input
          bind:this={uploadInput}
          class="hidden"
          type="file"
          accept="image/*,application/pdf,.pdf"
          multiple
          on:change={chooseUploadFiles}
        />
        <div class="day-step" aria-label="Daily notes">
          <button
            aria-label="Open the previous daily note"
            disabled={!olderDailyNotePath}
            title={olderDailyNotePath
              ? `Older daily note (${olderDailyNotePath})`
              : 'No older daily note'}
            type="button"
            on:click={openOlderDailyNote}
          >
            ‹
          </button>
          <button
            aria-label="Open the next daily note"
            disabled={!newerDailyNotePath}
            title={newerDailyNotePath
              ? `Newer daily note (${newerDailyNotePath})`
              : 'No newer daily note'}
            type="button"
            on:click={openNewerDailyNote}
          >
            ›
          </button>
        </div>
        {#if !narrowLayout}
          <button
            class="upload-button"
            disabled={!workspaceRoots.length}
            type="button"
            on:click={() => uploadInput?.click()}
          >
            Upload
          </button>
          <button
            class="delete-button"
            disabled={!selectedPath}
            type="button"
            on:click={deleteSelectedFile}
          >
            Delete
          </button>
          <button
            aria-pressed={referenceOpen}
            class:active={referenceOpen}
            class="reference-button"
            disabled={!markdownFiles.length}
            title={`Reference note (${shortcutKey}+Shift+\\)`}
            type="button"
            on:click={toggleReferencePane}
          >
            Reference
          </button>
        {/if}
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
        </div>
        <div class="view-menu">
          <button
            aria-expanded={viewMenuOpen}
            aria-haspopup="menu"
            aria-label="More views"
            class:active={viewMode === 'diff' || viewMode === 'graph'}
            class="view-menu-button"
            title="More views"
            type="button"
            on:click={() => (viewMenuOpen = !viewMenuOpen)}
            on:keydown={closeViewMenuOnEscape}
          >
            <span aria-hidden="true">•••</span>
          </button>
          {#if viewMenuOpen}
            <button
              aria-label="Close more views"
              class="view-menu-backdrop"
              type="button"
              on:click={closeViewMenu}
            ></button>
            <div
              class="view-menu-list"
              role="menu"
              tabindex="-1"
              on:keydown={closeViewMenuOnEscape}
            >
              <button
                class:active={viewMode === 'diff' && selectedIsMarkdown}
                disabled={!selectedPath || !selectedIsMarkdown}
                role="menuitem"
                type="button"
                on:click={chooseDiffView}
              >
                Diff
              </button>
              <button
                class:active={viewMode === 'graph'}
                disabled={!workspaceRoots.length}
                role="menuitem"
                type="button"
                on:click={chooseGraphView}
              >
                Graph
              </button>
              <button role="menuitem" type="button" on:click={openMarkdownHelp}>
                Markdown help
              </button>
              {#if narrowLayout}
                <hr class="view-menu-divider" />
                <button
                  disabled={!workspaceRoots.length}
                  role="menuitem"
                  type="button"
                  on:click={chooseUpload}
                >
                  Upload
                </button>
                <button
                  disabled={!selectedPath}
                  role="menuitem"
                  type="button"
                  on:click={chooseDelete}
                >
                  Delete
                </button>
                <button
                  aria-pressed={referenceOpen}
                  class:active={referenceOpen}
                  disabled={!markdownFiles.length}
                  role="menuitem"
                  type="button"
                  on:click={chooseReferencePane}
                >
                  Reference
                </button>
                {@render assetFolderControl()}
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </header>

    {#if paletteOpen}
      <div class="palette-layer">
        <button
          aria-label="Close quick open"
          class="palette-backdrop"
          type="button"
          on:click={closePalette}
        ></button>
        <dialog aria-label="Quick open" class="palette" open>
          <input
            bind:this={paletteInput}
            bind:value={paletteQuery}
            aria-label="Search files"
            placeholder="Search files and notes"
            type="search"
            on:keydown={handlePaletteKeydown}
          />
          <div
            bind:this={paletteHost}
            class="palette-results"
            aria-live="polite"
          >
            {#each paletteResults as result, index}
              <button
                class:active={index === paletteIndex}
                class="palette-result"
                type="button"
                on:click={() => openPaletteResult(result)}
                on:mouseenter={() => (paletteIndex = index)}
              >
                <span>{result.name}</span>
                <small>{paletteResultLabel(result)}</small>
                {#if result.preview}
                  <em>{result.preview}</em>
                {/if}
              </button>
            {/each}
            {#if paletteStatus}
              <p class="empty-copy">{paletteStatus}</p>
            {:else if !paletteResults.length}
              <p class="empty-copy">Type to search the workspace.</p>
            {/if}
          </div>
          <footer>
            <span>Up/Down to move</span>
            <span>Enter to open</span>
            <span>Esc to close</span>
          </footer>
        </dialog>
      </div>
    {/if}

    {#if markdownHelpOpen}
      <div class="markdown-help-layer">
        <button
          aria-label="Close Markdown help"
          class="markdown-help-backdrop"
          type="button"
          on:click={() => (markdownHelpOpen = false)}
        ></button>
        <dialog aria-label="Markdown help" class="markdown-help" open>
          <header>
            <h2>Markdown help</h2>
            <button
              aria-label="Close Markdown help"
              title="Close"
              type="button"
              on:click={() => (markdownHelpOpen = false)}
            >
              x
            </button>
          </header>
          <dl>
            <div>
              <dt>Callouts</dt>
              <dd>
                <code>&gt; [!note]</code>
                <code>&gt; [!tldr]</code>
                <code>&gt; [!code]</code>
                <code>&gt; [!deadline]</code>
                <code>&gt; [!info]</code>
                <code>&gt; [!idea]</code>
                <code>&gt; [!warning]</code>
                <code>&gt; [!error]</code>
                <code>&gt; [!prompt]</code>
              </dd>
            </div>
            <div>
              <dt>Code block</dt>
              <dd>
                <code>```js</code> <code>console.log("ok")</code>
                <code>```</code>
              </dd>
            </div>
            <div>
              <dt>Wiki links</dt>
              <dd>
                <code>[[Project note]]</code> <code>![[diagram.png]]</code>
              </dd>
            </div>
            <div>
              <dt>Task list</dt>
              <dd><code>- [ ] Follow up</code> <code>- [x] Done</code></dd>
            </div>
            <div>
              <dt>Task dates</dt>
              <dd>
                <code>- [ ] Ship it 📅 2026-08-20 ⏫</code>
                <code>✅ set on tick</code>
              </dd>
            </div>
            <div>
              <dt>Task shorthand</dt>
              <dd>
                <code>due:2026-08-20</code>
                <code>due:today</code>
                <code>due:tomorrow</code>
                <code>due:friday</code>
                <code>due:+3d</code>
                <code>due:+2w</code>
                <code>created:</code>
                <code>done:</code>
                <code>:p1:</code>…<code>:p5:</code>
                becomes the emoji when you leave the line
              </dd>
            </div>
            <div>
              <dt>Table</dt>
              <dd><code>| Name | Notes |</code> <code>| --- | --- |</code></dd>
            </div>
            <div>
              <dt>Math</dt>
              <dd><code>$E = mc^2$</code></dd>
            </div>
            <div>
              <dt>Frontmatter</dt>
              <dd>
                <code>title</code>
                <code>description</code>
                <code>resource</code>
                <code>tags</code>
                <code>timestamp</code>
              </dd>
            </div>
            <div>
              <dt>Shortcuts</dt>
              <dd>
                <code>{shortcutKey}+Shift+E</code> edit
                <code>{shortcutKey}+Shift+P</code> preview
                <code>{shortcutKey}+Shift+\</code> reference note
                <code>{shortcutKey}+Shift+&lt;</code> older day
                <code>{shortcutKey}+Shift+&gt;</code> newer day
                <code>Double-click</code> edit previewed text
              </dd>
            </div>
          </dl>
        </dialog>
      </div>
    {/if}

    {#if error}
      <div class="error-banner" role="alert">{error}</div>
    {/if}

    <div class:split={referenceOpen} class="editor-split">
      <div class:empty={!selectedPath} class="editor-frame">
        {#if !selectedPath && !workspacePaneOpen}
          <section class="workspace-home" aria-label="Workspace Home">
            <header class="home-intro">
              <div>
                <p class="home-eyebrow">{activeWorkspaceName}</p>
                <h1>Workspace Home</h1>
                <p>Capture, resume, and review your research.</p>
              </div>
              <div class="home-counts" aria-label="Workspace file counts">
                <strong>{overview.markdownCount}</strong>
                <span>notes</span>
                <strong>{overview.fileCount}</strong>
                <span>files</span>
              </div>
            </header>

            {#if overviewStatus}
              <p class="home-status">{overviewStatus}</p>
            {/if}

            <div class="home-grid">
              <article class="home-card home-today">
                <p class="home-card-label">Capture</p>
                <h2>Today</h2>
                <p>Start or continue today’s research note.</p>
                <small>{todayNotePath()}</small>
                <button
                  class="home-primary"
                  type="button"
                  on:click={() => openDailyNote()}
                >
                  Open today’s note
                </button>
              </article>

              <article class="home-card">
                <div class="home-card-heading">
                  <div>
                    <p class="home-card-label">Resume</p>
                    <h2>Continue</h2>
                  </div>
                  <button
                    class="home-link"
                    title={`Quick open (${shortcutKey}+K)`}
                    type="button"
                    on:click={openPalette}
                  >
                    Find
                  </button>
                </div>
                {#if continueFiles.length}
                  <div class="home-list">
                    {#each continueFiles as file}
                      <button
                        type="button"
                        on:click={() => openFile(file.path)}
                      >
                        <span>{file.name}</span>
                        <small>{file.path}</small>
                      </button>
                    {/each}
                  </div>
                {:else}
                  <p class="home-empty">
                    Open a note and it will stay within reach here.
                  </p>
                {/if}
              </article>
            </div>
          </section>
        {/if}
        <div
          bind:this={editorHost}
          class:hidden={!selectedIsMarkdown || viewMode !== 'edit'}
          class="editor-host"
        ></div>
        {#if viewMode === 'tasks'}
          <section class="tasks-pane" aria-label="Workspace tasks">
            <header class="tasks-toolbar">
              <h2>Tasks</h2>
              <div class="tasks-summary">
                <span>
                  {openTaskCount} open{showCompletedTasks
                    ? `, ${doneTaskCount} done`
                    : ''}{hiddenTaskCount
                    ? ` · ${hiddenTaskCount} filtered out`
                    : ''}
                </span>
                <input
                  class="tasks-filter"
                  type="search"
                  placeholder="Filter  /"
                  aria-label="Filter tasks"
                  bind:this={taskFilterInput}
                  bind:value={taskFilter}
                  on:keydown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    if (taskFilter) taskFilter = '';
                    else event.currentTarget.blur();
                  }}
                />
                <div
                  class="tasks-grouping"
                  role="group"
                  aria-label="Group tasks by"
                >
                  <button
                    type="button"
                    class:active={taskGrouping === 'board'}
                    aria-pressed={taskGrouping === 'board'}
                    on:click={() => setTaskGrouping('board')}
                  >
                    Board
                  </button>
                  <button
                    type="button"
                    class:active={taskGrouping === 'sections'}
                    aria-pressed={taskGrouping === 'sections'}
                    on:click={() => setTaskGrouping('sections')}
                  >
                    Sections
                  </button>
                  <button
                    type="button"
                    class:active={taskGrouping === 'urgency'}
                    aria-pressed={taskGrouping === 'urgency'}
                    on:click={() => setTaskGrouping('urgency')}
                  >
                    Urgency
                  </button>
                </div>
                <label class="tasks-toggle">
                  <input
                    type="checkbox"
                    checked={showCompletedTasks}
                    on:change={toggleCompletedTasks}
                  />
                  Completed
                </label>
                {#if taskGrouping !== 'urgency'}
                  <button
                    type="button"
                    aria-expanded={editingSections}
                    on:click={() => (editingSections = !editingSections)}
                  >
                    {editingSections ? 'Done' : 'Edit sections'}
                  </button>
                {/if}
                <button type="button" on:click={() => loadTasks(selectedRoot)}>
                  Refresh
                </button>
              </div>
            </header>
            {#if tasksStatus}
              <p class="tasks-note">{tasksStatus}</p>
            {/if}
            {#if editingSections && taskGrouping !== 'urgency'}
              <div class="task-sections-editor">
                <p class="tasks-note">
                  A task joins the first section whose terms it matches. Terms
                  match its inline <code>#tags</code>, its note's frontmatter
                  <code>tags:</code>, and the headings it sits under.
                </p>
                {#each taskSections as section, index (section.id)}
                  <div class="task-section-edit">
                    <input
                      class="task-section-label"
                      aria-label="Section name"
                      value={section.label}
                      on:change={(event) =>
                        updateTaskSection(index, {
                          label:
                            event.currentTarget.value.trim() || section.label
                        })}
                    />
                    {#if section.catchAll}
                      <span class="task-section-hint">everything else</span>
                    {:else}
                      <input
                        aria-label="Include terms"
                        placeholder="include: paper, idea"
                        value={formatTermList(section.include)}
                        on:change={(event) =>
                          updateTaskSection(index, {
                            include: parseTermList(event.currentTarget.value)
                          })}
                      />
                    {/if}
                    <input
                      aria-label="Exclude terms"
                      placeholder="exclude:"
                      value={formatTermList(section.exclude)}
                      on:change={(event) =>
                        updateTaskSection(index, {
                          exclude: parseTermList(event.currentTarget.value)
                        })}
                    />
                    <select
                      aria-label="Which tasks"
                      value={section.status}
                      on:change={(event) =>
                        updateTaskSection(index, {
                          status: event.currentTarget.value
                        })}
                    >
                      {#each SECTION_STATUSES as status}
                        <option value={status}>{status}</option>
                      {/each}
                    </select>
                    {#if !section.catchAll}
                      <label
                        class="task-section-shelf"
                        title="Reading, not work: keep this section out of the board's urgency lanes"
                      >
                        <input
                          type="checkbox"
                          checked={section.shelf}
                          on:change={(event) =>
                            updateTaskSection(index, {
                              shelf: event.currentTarget.checked
                            })}
                        />
                        Shelf
                      </label>
                    {/if}
                    <button
                      type="button"
                      title="Move up"
                      disabled={index === 0}
                      on:click={() => moveTaskSection(index, -1)}>↑</button
                    >
                    <button
                      type="button"
                      title="Move down"
                      disabled={index === taskSections.length - 1}
                      on:click={() => moveTaskSection(index, 1)}>↓</button
                    >
                    <button
                      type="button"
                      title="Remove section"
                      on:click={() => removeTaskSection(index)}>✕</button
                    >
                  </div>
                {/each}
                <div class="task-sections-actions">
                  <button type="button" on:click={addTaskSection}>
                    Add section
                  </button>
                  <button type="button" on:click={resetTaskSections}>
                    Reset to defaults
                  </button>
                </div>
              </div>
            {/if}
            {#if taskGrouping === 'board'}
              <div class="task-board">
                {#each taskBoard as lane (lane.key)}
                  {@const folded = collapsedLanes.includes(lane.key)}
                  <section
                    class={`task-lane task-lane-${lane.key}`}
                    class:task-lane-folded={folded}
                  >
                    <button
                      type="button"
                      class="task-lane-head"
                      aria-expanded={!folded}
                      title={lane.note}
                      on:click={() => toggleLane(lane.key)}
                    >
                      <span class="task-lane-name">{lane.label}</span>
                      <span class="task-lane-count">{lane.count}</span>
                    </button>
                    {#if !folded}
                      {#if lane.cards.length}
                        <ul class="task-lane-cards">
                          {#each lane.cards as card (`${card.task.path}:${card.task.line}`)}
                            <li>
                              <!-- A div rather than a button: the text can
                                 contain links, and an anchor inside a button is
                                 invalid. -->
                              <div
                                class={`task-card task-card-${card.age || 'undated'}`}
                                class:task-card-done={card.task.checked}
                                title={`${card.task.path}:${card.task.line + 1}`}
                                role="button"
                                tabindex="0"
                                on:click={(event) => openTask(card.task, event)}
                                on:keydown={(event) =>
                                  openTaskOnKey(card.task, event)}
                              >
                                <p class="task-card-eyebrow">
                                  <span>{card.sectionLabel}</span>
                                  {#if card.projectLabel}
                                    <span class="task-card-project">
                                      {card.projectLabel}
                                    </span>
                                  {/if}
                                </p>
                                <p class="task-card-text">
                                  {#each taskLinkSegments(card.task.displayText || card.task.text) as segment}
                                    {#if segment.type === 'link'}
                                      <a
                                        href={segment.href}
                                        rel="noreferrer"
                                        target="_blank">{segment.text}</a
                                      >
                                    {:else}
                                      {segment.text}
                                    {/if}
                                  {/each}
                                </p>
                                <p class="task-card-meta">
                                  {#if card.task.priority}
                                    <span
                                      aria-label={`${card.task.priority} priority`}
                                      class={`task-priority task-priority-${card.task.priority}`}
                                      title={`${card.task.priority} priority`}
                                    >
                                      {priorityGlyph(card.task.priority)}
                                    </span>
                                  {/if}
                                  {#if card.task.due}
                                    <span
                                      class={`task-due task-due-${taskUrgency(card.task.due, todayText)}`}
                                      title={`Due ${card.task.due}`}
                                    >
                                      {formatDueChip(card.task.due, todayText)}
                                    </span>
                                  {/if}
                                  {#each card.task.tags || [] as tag}
                                    <button
                                      class="task-tag"
                                      class:task-tag-active={taskFilter ===
                                        `#${tag}`}
                                      title={`Filter by #${tag}`}
                                      type="button"
                                      on:click={(event) =>
                                        filterByTag(tag, event)}
                                    >
                                      #{tag}
                                    </button>
                                  {/each}
                                  {#if card.ageDays !== null}
                                    <span class="task-card-age">
                                      {card.ageDays === 0
                                        ? 'today'
                                        : `${card.ageDays}d`}
                                    </span>
                                  {/if}
                                </p>
                              </div>
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <p class="task-lane-empty">{lane.note}</p>
                      {/if}
                    {/if}
                  </section>
                {/each}
              </div>
            {:else if taskPanes.length}
              {#each taskPanes as pane (pane.id)}
                <details
                  class={`task-group task-group-${pane.id}`}
                  open={pane.count > 0}
                >
                  <summary>{pane.label} <span>{pane.count}</span></summary>
                  {#each pane.groups as group (group.key)}
                    {#if group.label}
                      <h4 class="task-source" title={group.label}>
                        {group.label}
                      </h4>
                    {/if}
                    <ul>
                      {#each group.tasks as task}
                        <li>
                          <!-- A div rather than a button: the text can contain
                             links, and an anchor inside a button is invalid. -->
                          <div
                            class="task-row"
                            class:task-row-done={task.checked}
                            title={`${task.path}:${task.line + 1}`}
                            role="button"
                            tabindex="0"
                            on:click={(event) => openTask(task, event)}
                            on:keydown={(event) => openTaskOnKey(task, event)}
                          >
                            {#if task.priority}
                              <span
                                aria-label={`${task.priority} priority`}
                                class={`task-priority task-priority-${task.priority}`}
                                title={`${task.priority} priority`}
                              >
                                {priorityGlyph(task.priority)}
                              </span>
                            {/if}
                            <span class="task-row-text">
                              {#each taskLinkSegments(task.displayText || task.text) as segment}
                                {#if segment.type === 'link'}
                                  <a
                                    href={segment.href}
                                    rel="noreferrer"
                                    target="_blank">{segment.text}</a
                                  >
                                {:else}
                                  {segment.text}
                                {/if}
                              {/each}
                            </span>
                            {#each task.tags || [] as tag}
                              <button
                                class="task-tag"
                                class:task-tag-active={taskFilter === `#${tag}`}
                                title={`Filter by #${tag}`}
                                type="button"
                                on:click={(event) => filterByTag(tag, event)}
                              >
                                #{tag}
                              </button>
                            {/each}
                            {#if task.due}
                              <span
                                class={`task-due task-due-${taskUrgency(task.due, todayText)}`}
                                title={`Due ${task.due}`}
                              >
                                {formatDueChip(task.due, todayText)}
                              </span>
                            {/if}
                            {#if group.kind !== 'file'}
                              <span class="task-row-path">{task.path}</span>
                            {/if}
                          </div>
                        </li>
                      {/each}
                    </ul>
                  {/each}
                  {#if !pane.count}
                    <p class="tasks-note">Nothing here yet.</p>
                  {/if}
                </details>
              {/each}
            {:else if !tasksStatus}
              <p class="preview-empty">
                No open tasks. Write <code>- [ ] something</code> in a note to start
                one.
              </p>
            {/if}
          </section>
        {/if}
        {#if viewMode === 'calendar'}
          <section class="calendar-pane" aria-label="Daily notes calendar">
            <header class="calendar-toolbar">
              <div class="calendar-month-nav">
                <button
                  aria-label="Previous month"
                  type="button"
                  on:click={() => moveCalendarMonth(-1)}
                >
                  ‹
                </button>
                <h2>{calendarMonthName}</h2>
                <button
                  aria-label="Next month"
                  type="button"
                  on:click={() => moveCalendarMonth(1)}
                >
                  ›
                </button>
              </div>
              <div class="calendar-controls">
                <label>
                  Folder
                  <select
                    aria-label="Daily notes folder"
                    value={dailyNoteFolder}
                    on:change={(event) =>
                      chooseDailyNoteFolder(event.currentTarget.value)}
                  >
                    {#each dailyNoteFolderOptions as folder}
                      <option
                        value={folder}
                        disabled={folder === dailyNoteFolder &&
                          dailyNoteFolderMissing}
                      >
                        {folder}{folder === dailyNoteFolder &&
                        dailyNoteFolderMissing
                          ? ' (missing here)'
                          : ''}
                      </option>
                    {/each}
                  </select>
                </label>
                <label>
                  Template
                  <select
                    aria-label="Daily note template"
                    value={dailyNoteTemplatePath}
                    on:change={(event) =>
                      chooseDailyNoteTemplate(event.currentTarget.value)}
                  >
                    <option value="">None</option>
                    {#if dailyNoteTemplateMissing}
                      <option value={dailyNoteTemplatePath} disabled>
                        {dailyNoteTemplatePath} (missing)
                      </option>
                    {/if}
                    {#each markdownFiles as file}
                      <option value={file.path}>{file.path}</option>
                    {/each}
                  </select>
                </label>
                <button type="button" on:click={showCurrentMonth}>Today</button>
              </div>
              {#if dailyNoteFolderMissing}
                <p class="calendar-folder-warning">
                  Using / because {dailyNoteFolder} is not in this connection.
                </p>
              {/if}
            </header>
            <div class="calendar-grid" aria-label={calendarMonthName}>
              {#each WEEK_DAYS as weekday}
                <span class="calendar-weekday">{weekday}</span>
              {/each}
              {#each calendarDays as day}
                {@const path = calendarDayPath(day)}
                {@const hasNote = dailyNotePaths.has(path)}
                <button
                  aria-label={`${hasNote ? 'Open' : 'Create'} note for ${calendarDayLabel(day)}`}
                  class:outside-month={!day.currentMonth}
                  class:today={day.today}
                  class:has-note={hasNote}
                  class="calendar-day"
                  title={`${hasNote ? 'Open' : 'Create'} ${path}`}
                  type="button"
                  on:click={() => openDailyNote(day.date)}
                >
                  <span>{day.date.getDate()}</span>
                  {#if hasNote}<i aria-label="Note exists"></i>{/if}
                </button>
              {/each}
            </div>
          </section>
        {/if}
        {#if viewMode === 'graph'}
          <section class="graph-pane" aria-label="Workspace graph">
            <header class="graph-toolbar">
              <div>
                <strong>Knowledge graph</strong>
                <span
                  >{graphView.nodes.length} notes · {graphView.edges.length} links</span
                >
              </div>
              <div class="graph-controls">
                <label>
                  Scope
                  <select value={graphScope} on:change={chooseGraphScope}>
                    <option value="wiki">Wiki</option>
                    <option
                      value="local"
                      disabled={!selectedPath || !selectedIsMarkdown}
                      >Local</option
                    >
                    <option value="all">All notes</option>
                  </select>
                </label>
                <button type="button" on:click={resetGraphViewport}
                  >Reset view</button
                >
              </div>
            </header>
            <div class="graph-canvas">
              {#if graphStatus}
                <p class="graph-empty">{graphStatus}</p>
              {:else if !graphView.nodes.length}
                <p class="graph-empty">No notes in this graph scope.</p>
              {:else}
                <svg
                  bind:this={graphSvg}
                  aria-label="Interactive note graph"
                  role="img"
                  viewBox={`${graphViewport.x} ${graphViewport.y} ${graphViewport.width} ${graphViewport.height}`}
                  on:pointerdown={startGraphPan}
                  on:pointermove={moveGraphPointer}
                  on:pointerup={endGraphPointer}
                  on:pointercancel={endGraphPointer}
                  on:wheel|preventDefault={zoomGraph}
                >
                  <rect
                    class="graph-background"
                    x="-5000"
                    y="-5000"
                    width="10000"
                    height="10000"
                  />
                  <g class="graph-edges">
                    {#each graphView.edges as edge}
                      <line
                        class:active={graphEdgeState(edge) === 'active'}
                        class:dimmed={graphEdgeState(edge) === 'dimmed'}
                        x1={edge.source.x}
                        y1={edge.source.y}
                        x2={edge.target.x}
                        y2={edge.target.y}
                      />
                    {/each}
                  </g>
                  <g class="graph-nodes">
                    {#each graphView.nodes as node}
                      <g
                        aria-label={node.path}
                        class:connected={hoveredGraphPath === node.path}
                        class={`graph-node graph-node-${node.group}`}
                        role="link"
                        tabindex="0"
                        transform={`translate(${node.x} ${node.y})`}
                        on:keydown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openGraphNode(node);
                          }
                        }}
                        on:mouseenter={() => (hoveredGraphPath = node.path)}
                        on:mouseleave={() => (hoveredGraphPath = '')}
                        on:pointerdown|stopPropagation={() => {}}
                        on:pointerup|stopPropagation={() => openGraphNode(node)}
                      >
                        <circle r={node.radius} />
                        {#if node.degree >= 20 || hoveredGraphPath === node.path || node.path === selectedPath}
                          <text x={node.radius + 5} y="4">{node.name}</text>
                        {/if}
                        <title>{node.path}</title>
                      </g>
                    {/each}
                  </g>
                </svg>
              {/if}
            </div>
            {#if graphData.unresolved}
              <footer>
                {graphData.unresolved} unresolved wiki-link mentions are not drawn.
              </footer>
            {/if}
          </section>
        {/if}
        {#if selectedPath && selectedIsMarkdown}
          <article
            aria-label="Rendered Markdown preview"
            class:hidden={viewMode !== 'preview'}
            class="preview-pane"
            on:dblclick={handlePreviewDoubleClick}
          >
            {#if noteProgress.total}
              <div
                aria-label={`${noteProgress.done} of ${noteProgress.total} tasks done`}
                class="task-progress"
              >
                <div class="task-progress-track">
                  <div
                    class="task-progress-fill"
                    style={`width: ${Math.round((noteProgress.done / noteProgress.total) * 100)}%`}
                  ></div>
                </div>
                <span>{noteProgress.done}/{noteProgress.total} done</span>
              </div>
            {/if}
            {#if renderedBlocks.length}
              {@render markdownBlocks(renderedBlocks)}
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
        {:else if selectedPath && !workspacePaneOpen}
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
                <button type="button" on:click={rejectInlineEdit}>
                  {inlineEditPreview.streaming ? 'Cancel' : 'Reject'}
                </button>
                <button
                  class="primary"
                  disabled={inlineEditPreview.streaming}
                  type="button"
                  on:click={acceptInlineEdit}
                >
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
        {#if relatedPanel && relatedPanel.root === selectedRoot && relatedPanel.path === selectedPath}
          <section class="inline-edit-panel" aria-label="Related notes">
            <header class="inline-edit-header">
              <strong>Related notes</strong>
              <div class="inline-edit-actions">
                <button type="button" on:click={dismissRelatedLinks}>
                  Dismiss
                </button>
                <button
                  class="primary"
                  disabled={!relatedPanel.selected.size}
                  type="button"
                  on:click={applyRelatedLinks}
                >
                  Insert links
                </button>
              </div>
            </header>
            <div class="related-body">
              {#if relatedPanel.warning}
                <p class="ai-preset-warning">{relatedPanel.warning}</p>
              {/if}
              {#if relatedPanel.suggestions.length}
                <ul class="related-list">
                  {#each relatedPanel.suggestions as suggestion}
                    <li class="related-item">
                      <label class="related-choice">
                        <input
                          checked={relatedPanel.selected.has(suggestion.path)}
                          type="checkbox"
                          on:change={() => toggleRelatedSuggestion(suggestion)}
                        />
                        <span class="related-bullet"
                          >{relatedBulletText(suggestion)}</span
                        >
                      </label>
                      <span class="related-path">{suggestion.path}</span>
                    </li>
                  {/each}
                </ul>
                <p class="related-note">
                  Appended to a <code>## Related</code> section at the end of this
                  note. No other file is changed.
                </p>
              {:else}
                <p class="empty-copy">
                  Nothing in this workspace looked related enough to link.
                </p>
              {/if}
            </div>
          </section>
        {/if}
      </div>

      {#if referenceOpen}
        <aside class="reference-pane" aria-label="Reference note">
          <header class="reference-toolbar">
            <div class="reference-step">
              <button
                aria-label="Older reference note"
                disabled={!olderReferencePath}
                title="Older note"
                type="button"
                on:click={() => stepReferenceNote(-1)}
              >
                ‹
              </button>
              <button
                aria-label="Newer reference note"
                disabled={!newerReferencePath}
                title="Newer note"
                type="button"
                on:click={() => stepReferenceNote(1)}
              >
                ›
              </button>
            </div>
            <select
              aria-label="Reference note"
              value={referencePath}
              on:change={chooseReferencePath}
            >
              {#if !referencePath}
                <option value="">No note</option>
              {/if}
              {#each markdownFiles as file}
                <option value={file.path}>{file.path}</option>
              {/each}
            </select>
            <button
              aria-label="Close reference note"
              class="reference-close"
              title="Close reference note"
              type="button"
              on:click={closeReferencePane}
            >
              x
            </button>
          </header>
          <article class="preview-pane reference-body">
            {#if referenceStatus}
              <p class="preview-empty">{referenceStatus}</p>
            {:else if referenceBlocks.length}
              {@render markdownBlocks(referenceBlocks, true)}
            {:else}
              <p class="preview-empty">Empty file</p>
            {/if}
          </article>
        </aside>
      {/if}
    </div>

    <footer class="statusbar">
      <span class={statusClass}>{status}</span>
      <span>Selected text: {selectedText.length}</span>
    </footer>
  </section>
</main>
