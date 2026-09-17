<script>
  import { indentWithTab, isolateHistory } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { yamlFrontmatter } from '@codemirror/lang-yaml';
  import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
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
    defaultDailyNoteTemplatePath,
    defaultReferencePath,
    eventsByDay,
    eventTimeRange,
    linkParts,
    meetingNoteSection,
    shiftMonth,
    stepDailyNote,
    templateNeedsQuote
  } from './calendar.js';
  import {
    rebaseRemoteUpdate,
    changesBetween,
    updateFromChangeSet as createCollabUpdate
  } from './collab.js';
  import { buildReplacementDiffFile, parseUnifiedDiff } from './diff.js';
  import { ICONS } from './icons.js';
  import MeetingsView from './MeetingsView.svelte';
  import {
    LAYOUT_KEY,
    RAIL_WIDTH,
    WIDTH_LIMITS,
    clampPanelWidth,
    closePanel,
    keyboardWidth,
    readLayoutPrefs,
    resolveLayout,
    serializeLayoutPrefs,
    togglePanel
  } from './layout.js';
  import { chatContext } from './ai-context.js';
  import { saveStatusView } from './save-status.js';
  import {
    arxivCitation,
    indicoLabel,
    indicoReference,
    xPostLabel,
    xPostReference,
    mathPasteText,
    quotedBlockPaste,
    shortLinkPaste,
    sourceColumnForWord,
    tidyPasteText
  } from './editor.js';
  import {
    citationArxiv,
    citationAuthors,
    citationCard,
    citationCompletionQuery,
    citationCompletions,
    citationKeys,
    citationLabel,
    citationPasteSource,
    citationUrl,
    citationVenue
  } from './citations.js';
  import { layoutGraph } from './graph.js';
  import { highlightCodeBlock, languageLabel } from './highlight.js';
  import { renderMarkdown } from './markdown.js';
  import {
    filterPapers,
    linkedArxivIds,
    newsCategoryCounts,
    newsDayLabel,
    NEWS_INSTRUCTIONS_PATH,
    NEWS_INSTRUCTIONS_TEMPLATE,
    newsClipChange,
    newsSegments,
    shortAuthorList
  } from './news.js';
  import { sliceNoteSection, splitEmbedTarget } from './note-embed.js';
  import { renderMermaid } from './mermaid.js';
  import { SNIPPETS, clockTime, snippetExpansion } from './snippets.js';
  import { noteDateEdits, stampNoteDates } from './note-dates.js';
  import {
    isDateNamedPath,
    noteTitle,
    renamePathForTitle
  } from './note-title.js';
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
  import {
    collectTasks,
    taskCitation,
    taskCompletionEdit,
    formatDueChip,
    formatDueLabel,
    groupTasksByUrgency,
    priorityGlyph,
    taskTextSegments,
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
    sanitizeSections,
    readableTaskSource,
    taskSourceLabel
  } from './task-sections.js';
  import { LANES, filterTasks, groupTasksIntoBoard } from './task-score.js';
  import {
    isMediaWikiTarget,
    resolveWikiLink,
    resolveWikiLinkPath,
    splitWikiTarget,
    wikiLinkLabel
  } from './wiki-links.js';
  import { findHeadingLine } from './note-headings.js';
  import {
    headingCompletions,
    noteCompletions,
    wikiCompletionQuery
  } from './wiki-complete.js';

  const SEARCH_HISTORY_KEY = 'webmd:search-history';
  const TASK_SECTIONS_KEY = 'webmd:task-sections';
  const TASK_BOARD_KEY = 'webmd:task-board';
  const TASK_GROUPINGS = ['board', 'sections', 'urgency'];
  const SEARCH_HISTORY_LIMIT = 8;
  const EDITED_FILES_KEY = 'webmd:edited-files';
  const EDITED_FILES_LIMIT = 5;
  const VIEW_MODE_KEY = 'webmd:view-mode';
  const WORKSPACE_VIEW_MODES = new Set(['edit', 'preview', 'diff', 'graph']);
  // 'tasks', 'calendar', 'news', and 'meetings' are workspace-wide views rather
  // than ways of looking at the open note, so none is remembered as a file's
  // view mode. They are still navigation destinations, so back and forward can
  // return to them.
  const WORKSPACE_VIEWS = new Set(['tasks', 'calendar', 'news', 'meetings']);
  const NEWS_FILTER_KEY = 'webmd:news-filter';
  const DEFAULT_DAILY_NOTE_FOLDER = '/raw/dailynotes';
  // Where a day's work lands in a project note. Fixed rather than configurable:
  // one heading everywhere means a project's log reads as one trail.
  const PROJECT_LOG_HEADING = 'Log';
  const DEFAULT_IMAGE_ASSET_FOLDER = '/assets';
  const REFERENCE_PANE_KEY = 'webmd:reference-pane';
  const IMAGE_EXTENSIONS = /\.(avif|gif|heic|heif|jpe?g|png|svg|webp)$/i;
  const UPLOAD_EXTENSIONS = /\.(avif|gif|heic|heif|jpe?g|png|svg|webp|pdf)$/i;
  const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function renderMath(source, displayMode = false) {
    return katex.renderToString(source, { throwOnError: false, displayMode });
  }

  const MERMAID_REDRAW_DELAY = 250;

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
  // The title the open note's file name already matches, so only a title the
  // user actually edits renames the file.
  let syncedTitle = '';
  // The open file's age on disk, used as `creation-date` for a note written
  // before the stamp existed. Empty means "new note", which dates to today.
  let selectedFileCreated = '';
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
  let editedPaths = [];
  let overview = {
    fileCount: 0,
    markdownCount: 0,
    recent: [],
    gitAvailable: false,
    changes: []
  };
  let overviewStatus = 'Loading workspace...';
  let dailyQuote = '';
  let dailyQuoteKey = '';
  let graphData = { nodes: [], edges: [], unresolved: 0, broken: [] };
  let bibliography = [];
  let brokenLinksOpen = false;
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
  let backlinks = null;
  let backlinksStatus = '';
  let backlinksOpen = true;
  let backlinksRun = 0;
  // Note bodies fetched to complete a `[[note#heading]]`. A note's headings
  // move rarely and a stale row costs a keystroke, so one fetch per note per
  // session is enough.
  const completionNotes = new Map();
  let filingLoading = false;
  let filingStatus = '';
  // The whole review-and-file run: the entries the model proposed, which of
  // them the reader kept, and how far through the kept ones they are.
  let filingPanel = null;
  let filingAbort = null;
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
  let newsPapers = [];
  let newsCategories = [];
  let newsPublished = '';
  // The announcement day asked for; '' follows the latest listing.
  let newsDay = '';
  let newsShownDay = '';
  let newsLatestDay = '';
  let newsDays = [];
  let newsStatus = '';
  let newsWarning = '';
  let newsFilter = readNewsFilter();
  let newsExpanded = new Set();
  let newsClipped = new Set();
  let newsClipping = new Set();
  let newsRanking = null;
  let newsRankStatus = '';
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
  let completingTask = false;
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
  let diffFiles = [];
  let diffStatus = '';
  // Panel layout. Prefs are the remembered desktop choices; transient state is
  // what is open while the window is too small to dock a panel, and is never
  // stored. See src/layout.js.
  let layoutPrefs = loadLayoutPrefs();
  let layoutTransient = { filesOpen: false, aiOpen: false };
  let viewportWidth = window.innerWidth;
  let panelReturnFocus = { files: null, ai: null };
  // The last thing focused in the workspace, so closing a panel hands focus
  // back to the editor (with its selection) rather than to the rail button
  // that happened to be clicked on the way in.
  let lastWorkspaceFocus = null;
  let filesPanel;
  let aiPanel;
  let chatInput;
  let filesMenuOpen = false;
  let markdownViewsHidden = false;
  // Workspace layout from .webmd/settings.json, set once there and then
  // forgotten, so the UI has no controls for any of it.
  let dailyNoteFolder = DEFAULT_DAILY_NOTE_FOLDER;
  let dailyNoteFolderConfigured = false;
  // null lets a conventionally named template in the workspace stand in;
  // '' is the deliberate "None".
  let dailyNoteTemplatePath = null;
  let imageAssetFolder = DEFAULT_IMAGE_ASSET_FOLDER;
  let settingsWarning = '';
  let meetingTimeZone = '';
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
  let resyncing = false;
  let resyncAttempts = 0;
  let sendPromise = Promise.resolve();
  let sendRun = 0;
  let updateSequence = 0;
  let copiedCode = null;
  let copiedCodeTimer;
  // Read-only previews of embedded notes, keyed by root and path. Never joins
  // the save queue or the collaboration stream.
  let noteEmbedCache = {};

  $: workspaceTree = cleanTree(tree);
  $: workspaceFiles = collectFiles(workspaceTree);
  $: markdownFiles = workspaceFiles.filter(
    (file) => file.fileKind === 'markdown'
  );
  $: dailyNoteFolders = ['/', ...collectVisibleDirectories(tree)];
  $: activeDailyNoteFolder =
    !treeLoaded || dailyNoteFolders.includes(dailyNoteFolder)
      ? dailyNoteFolder
      : '/';
  $: dailyNoteFolderMissing =
    dailyNoteFolder !== '/' && activeDailyNoteFolder !== dailyNoteFolder;
  $: activeDailyNoteTemplatePath =
    dailyNoteTemplatePath === null
      ? defaultDailyNoteTemplatePath(
          markdownFiles.map((file) => file.path),
          activeDailyNoteFolder
        )
      : dailyNoteTemplatePath;
  $: dailyNoteTemplateMissing =
    activeDailyNoteTemplatePath &&
    !markdownFiles.some((file) => file.path === activeDailyNoteTemplatePath);
  $: calendarDays = buildCalendarDays(calendarMonth);
  // Google Calendar events for the month on screen, when a feed is configured.
  let calendarEvents = [];
  let calendarEventsError = '';
  let calendarEventsRequest = 0;
  // The day whose events the detail dialog lists: { day, events, open }.
  let calendarDetail = null;
  let calendarDetailClose = null;
  $: if (viewMode === 'calendar') loadCalendarEvents(calendarDays);
  $: calendarEventsOnDay = eventsByDay(calendarEvents);
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
  $: layout = resolveLayout({
    viewportWidth,
    prefs: layoutPrefs,
    transient: layoutTransient
  });
  $: filesShown = layout.files !== 'hidden';
  $: aiShown = layout.ai !== 'hidden';
  // A phone-width panel covers the workspace, so the workspace stops taking
  // focus and clicks until it is closed.
  $: modalPanelOpen = layout.narrow && (filesShown || aiShown);
  // The Markdown views only collapse while the AI panel is docked, so closing
  // or floating the panel always brings the editor back.
  $: markdownViewsCollapsed = markdownViewsHidden && layout.ai === 'docked';
  $: shellColumns = [
    `${RAIL_WIDTH}px`,
    layout.files === 'docked' ? `${layout.filesWidth}px` : '',
    markdownViewsCollapsed ? '' : 'minmax(0, 1fr)',
    layout.ai === 'docked'
      ? markdownViewsCollapsed
        ? 'minmax(0, 1fr)'
        : `${layout.aiWidth}px`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
  $: flatTree = flattenTree(workspaceTree, expandedDirs);
  $: fileCount = workspaceFiles.length;
  // Resume follows the notes this browser has changed, not the ones it merely
  // opened, so reading around the workspace never pushes the work out of reach.
  $: continueFiles = editedPaths
    .map((path) => findFileNode(workspaceTree, path))
    .filter(Boolean);
  $: activeWorkspaceName =
    workspaceRoots.find((root) => root.id === selectedRoot)?.name ||
    'Workspace';
  $: selectedIsMarkdown = selectedFileKind === 'markdown';
  // Which notes link here follows the open note, and nothing else, so reading
  // one always shows its own mentions.
  $: loadBacklinks(selectedRoot, selectedIsMarkdown ? selectedPath : '');
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
  $: bibliographyByKey = new Map(
    bibliography.map((entry) => [entry.key, entry])
  );
  $: citedReferences = [
    ...new Set(selectedIsMarkdown ? citationKeys(content) : [])
  ].map((key) => ({ key, entry: bibliographyByKey.get(key) }));
  $: noteEmbedTargets = collectNoteEmbedTargets(renderedBlocks);
  $: loadNoteEmbeds(
    noteEmbedTargets,
    selectedRoot,
    selectedPath,
    workspaceFiles
  );
  $: noteEmbedViews = buildNoteEmbedViews(
    noteEmbedTargets,
    noteEmbedCache,
    selectedRoot,
    selectedPath,
    workspaceFiles
  );
  // Shelved reading without a date or priority, counted apart from the work.
  $: referenceTasks = new Set(
    groupTasksIntoSections(workspaceTasks, taskSections, { includeDone: true })
      .filter(
        (group) =>
          taskSections.find((section) => section.id === group.id)?.shelf
      )
      .flatMap((group) => group.groups.flatMap((source) => source.tasks))
      .filter((task) => !task.due && !task.priority)
  );
  // The filter box narrows the list once, before any of the three views slice
  // it, so switching between them keeps whatever you were looking for.
  $: matchingTasks = filterTasks(workspaceTasks, taskFilter);
  $: referenceCount = matchingTasks.filter(
    (task) => !task.checked && referenceTasks.has(task)
  ).length;
  $: taskGroups = groupTasksByUrgency(
    matchingTasks.filter((task) => showCompletedTasks || !task.checked),
    todayText
  );
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
  // unlabelled and the rows show compact source context.
  $: taskPanes =
    taskGrouping === 'urgency'
      ? taskGroups.map((group) => ({
          id: group.key || 'none',
          label: group.label,
          count: group.tasks.length,
          groups: [{ key: group.key || 'none', label: '', tasks: group.tasks }]
        }))
      : taskSectionGroups.filter((group) => group.count);
  // The views that take over the whole frame instead of showing the open file.
  $: workspacePaneOpen =
    viewMode === 'graph' ||
    viewMode === 'calendar' ||
    viewMode === 'tasks' ||
    viewMode === 'news' ||
    viewMode === 'meetings';
  // The rail's workspace views bring their own toolbars, so the file actions
  // above them (Upload, Delete, Reference, Edit/Preview, Diff) step aside.
  $: documentControls = !WORKSPACE_VIEWS.has(viewMode);
  $: toolbarTitle =
    viewMode === 'calendar'
      ? 'Daily Notes'
      : viewMode === 'news'
        ? 'arXiv News'
        : viewMode === 'meetings'
          ? 'Meetings'
          : viewMode === 'tasks'
            ? 'Tasks'
            : selectedPath || 'Workspace Home';
  // A path reads as its folder, quietly, then the file name.
  $: toolbarFolder =
    documentControls && selectedPath && selectedPath.includes('/')
      ? selectedPath.slice(0, selectedPath.lastIndexOf('/') + 1)
      : '';
  $: toolbarName = toolbarFolder
    ? toolbarTitle.slice(toolbarFolder.length)
    : toolbarTitle;
  // The note chat may send: a Markdown note on screen. One left open behind
  // Tasks, Calendar, or News is not on screen, so it stays out of the request
  // instead of travelling with it unseen.
  $: aiNotePath = selectedIsMarkdown && documentControls ? selectedPath : '';
  // Filing writes into notes the reader is not looking at, so it is offered
  // only from a daily note in the configured folder — the one note whose whole
  // purpose is to be distributed afterwards.
  $: filingNotePath =
    aiNotePath && dailyNoteDateFor(aiNotePath) ? aiNotePath : '';
  $: unsavedWork = Boolean(
    selectedIsMarkdown &&
    (content !== lastSaved || pendingUpdates.length || inFlightUpdates.length)
  );
  $: aiContext = chatContext({
    notePath: aiNotePath,
    // The server reads the note from disk, and treats a blank one as empty.
    noteLength: lastSaved.trim() ? lastSaved.length : 0,
    unsaved: unsavedWork,
    selectedText,
    hiddenNotePath: !aiNotePath && selectedIsMarkdown ? selectedPath : ''
  });
  $: saveView = saveStatusView({
    status,
    hasNote: Boolean(selectedPath && selectedIsMarkdown),
    unsaved: unsavedWork
  });
  $: visiblePapers = filterPapers(newsPapers, newsFilter);
  // A weekend's empty listing is not kept, but it is still today.
  $: newsDayOptions =
    newsLatestDay && !newsDays.includes(newsLatestDay)
      ? [newsLatestDay, ...newsDays]
      : newsDays;
  $: newsDayIndex = newsDayOptions.indexOf(newsShownDay);
  $: olderNewsDay =
    newsDayIndex >= 0 ? (newsDayOptions[newsDayIndex + 1] ?? '') : '';
  $: newerNewsDay = newsDayIndex > 0 ? newsDayOptions[newsDayIndex - 1] : '';
  $: newsCounts = newsCategoryCounts(newsPapers, newsCategories, newsFilter);
  $: rankIndex = new Map(
    (newsRanking?.order ?? []).map((id, index) => [id, index])
  );
  $: pickById = new Map(
    newsFilter.sort === 'arxiv'
      ? []
      : (newsRanking?.picks ?? []).map((pick) => [pick.id, pick])
  );
  $: rankedPapers =
    newsFilter.sort === 'arxiv' || !newsRanking
      ? visiblePapers
      : [...visiblePapers].sort(
          (left, right) =>
            (rankIndex.get(left.id) ?? rankIndex.size) -
            (rankIndex.get(right.id) ?? rankIndex.size)
        );
  $: pickedPapers = rankedPapers.filter((paper) => pickById.has(paper.id));
  // The five strongest of today's picks, whichever of them the filter shows.
  $: topPickIds = new Set([...pickById.keys()].slice(0, 5));
  $: topPapers = pickedPapers.filter((paper) => topPickIds.has(paper.id));
  $: morePicks = pickedPapers.filter((paper) => !topPickIds.has(paper.id));
  $: otherPapers = pickById.size
    ? rankedPapers.filter((paper) => !pickById.has(paper.id))
    : rankedPapers;
  $: hiddenReplacementCount = newsFilter.includeReplacements
    ? 0
    : filterPapers(newsPapers, { ...newsFilter, includeReplacements: true })
        .length - visiblePapers.length;
  $: noteTasks =
    selectedIsMarkdown && viewMode === 'preview' ? collectTasks(content) : [];
  $: noteProgress = taskProgress(noteTasks);
  // What the progress bar jumps to: the first box still to be ticked, in the
  // order the note writes them.
  $: firstOpenTask = noteTasks.find((task) => !task.checked) ?? null;
  $: referenceBlocks =
    referenceOpen && referencePath && !referenceStatus
      ? renderMarkdown(referenceContent)
      : [];
  $: queueWorkspaceSearch(searchQuery.trim(), selectedRoot, workspaceTree);
  $: if (paletteOpen) queuePaletteSearch(paletteQuery.trim(), selectedRoot);

  onMount(async () => {
    searchHistory = readSearchHistory();
    taskSections = readTaskSections();
    readTaskBoard();
    createEditor('');
    document.addEventListener('selectionchange', updateBrowserSelectedText);
    window.addEventListener('popstate', openNavigationState);
    document.addEventListener('visibilitychange', refreshVisibleNews);
    await loadRoots();
  });

  onDestroy(() => {
    document.removeEventListener('selectionchange', updateBrowserSelectedText);
    window.removeEventListener('popstate', openNavigationState);
    document.removeEventListener('visibilitychange', refreshVisibleNews);
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
        // Tab expands a `/name` snippet when the caret sits right after one,
        // and otherwise indents by the default two-space unit instead of
        // moving focus, so a selected block shifts with Tab and back with
        // Shift+Tab. Escape then Tab still leaves the editor for keyboard-only
        // use.
        keymap.of([{ key: 'Tab', run: expandSnippetInEditor }, indentWithTab]),
        // Plain CommonMark reads the closing `---` as a setext heading, which
        // renders the whole frontmatter block — and the note under it — as one
        // bold heading. This parses the block as the YAML it is.
        yamlFrontmatter({ content: markdown() }),
        // `[[` completes note names, and `#` after one completes that note's
        // headings. Registered as language data so it joins the autocompletion
        // basicSetup already runs rather than replacing it.
        EditorState.languageData.of(() => [
          { autocomplete: completeReference }
        ]),
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

    // Captured before anything is awaited: the request carries exactly the
    // context the panel was showing when Send was pressed.
    const context = aiContext.payload;
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
            path: context.path,
            selectedText: context.selectedText,
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
    dismissProjectFiling();
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
   * Asks the server which project notes the open day's work belongs in. This
   * only reads: nothing is written until the reader works through the list.
   */
  async function requestProjectFiling() {
    if (filingLoading || !filingNotePath) return;

    const root = selectedRoot;
    const path = selectedPath;
    filingAbort?.abort();
    filingAbort = new AbortController();
    const abort = filingAbort;
    filingLoading = true;
    filingStatus = 'Looking for the projects this day touched...';
    filingPanel = null;
    // Both panels dock to the same corner of the editor.
    clearInlineEdit();
    error = '';

    try {
      let response;
      try {
        response = await fetch('/api/ai/project-log', {
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

      const entries = (result.entries ?? []).filter(
        (entry) => entry.source && entry.summary
      );
      filingPanel = {
        root,
        path,
        step: 'review',
        entries,
        selected: new Set(entries.map((entry) => entry.path)),
        filed: result.filed ?? [],
        warning: result.warning ?? '',
        queue: [],
        index: 0,
        results: [],
        busy: false
      };
      filingStatus = entries.length
        ? `Reviewed ${result.candidateCount} project notes`
        : 'No project notes to update';
    } catch (err) {
      if (err.name === 'AbortError') return;
      filingStatus = 'Could not work out where this day belongs';
      error = err.message;
    } finally {
      if (filingAbort === abort) {
        filingAbort = null;
        filingLoading = false;
      }
    }
  }

  function toggleFilingEntry(entry) {
    if (!filingPanel || filingPanel.step !== 'review') return;
    const selected = new Set(filingPanel.selected);
    if (selected.has(entry.path)) selected.delete(entry.path);
    else selected.add(entry.path);
    filingPanel = { ...filingPanel, selected };
  }

  /** The exact line that will be appended to the project note. */
  function filingBulletText(entry) {
    return `- [[${entry.source}]] — ${entry.summary}`;
  }

  /**
   * Leaves the list behind and starts on the kept notes, one at a time. The
   * queue is frozen here so unchecking something later cannot change a run
   * already under way.
   */
  function startProjectFiling() {
    if (!filingPanel || filingPanel.step !== 'review') return;
    const queue = filingPanel.entries.filter((entry) =>
      filingPanel.selected.has(entry.path)
    );
    if (!queue.length) return;
    filingPanel = {
      ...filingPanel,
      step: 'walk',
      queue,
      index: 0,
      results: []
    };
    filingStatus = '';
  }

  /** Moves past the note on screen without touching it. */
  function skipFilingEntry() {
    if (!filingPanel || filingPanel.step !== 'walk' || filingPanel.busy) return;
    advanceFiling({
      path: filingPanel.queue[filingPanel.index].path,
      state: 'skipped'
    });
  }

  /**
   * Appends the bullet to the project note on screen and moves on.
   *
   * The note is not the open one, so the write cannot go through the editor.
   * It rides the same path a clipped paper takes into today's daily note:
   * load, one change, and a versioned update that retries when someone typed
   * into the note in between.
   */
  async function fileProjectEntry() {
    const panel = filingPanel;
    if (!panel || panel.step !== 'walk' || panel.busy) return;
    const entry = panel.queue[panel.index];
    const root = panel.root;
    filingPanel = { ...panel, busy: true };

    try {
      for (let attempt = 0; ; attempt += 1) {
        const file = await requestJson(
          `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(entry.path)}`
        );
        // A backlink added since the model looked would be a duplicate.
        if (file.content.includes(`[[${entry.source}]]`)) {
          advanceFiling({ path: entry.path, state: 'already' });
          return;
        }

        const changes = ChangeSet.of(
          newsClipChange(file.content, filingLine(entry), PROJECT_LOG_HEADING),
          file.content.length
        );
        try {
          await requestJson('/api/workspace/updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              root,
              path: entry.path,
              version: file.version,
              updates: [{ clientID: 'project-log', changes: changes.toJSON() }]
            })
          });
          break;
        } catch (err) {
          // Someone typed into the project note between the load and the update.
          if (err.status !== 409 || attempt >= 2) throw err;
        }
      }
      rememberEditedFile(entry.path, root);
      advanceFiling({ path: entry.path, state: 'filed' });
    } catch (err) {
      error = `Could not file into ${entry.path}: ${err.message}`;
      if (filingPanel) filingPanel = { ...filingPanel, busy: false };
    }
  }

  /** `newsClipChange` writes the bullet marker itself. */
  function filingLine(entry) {
    return `[[${entry.source}]] — ${entry.summary}`;
  }

  function advanceFiling(result) {
    const panel = filingPanel;
    if (!panel) return;
    const results = [...panel.results, result];
    const index = panel.index + 1;
    const done = index >= panel.queue.length;
    filingPanel = {
      ...panel,
      results,
      index,
      busy: false,
      step: done ? 'done' : 'walk'
    };
    if (done) {
      const filed = results.filter((item) => item.state === 'filed').length;
      filingStatus = filed
        ? `Filed into ${filed} project note${filed === 1 ? '' : 's'}`
        : 'Nothing was filed';
    }
  }

  function dismissProjectFiling() {
    filingAbort?.abort();
    filingAbort = null;
    filingLoading = false;
    filingPanel = null;
    filingStatus = '';
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

  // Each workspace carries its own layout, so this runs on every switch.
  async function loadSettings(root = selectedRoot) {
    let settings = {};
    try {
      settings = await requestJson(
        `/api/settings?root=${encodeURIComponent(root)}`
      );
    } catch {
      // Fall back to the defaults; uploads and daily notes still land somewhere
      // sensible.
    }
    if (root !== selectedRoot) return;
    imageAssetFolder = settings.imageAssetFolder || DEFAULT_IMAGE_ASSET_FOLDER;
    dailyNoteFolder = settings.dailyNoteFolder || DEFAULT_DAILY_NOTE_FOLDER;
    dailyNoteFolderConfigured = Boolean(settings.dailyNoteFolderConfigured);
    dailyNoteTemplatePath = settings.dailyNoteTemplate ?? null;
    meetingTimeZone = settings.meetingTimeZone || '';
    settingsWarning = settings.warning ?? '';
  }

  async function loadRoots() {
    try {
      workspaceRoots = await requestJson('/api/workspace/roots');
      selectedRoot = workspaceRoots[0]?.id ?? '0';
      viewMode = readWorkspaceViewMode(selectedRoot);
      await loadSettings(selectedRoot);
      editedPaths = readEditedFiles(selectedRoot);
      loadAiPresets(selectedRoot);
      await loadTree(selectedRoot);
      await loadReferences(selectedRoot);
      reconcileDailyNoteFolder();
      await loadOverview(selectedRoot);
      const path = navigationPathFromLocation();
      if (path) await openFile(path, { historyMode: 'replace' });
      else if (viewMode === 'graph') await loadGraph();
      if (!path) loadDailyQuote(selectedRoot);
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

  async function loadReferences(root = selectedRoot) {
    try {
      const result = await requestJson(
        `/api/workspace/references?root=${encodeURIComponent(root)}`
      );
      if (root === selectedRoot) bibliography = result.entries ?? [];
    } catch {
      if (root === selectedRoot) bibliography = [];
    }
  }

  async function switchWorkspace(root) {
    if (root === selectedRoot) return;
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    stopCollaboration();

    selectedRoot = root;
    editedPaths = readEditedFiles(root);
    tree = [];
    selectedPath = '';
    selectedFileKind = 'markdown';
    content = '';
    lastSaved = '';
    viewMode = readWorkspaceViewMode(root);
    graphData = { nodes: [], edges: [], unresolved: 0, broken: [] };
    graphView = { nodes: [], edges: [] };
    bibliography = [];
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
    dailyQuote = '';
    dailyQuoteKey = '';
    await loadSettings(root);
    await loadTree();
    await loadReferences(root);
    reconcileDailyNoteFolder();
    await loadOverview();
    loadDailyQuote(root);
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
    selectedFileCreated = '';
    if (fileKind === 'markdown')
      setViewMode(readWorkspaceViewMode(root), { remember: false });
    diffFiles = [];
    diffStatus = '';
    error = '';
    clearInlineEdit();
    followReference(path);

    if (fileKind !== 'markdown') {
      showMediaFile(path);
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
      selectedFileCreated = file.created || '';
      const buffered = sessionStorage.getItem(storageKey(root, path));
      const nextContent = buffered ?? file.content;

      showFile(root, path, nextContent, file.content, file.version, {
        collaborate: !buffered
      });
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

      const template = await loadDailyNoteTemplate(root);
      const nextContent = buildDailyNoteContent(
        date,
        path,
        template,
        await loadDailyNoteQuote(root, template, date)
      );
      try {
        await requestJson('/api/workspace/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, path, content: nextContent })
        });
        if (root !== selectedRoot || selectedPath !== path) return;
        showFile(root, path, nextContent, nextContent, 0);
        rememberEditedFile(path, root);
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

  async function createMarkdownNote() {
    const entered = await askPrompt('New note path', defaultNewNotePath());
    if (entered === null) return;

    const path = normalizeMarkdownPath(entered);
    if (!path) {
      error = 'Invalid note path.';
      return;
    }

    if (selectedPath && hasUnsavedChanges()) await saveNow();

    const root = selectedRoot;
    const heading = `# ${basename(path).replace(/\.(md|markdown)$/i, '')}\n\n`;
    const content = isDateNamedPath(path)
      ? heading
      : stampNoteDates(heading, dailyNoteDate(new Date()));
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

      rememberEditedFile(path, root);
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

  /** The local day `path` is the daily note of, or null for any other path. */
  function dailyNoteDateFor(path) {
    const date = dailyNoteDateFromPath(path);
    return date && todayNotePath(date) === path ? date : null;
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
      // D for daily: jumps to today's note from anywhere, without the detour
      // through the dashboard.
      KeyD: () => workspaceRoots.length && openDailyNote(),
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
    const path = activeDailyNoteTemplatePath;
    if (!path) return '';

    try {
      return (
        await requestJson(
          `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
        )
      ).content;
    } catch {
      return '';
    }
  }

  /**
   * Asks the model for the day's quote, once, when a template actually uses
   * `{{quote}}`. A missing or unreachable model must never block the note from
   * being created, so a failure just leaves the placeholder empty.
   */
  async function loadDailyNoteQuote(root, template, date) {
    if (!templateNeedsQuote(template)) return '';

    status = '[Writing quote...]';
    try {
      const reply = await requestJson('/api/ai/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, date: dailyNoteDate(date) })
      });
      return reply.quote || '';
    } catch {
      return '';
    }
  }

  /**
   * The dashboard's quote of the day. It shares the server's per-day history
   * with `{{quote}}`, so whichever surface asks first pays for the call and the
   * other reads it back — the note and the dashboard can never disagree about
   * what today's quote is.
   */
  async function loadDailyQuote(root = selectedRoot) {
    const date = dailyNoteDate(new Date());
    const key = `${root}\u0000${date}`;
    if (dailyQuoteKey === key) return;

    try {
      const reply = await requestJson('/api/ai/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, date })
      });
      if (root !== selectedRoot) return;
      dailyQuote = reply.quote || '';
      dailyQuoteKey = key;
    } catch {
      // No model configured is the common case here, and the dashboard reads
      // fine without a quote, so this stays silent.
      dailyQuote = '';
    }
  }

  async function showCalendar({ remember = true } = {}) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    if (remember) rememberViewNavigation('calendar');
    viewMode = 'calendar';
    todayText = dailyNoteDate(new Date());
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

  async function showNews({ remember = true } = {}) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    if (remember) rememberViewNavigation('news');
    viewMode = 'news';
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    error = '';
    await Promise.all([loadNews(), loadNewsClipped(selectedRoot)]);
    if (viewMode === 'news' && newsPapers.length) rankNews();
  }

  // Mounted on the first visit and kept, so the list and its selection are
  // still there on the way back from a note.
  let meetingsVisited = false;

  async function showMeetings({ remember = true } = {}) {
    if (selectedPath && hasUnsavedChanges()) await saveNow();
    if (remember) rememberViewNavigation('meetings');
    viewMode = 'meetings';
    meetingsVisited = true;
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    error = '';
  }

  /** A meeting's note, opened in the editor; a new one shows up in the tree. */
  async function openMeetingNote(path, { created = false } = {}) {
    const root = selectedRoot;
    if (created) await loadTree(root);
    if (root !== selectedRoot) return;
    await openFile(path);
    setViewMode('edit', { remember: false });
  }

  async function loadNews({ refresh = false } = {}) {
    const day = newsDay;
    newsStatus = refresh ? 'Checking arXiv...' : 'Loading arXiv...';
    try {
      const params = new URLSearchParams();
      if (day) params.set('day', day);
      if (refresh) params.set('refresh', '1');
      const query = params.toString();
      const news = await requestJson(
        `/api/news/arxiv${query ? `?${query}` : ''}`
      );
      if (day !== newsDay) return;
      newsPapers = news.papers;
      newsCategories = news.categories;
      newsPublished = news.published;
      newsShownDay = news.day || '';
      newsDays = news.days ?? [];
      if (!day) newsLatestDay = newsShownDay;
      newsWarning = news.warning || '';
      newsStatus = '';
    } catch (err) {
      if (day !== newsDay) return;
      // That day has aged out of the month kept; show the latest instead.
      if (day && err.status === 404) {
        newsDay = '';
        await loadNews();
        return;
      }
      newsStatus = err.message;
    }
  }

  async function refreshNews() {
    if (newsDay) {
      newsDay = '';
      newsRanking = null;
    }
    await loadNews({ refresh: true });
    await rankNews();
  }

  /** Shows one kept day's listing, so a missed day can be caught up. */
  async function selectNewsDay(day) {
    if (!day || day === newsShownDay) return;
    newsDay = day === newsLatestDay ? '' : day;
    newsRanking = null;
    newsExpanded = new Set();
    document.querySelector('.news-pane')?.scrollTo?.(0, 0);
    await loadNews();
    if (viewMode === 'news' && newsPapers.length) rankNews();
  }

  /**
   * Asks the server to order today's listing against this workspace. It runs
   * after the listing is on screen, because a model call over a whole day of
   * papers takes a while and the papers are readable in arXiv order meanwhile.
   */
  async function rankNews({ refresh = false } = {}) {
    const root = selectedRoot;
    const day = newsDay;
    const current = () => root === selectedRoot && day === newsDay;
    newsRankStatus = refresh
      ? 'Ranking these papers again...'
      : 'Picking the papers you would want to read...';
    try {
      const ranking = await requestJson('/api/news/rank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, refresh, day: day || undefined })
      });
      if (!current()) return;
      newsRanking = ranking;
    } catch (err) {
      if (current())
        newsRanking = { order: [], picks: [], warning: err.message };
    } finally {
      if (current()) newsRankStatus = '';
    }
  }

  /** Opens the ranking instructions note, starting one the first time. */
  async function openNewsInstructions() {
    const root = selectedRoot;
    const path = NEWS_INSTRUCTIONS_PATH;
    try {
      try {
        await requestJson(
          `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
        );
      } catch (err) {
        if (err.status !== 404) throw err;
        await requestJson('/api/workspace/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            root,
            path,
            content: NEWS_INSTRUCTIONS_TEMPLATE
          })
        });
      }
      if (root !== selectedRoot) return;
      await openFile(path);
      setViewMode('edit', { remember: false });
    } catch (err) {
      error = `Could not open the ranking instructions: ${err.message}`;
    }
  }

  // A phone web app sits in the background for hours, so papers clipped on
  // another device only show as clipped once News looks at today's note again.
  function refreshVisibleNews() {
    if (document.visibilityState === 'visible' && viewMode === 'news') {
      loadNewsClipped(selectedRoot);
    }
  }

  /** Papers already linked from today's note show as clipped, however they got there. */
  async function loadNewsClipped(root) {
    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(todayNotePath())}`
      );
      if (root === selectedRoot) newsClipped = linkedArxivIds(file.content);
    } catch {
      // No note yet today means nothing is clipped.
      if (root === selectedRoot) newsClipped = new Set();
    }
  }

  /**
   * Adds the paper to today's note under `## Reading`, as the same citation a
   * pasted arXiv link becomes. An existing note is changed through the
   * collaborative update path, so an editor that has it open sees the line
   * arrive; a missing one is created from the daily template first.
   */
  async function clipPaper(paper) {
    const root = selectedRoot;
    const date = new Date();
    const path = todayNotePath(date);
    const line = arxivCitation(paper);
    newsClipping = new Set(newsClipping).add(paper.id);
    try {
      for (let attempt = 0; ; attempt += 1) {
        let file = null;
        try {
          file = await requestJson(
            `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
          );
        } catch (err) {
          if (err.status !== 404) throw err;
        }

        if (!file) {
          const template = await loadDailyNoteTemplate(root);
          const base = buildDailyNoteContent(
            date,
            path,
            template,
            await loadDailyNoteQuote(root, template, date)
          );
          const clip = newsClipChange(base, line);
          const content =
            base.slice(0, clip.from) + clip.insert + base.slice(clip.to);
          await requestJson('/api/workspace/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root, path, content })
          });
          if (root === selectedRoot) await loadTree(root);
          break;
        }

        const changes = ChangeSet.of(
          newsClipChange(file.content, line),
          file.content.length
        );
        try {
          await requestJson('/api/workspace/updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              root,
              path,
              version: file.version,
              updates: [{ clientID: 'news-clip', changes: changes.toJSON() }]
            })
          });
          break;
        } catch (err) {
          // Someone typed into the note between the load and the update.
          if (err.status !== 409 || attempt >= 2) throw err;
        }
      }
      rememberEditedFile(path, root);
      newsClipped = new Set(newsClipped).add(paper.id.toLowerCase());
    } catch (err) {
      error = `Could not clip ${paper.id}: ${err.message}`;
    } finally {
      const clipping = new Set(newsClipping);
      clipping.delete(paper.id);
      newsClipping = clipping;
    }
  }

  function toggleNewsAbstract(id) {
    const expanded = new Set(newsExpanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    newsExpanded = expanded;
  }

  function toggleNewsCategory(category) {
    const categories = newsFilter.categories.includes(category)
      ? newsFilter.categories.filter((item) => item !== category)
      : [...newsFilter.categories, category];
    setNewsFilter({ categories });
  }

  function readNewsFilter() {
    const empty = {
      query: '',
      categories: [],
      includeReplacements: false,
      sort: 'rank'
    };
    try {
      const stored = JSON.parse(localStorage.getItem(NEWS_FILTER_KEY) || '{}');
      return {
        query: typeof stored.query === 'string' ? stored.query : '',
        categories: Array.isArray(stored.categories)
          ? stored.categories.filter((item) => typeof item === 'string')
          : [],
        includeReplacements: stored.includeReplacements === true,
        sort: stored.sort === 'arxiv' ? 'arxiv' : 'rank'
      };
    } catch {
      return empty;
    }
  }

  /** The filter is kept, so tomorrow's listing opens narrowed the same way. */
  function setNewsFilter(changes) {
    newsFilter = { ...newsFilter, ...changes };
    try {
      localStorage.setItem(NEWS_FILTER_KEY, JSON.stringify(newsFilter));
    } catch {
      // Ignore storage failures; the filter still works this session.
    }
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

  async function completeTaskItem(task) {
    if (completingTask) return;
    completingTask = true;
    const root = selectedRoot;
    try {
      if (hasUnsavedChanges()) await saveNow();
      if (hasUnsavedChanges())
        throw new Error('Save your current note before completing an item.');
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(task.path)}`
      );
      const edit = taskCompletionEdit(file.content, task, todayText);
      await requestJson('/api/workspace/updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root,
          path: task.path,
          version: file.version,
          updates: [
            {
              clientID: 'task-list',
              changes: ChangeSet.of(edit, file.content.length).toJSON()
            }
          ]
        })
      });
      fileCache.delete(rootPathKey(root, task.path));
      await loadTasks(root);
    } catch (err) {
      tasksStatus = err.message;
    } finally {
      completingTask = false;
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

  // Keys on a link or a who: chip inside the title belong to that control.
  function openTaskOnKey(task, event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    openTask(task);
  }

  /** Scrolls a source line into view in the preview and marks it briefly. */
  function revealPreviewLine(line) {
    const target = [
      ...document.querySelectorAll(`.preview-pane [data-line="${line}"]`)
    ].find((node) => !node.closest('.note-embed-body'));
    if (!target) return;

    target.scrollIntoView({ block: 'center' });
    target.classList.add('line-flash');
    setTimeout(() => target.classList.remove('line-flash'), 1200);
  }

  // A copy up to a week old shows at once (the answer says `stale`); the
  // fresh one the server fetched behind it is then asked for quietly.
  async function loadCalendarEvents(days, { fresh = false } = {}) {
    const request = ++calendarEventsRequest;
    const from = dailyNoteDate(days[0].date);
    const to = dailyNoteDate(days[days.length - 1].date);
    try {
      const response = await fetch(
        `/api/calendar/events?from=${from}&to=${to}${fresh ? '&fresh=1' : ''}`
      );
      const body = await response.json();
      if (request !== calendarEventsRequest) return;
      if (!response.ok) throw new Error(body.error || 'Calendar failed.');
      calendarEvents = body.events;
      calendarEventsError = body.errors.join(' ');
      if (body.stale && !fresh) loadCalendarEvents(days, { fresh: true });
    } catch (err) {
      // The quiet follow-up failing leaves the stale copy on screen.
      if (request !== calendarEventsRequest || fresh) return;
      calendarEvents = [];
      calendarEventsError = err.message;
    }
  }

  async function openCalendarDetail(day, events, open = -1) {
    calendarDetail = { day, events, open };
    await tick();
    calendarDetailClose?.focus();
  }

  /**
   * Opens the day's note (creating it as usual) and leaves the cursor under a
   * heading for the meeting, adding the section only the first time.
   */
  async function addMeetingToDayNote(day, event) {
    calendarDetail = null;
    const path = todayNotePath(day.date);
    await openDailyNote(day.date);
    if (selectedPath !== path || !editorView) return null;
    if (viewMode === 'preview') setViewMode('edit');

    const { heading, text } = meetingNoteSection(
      event,
      calendarEventLabel(event)
    );
    const doc = editorView.state.doc.toString();
    const found = doc.split('\n').indexOf(heading);
    if (found >= 0) {
      const line = editorView.state.doc.line(found + 1);
      editorView.dispatch({
        selection: { anchor: line.to },
        scrollIntoView: true
      });
    } else {
      const gap = !doc
        ? ''
        : doc.endsWith('\n\n')
          ? ''
          : doc.endsWith('\n')
            ? '\n'
            : '\n\n';
      const insert = `${gap}${text}`;
      editorView.dispatch({
        changes: { from: doc.length, insert },
        selection: { anchor: doc.length + insert.length },
        scrollIntoView: true
      });
    }
    editorView.focus();
    return { path, heading };
  }

  /**
   * The meeting's section in the day's note, saved, so the server can write
   * a transcript link or summary into it; then `body` is posted to `url`.
   */
  async function postForCalendarMeeting(day, event, url, body = {}) {
    const root = selectedRoot;
    const section = await addMeetingToDayNote(day, event);
    if (!section) return null;
    if (hasUnsavedChanges()) await saveNow();
    return requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root,
        ...section,
        title: event.title,
        date: dailyNoteDate(day.date),
        ...body
      })
    });
  }

  async function addCalendarTranscript(day, event, input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const saved = await postForCalendarMeeting(
        day,
        event,
        '/api/calendar/transcript',
        { name: file.name, text }
      );
      if (saved) status = `[Transcript saved: ${saved.turns} turns]`;
    } catch (err) {
      error = err.message;
    }
  }

  async function summarizeCalendarMeeting(day, event) {
    try {
      const pending = postForCalendarMeeting(
        day,
        event,
        '/api/calendar/summary'
      );
      status = '[Summarizing meeting…]';
      const done = await pending;
      if (done) {
        status = `[Summary written: ${done.actions} action item${done.actions === 1 ? '' : 's'}]`;
      }
    } catch (err) {
      status = '[Saved]';
      error = err.message;
    }
  }

  function closeCalendarDetailOnEscape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    calendarDetail = null;
  }

  function calendarEventLabel(event) {
    if (event.allDay) return event.title;
    const time = new Date(event.startsAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
    return `${time} ${event.title}`;
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
    syncedTitle = noteTitle(nextContent);
    fileCache.set(rootPathKey(root, path), nextContent);
    setEditorContent(nextContent);
    resetCollaboration(version);
    if (collaborate) openDocumentEvents(root, path, version);
  }

  function showMediaFile(path) {
    stopCollaboration();
    content = '';
    lastSaved = '';
    syncedTitle = '';
    selectedText = '';
    selectedRange = null;
    clearInlineEdit();
    viewMode = 'preview';
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
        const tidied = tidyPaste(view.state, event.clipboardData, beforeCursor);
        const source = tidied ?? text;
        const pastedCitation = citationPasteSource(source, { beforeCursor });
        const insert =
          (pastedCitation
            ? pastedCitation
            : (shortLink(view.state, source, beforeCursor) ??
              mathPaste(view.state, source, beforeCursor))) ?? tidied;
        if (insert === null) return false;

        event.preventDefault();
        const from = view.state.selection.main.from;
        insertText(view, text);
        rewritePastedText(view, from, from + text.length, insert);
        // The source lands now; its stable cite key arrives with the BibTeX.
        const range = { from, to: from + insert.length };
        if (pastedCitation) {
          upgradeCitation(pastedCitation, insert, range);
        } else {
          upgradeIndicoLink(source, insert, range);
          upgradeXLink(source, insert, range);
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
  async function upgradeCitation(source, placeholder, range) {
    const root = selectedRoot;
    const path = selectedPath;

    let metadata;
    try {
      metadata = await requestJson('/api/workspace/citations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, source })
      });
    } catch (err) {
      if (root === selectedRoot) error = err.message;
      return;
    }

    if (root !== selectedRoot || path !== selectedPath || !selectedIsMarkdown) {
      return;
    }

    bibliography = metadata.entries ?? bibliography;
    replacePastedLink(placeholder, `[@${metadata.entry.key}]`, range);
  }

  /**
   * Swaps the placeholder a paste left behind for the text a lookup returned,
   * as long as it is still there untouched.
   */
  function replacePastedLink(placeholder, replacement, range) {
    if (replacement === placeholder) return;

    const length = editorView.state.doc.length;
    const from = Math.min(range.from, length);
    const to = Math.min(range.to, length);
    if (editorView.state.doc.sliceString(from, to) !== placeholder) return;

    // Only carry the cursor along if it is still sitting right after the link.
    const cursor = editorView.state.selection.main;
    const followCursor = cursor.empty && cursor.head === to;
    editorView.dispatch({
      changes: { from, to, insert: replacement },
      ...(followCursor
        ? { selection: { anchor: from + replacement.length } }
        : {})
    });
  }

  /**
   * Trades the `Indico event 1338689` placeholder for the meeting's real name.
   * Like the arXiv upgrade, it runs un-awaited and drops out when the note or
   * the pasted text has moved on, and quietly when the page needs a login.
   */
  async function upgradeIndicoLink(source, placeholder, range) {
    const reference = indicoReference(source.trim());
    if (!reference) return;

    const root = selectedRoot;
    const path = selectedPath;

    let metadata;
    try {
      metadata = await requestJson(
        `/api/indico?url=${encodeURIComponent(reference.url)}`
      );
    } catch (err) {
      // A 404 is a page the server cannot see, which the placeholder already
      // says; anything else — a rejected token, a dead network — is worth
      // reporting.
      if (err.status !== 404 && root === selectedRoot) error = err.message;
      return;
    }

    const label = indicoLabel(metadata);
    if (!label) return;
    if (root !== selectedRoot || path !== selectedPath || !selectedIsMarkdown) {
      return;
    }
    replacePastedLink(placeholder, `[${label}](${reference.url})`, range);
  }

  /**
   * Trades the `@handle on X` placeholder for the account's name and the words
   * of the post itself. Like the Indico upgrade it runs un-awaited, drops out
   * when the note or the pasted text has moved on, and stays quiet about a
   * post X will not quote — a photo-only one keeps `on X`.
   */
  async function upgradeXLink(source, placeholder, range) {
    const reference = xPostReference(source);
    if (!reference) return;

    const root = selectedRoot;
    const path = selectedPath;

    let metadata;
    try {
      metadata = await requestJson(
        `/api/x?url=${encodeURIComponent(reference.url)}`
      );
    } catch (err) {
      if (err.status !== 404 && root === selectedRoot) error = err.message;
      return;
    }

    const label = xPostLabel(metadata);
    if (!label) return;
    if (root !== selectedRoot || path !== selectedPath || !selectedIsMarkdown) {
      return;
    }
    replacePastedLink(placeholder, `[${label}](${source.trim()})`, range);
  }

  function textBeforeCursor(state) {
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.from);
    return line.text.slice(0, selection.from - line.from);
  }

  /**
   * Whitespace cleanup for a paste, skipped inside a fenced block where the
   * text is code and every space counts. Wrapper indentation only comes off
   * when the paste starts its own line, so an indent the cursor already sits
   * in is never second-guessed.
   */
  function tidyPaste(state, clipboardData, beforeCursor) {
    if (insideCodeFence(state)) return null;

    return tidyPasteText(clipboardData?.getData('text/plain') || '', {
      html: clipboardData?.getData('text/html') || '',
      dedent: beforeCursor === ''
    });
  }

  /** Fences before the cursor pair up; an odd count leaves it inside one. */
  function insideCodeFence(state) {
    const line = state.doc.lineAt(state.selection.main.from);
    let fences = 0;
    for (let number = 1; number < line.number; number += 1) {
      if (/^ {0,3}(```|~~~)/.test(state.doc.line(number).text)) fences += 1;
    }
    return fences % 2 === 1;
  }

  /**
   * The clipboard text lands first and the rewrite follows in its own history
   * entry, so one undo brings back exactly what was pasted instead of undoing
   * the paste altogether.
   */
  function rewritePastedText(view, from, to, insert) {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      annotations: isolateHistory.of('full')
    });
  }

  /** A forge URL becomes a markdown link named the way the forge names it. */
  function shortLink(state, text, beforeCursor) {
    if (insideCodeFence(state)) return null;

    return shortLinkPaste(text, { beforeCursor });
  }

  /** Unicode powers become inline math, on top of any quote prefixes added. */
  function mathPaste(state, text, beforeCursor) {
    const quoted = quotedPasteText(state, text, beforeCursor);
    return mathPasteText(quoted ?? text, { beforeCursor }) ?? quoted;
  }

  function quotedPasteText(state, text, beforeCursor) {
    const line = state.doc.lineAt(state.selection.main.from);
    const previousLine =
      !beforeCursor.trim() && line.number > 1
        ? state.doc.line(line.number - 1).text
        : '';
    return quotedBlockPaste(text, { beforeCursor, previousLine });
  }

  /**
   * Replaces the `/name` before the caret with the snippet's text. Returns
   * false when there is nothing to expand, which hands Tab back to indenting.
   */
  function expandSnippetInEditor(view) {
    if (!selectedPath || !selectedIsMarkdown) return false;

    const selection = view.state.selection.main;
    if (!selection.empty) return false;

    const line = view.state.doc.lineAt(selection.head);
    const now = new Date();
    const expansion = snippetExpansion(
      line.text.slice(0, selection.head - line.from),
      { date: dailyNoteDate(now), time: clockTime(now) }
    );
    if (!expansion) return false;

    const from = selection.head - expansion.length;
    view.dispatch({
      changes: { from, to: selection.head, insert: expansion.insert },
      selection: { anchor: from + expansion.caret },
      scrollIntoView: true
    });
    return true;
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
    if (!selectedPath) return;
    if (
      !(await askConfirm(
        `Delete ${selectedPath}? This cannot be undone.`,
        'Delete'
      ))
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
      editedPaths = editedPaths.filter((item) => item !== path);
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
          editedFilesStorageKey(root),
          JSON.stringify(editedPaths)
        );
      } catch {
        // Ignore storage failures; the visible list is already updated.
      }
      selectedPath = '';
      selectedFileKind = 'markdown';
      content = '';
      lastSaved = '';
      syncedTitle = '';
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

  /**
   * Stamps the open note's `creation-date` and `last-modified-date` before it
   * is written out, so every note carries how old its information is. Daily
   * notes are exempt: their file name is already the date. The edit only lands
   * once a day, when the stamp no longer says today.
   */
  function stampNoteDatesInEditor() {
    if (!editorView || !selectedPath || !selectedIsMarkdown) return;
    if (isDateNamedPath(selectedPath)) return;

    const changes = noteDateEdits(
      editorView.state.doc.toString(),
      dailyNoteDate(new Date()),
      localDate(selectedFileCreated)
    );
    if (changes.length) editorView.dispatch({ changes });
  }

  /** An ISO timestamp from the server as a local `YYYY-MM-DD`. */
  function localDate(timestamp) {
    const date = timestamp ? new Date(timestamp) : null;
    return date && !Number.isNaN(date.getTime()) ? dailyNoteDate(date) : '';
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
    stampNoteDatesInEditor();

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
      rememberEditedFile(path, root);
      await syncFileNameToTitle(root, path, nextContent);
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

    // Queues its own update, and re-arms the save timer this flush just
    // cleared.
    stampNoteDatesInEditor();
    clearTimeout(saveTimer);

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
      resyncAttempts = 0;
      sendingUpdates = false;
      sessionStorage.removeItem(storageKey(root, path));
      if (pendingUpdates.length) {
        await flushPendingUpdates();
      } else {
        lastSaved = content;
        fileCache.set(rootPathKey(root, path), content);
        status = '[Saved]';
        rememberEditedFile(path, root);
        await syncFileNameToTitle(root, path, content);
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
      if (err.status === 409) resyncDocument(root, path);
      else queueRetry();
    });
    return sendPromise;
  }

  /**
   * A 409 says the server is holding a different version of the note than the
   * one our updates were composed against - most often because it restarted
   * and re-read the file from disk at version 0. Resending is hopeless, so we
   * take the server's copy as the new base, rebase whatever is unsaved onto
   * it, and carry on. Nothing typed is lost: the editor keeps its text and the
   * change we send is whatever the two copies disagree about.
   */
  async function resyncDocument(root, path) {
    if (resyncing) return;
    resyncing = true;
    resyncAttempts += 1;
    let rebased = false;
    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (root !== selectedRoot || path !== selectedPath || !selectedIsMarkdown)
        return;

      // A queue composed against text the server no longer holds cannot be
      // replayed onto it, so it collapses into one change from there to here.
      if (file.content !== lastSaved) {
        const changes = changesBetween(file.content, content);
        lastSaved = file.content;
        inFlightUpdates = [];
        pendingUpdates = changes ? [newCollabUpdate(changes)] : [];
      }
      // Reopens the event stream too: the old one is asking for versions in a
      // numbering the server has forgotten.
      openDocumentEvents(root, path, file.version);
      error = '';
      rebased = true;
    } catch (err) {
      if (root === selectedRoot && path === selectedPath) {
        error = err.message;
        status = '[Offline - Retrying]';
      }
    } finally {
      resyncing = false;
    }

    if (root !== selectedRoot || path !== selectedPath) return;
    // Two clients can keep taking the version from each other. Rather than
    // trade 409s as fast as the network allows, a resync that has not settled
    // after a few rounds falls back to the ordinary retry timer.
    if (rebased && pendingUpdates.length && resyncAttempts <= 3) {
      await flushPendingUpdates();
      return;
    }
    if (pendingUpdates.length) queueRetry();
    else clearBufferedContent(root, path);
  }

  /**
   * A resync can find the server already holding what is on screen - the save
   * landed and only the acknowledgement was lost - which leaves nothing to
   * send and nothing to warn about.
   */
  function clearBufferedContent(root, path) {
    sessionStorage.removeItem(storageKey(root, path));
    lastSaved = content;
    status = '[Saved]';
  }

  /**
   * Keeps the file name on the note's title, the way Obsidian does: retitle the
   * note and the file follows, with the [[wiki links]] that pointed at the old
   * name rewritten by the server.
   */
  async function syncFileNameToTitle(root, path, savedContent) {
    if (root !== selectedRoot || path !== selectedPath) return;

    const title = noteTitle(savedContent);
    if (!title || title === syncedTitle) return;

    // Recorded before the request, so a rename that cannot happen — a name
    // already taken, say — is not retried on every following keystroke.
    syncedTitle = title;
    if (isDateNamedPath(path)) return;

    const nextPath = renamePathForTitle(path, title);
    if (!nextPath) return;

    try {
      const result = await requestJson('/api/workspace/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, from: path, to: nextPath })
      });
      adoptRenamedPath(root, path, result.path);
    } catch (err) {
      // A 404 means another client renamed the note first; its event stream
      // brings this one back in line, so there is nothing to report.
      if (err.status !== 404 && root === selectedRoot && path === selectedPath)
        error = err.message;
    }
  }

  /** Moves the open note's client-side state onto its new path. */
  function adoptRenamedPath(root, from, to) {
    const buffered = sessionStorage.getItem(storageKey(root, from));
    sessionStorage.removeItem(storageKey(root, from));
    if (buffered !== null)
      sessionStorage.setItem(storageKey(root, to), buffered);

    const cached = fileCache.get(rootPathKey(root, from));
    fileCache.delete(rootPathKey(root, from));
    if (cached !== undefined) fileCache.set(rootPathKey(root, to), cached);

    navigationBackStack = navigationBackStack.map((item) =>
      item.root === root && item.path === from ? { ...item, path: to } : item
    );
    navigationForwardStack = navigationForwardStack.map((item) =>
      item.root === root && item.path === from ? { ...item, path: to } : item
    );
    searchResults = searchResults.map((item) =>
      item.path === from ? { ...item, path: to } : item
    );
    if (referencePath === from) referencePath = to;
    editedPaths = editedPaths.map((item) => (item === from ? to : item));
    persistEditedFiles(root);
    if (root !== selectedRoot || selectedPath !== from) return;

    selectedPath = to;
    expandToPath(to);
    updateNavigationState(to, 'replace');
    // The server moved the document with its version intact, so the editing
    // session carries on under the new path instead of restarting.
    if (collaborationEnabled) openDocumentEvents(root, to, documentVersion);
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
    if (node.kind === 'citation') {
      if (/^https?:\/\//i.test(node.href || ''))
        window.open(node.href, '_blank', 'noopener,noreferrer');
      return;
    }
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
    loadDailyQuote();
  }

  function loadLayoutPrefs() {
    try {
      return readLayoutPrefs(localStorage.getItem(LAYOUT_KEY));
    } catch {
      return readLayoutPrefs(null);
    }
  }

  // Layout only: which panels are open and how wide. Never notes or chat.
  function saveLayoutPrefs() {
    try {
      localStorage.setItem(LAYOUT_KEY, serializeLayoutPrefs(layoutPrefs));
    } catch {
      // Private mode or a full quota: the layout still works for this session.
    }
  }

  function applyLayoutState(next) {
    const prefsChanged = next.prefs !== layoutPrefs;
    layoutPrefs = next.prefs;
    layoutTransient = next.transient;
    if (prefsChanged) saveLayoutPrefs();
  }

  function panelElement(panel) {
    return panel === 'files' ? filesPanel : aiPanel;
  }

  function railButton(panel) {
    return document.querySelector(
      `[aria-controls="${panel}-panel"].global-action`
    );
  }

  async function focusPanel(panel) {
    await tick();
    if (panel === 'ai') {
      if (chatInput && !chatInput.disabled) chatInput.focus();
      else aiPanel?.focus();
    } else if (layout.files === 'overlay') {
      (searchInput || filesPanel)?.focus();
    }
  }

  function trackWorkspaceFocus(event) {
    if (event.target instanceof HTMLElement) lastWorkspaceFocus = event.target;
  }

  /** Opens or closes a panel from the rail or a panel's own close button. */
  async function toggleLayoutPanel(panel) {
    const shown = layout[panel] !== 'hidden';
    if (shown) return hideLayoutPanel(panel);
    const active = document.activeElement;
    panelReturnFocus[panel] = lastWorkspaceFocus?.isConnected
      ? lastWorkspaceFocus
      : active && !panelElement(panel)?.contains(active)
        ? active
        : null;
    applyLayoutState(
      togglePanel(panel, {
        layout,
        prefs: layoutPrefs,
        transient: layoutTransient
      })
    );
    await focusPanel(panel);
  }

  async function hideLayoutPanel(panel) {
    const hadFocus = panelElement(panel)?.contains(document.activeElement);
    applyLayoutState(
      closePanel(panel, {
        layout,
        prefs: layoutPrefs,
        transient: layoutTransient
      })
    );
    if (panel === 'ai') markdownViewsHidden = false;
    if (panel === 'files') filesMenuOpen = false;
    if (!hadFocus) return;
    // Focus goes back where it came from, or to the rail button that opens the
    // panel again, rather than being dropped on <body>.
    await tick();
    const back = panelReturnFocus[panel];
    panelReturnFocus[panel] = null;
    if (back?.isConnected && back.getClientRects().length) back.focus();
    else railButton(panel)?.focus();
  }

  function closeOverlayOnEscape(panel, event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (layout[panel] !== 'overlay') return;
    event.preventDefault();
    hideLayoutPanel(panel);
  }

  async function showFilesPanel() {
    if (layout.files === 'hidden') {
      applyLayoutState(
        togglePanel('files', {
          layout,
          prefs: layoutPrefs,
          transient: layoutTransient
        })
      );
    }
    await tick();
  }

  // Opening a file from a floating sidebar means the user wants to read it.
  function closeFilesOverlayAfterOpen() {
    if (layout.files === 'overlay') hideLayoutPanel('files');
  }

  function setPanelWidth(panel, width) {
    const other =
      panel === 'files'
        ? layout.ai === 'docked'
          ? layout.aiWidth
          : 0
        : layout.files === 'docked'
          ? layout.filesWidth
          : 0;
    const key = panel === 'files' ? 'filesWidth' : 'aiWidth';
    const next = clampPanelWidth(panel, width, {
      viewportWidth,
      otherWidth: other
    });
    if (next === layoutPrefs[key]) return;
    layoutPrefs = { ...layoutPrefs, [key]: next };
  }

  function startPanelResize(panel, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-panels');
    const move = (moveEvent) => {
      setPanelWidth(
        panel,
        panel === 'files'
          ? moveEvent.clientX - RAIL_WIDTH
          : viewportWidth - moveEvent.clientX
      );
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-panels');
      saveLayoutPrefs();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function resizePanelByKey(panel, event) {
    const current = panel === 'files' ? layout.filesWidth : layout.aiWidth;
    const width = keyboardWidth(panel, current, event.key, {
      shift: event.shiftKey
    });
    if (width === null) return;
    event.preventDefault();
    setPanelWidth(panel, width);
    saveLayoutPrefs();
  }

  function closeFilesMenuOnEscape(event) {
    if (event.key !== 'Escape' || !filesMenuOpen) return;
    // Handled here so the Escape does not also close a floating sidebar.
    event.preventDefault();
    filesMenuOpen = false;
    filesPanel?.querySelector('[aria-label="More file actions"]')?.focus();
  }

  function runFilesMenu(action) {
    filesMenuOpen = false;
    action();
  }

  function resetPanelWidth(panel) {
    setPanelWidth(panel, WIDTH_LIMITS[panel].initial);
    saveLayoutPrefs();
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

  /**
   * Records a note the user has just changed, so Resume offers the work in
   * progress rather than everything that was merely opened and read.
   */
  function rememberEditedFile(path, root = selectedRoot) {
    if (root !== selectedRoot) return;
    editedPaths = [path, ...editedPaths.filter((item) => item !== path)].slice(
      0,
      EDITED_FILES_LIMIT
    );
    persistEditedFiles(root);
  }

  function persistEditedFiles(root) {
    try {
      localStorage.setItem(
        editedFilesStorageKey(root),
        JSON.stringify(editedPaths)
      );
    } catch {
      // Ignore storage failures; edited files still work this session.
    }
  }

  function readEditedFiles(root) {
    try {
      const value = JSON.parse(
        localStorage.getItem(editedFilesStorageKey(root)) || '[]'
      );
      return Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string')
            .slice(0, EDITED_FILES_LIMIT)
        : [];
    } catch {
      return [];
    }
  }

  function editedFilesStorageKey(root) {
    return `${EDITED_FILES_KEY}:${root}`;
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

  function collectNoteEmbedTargets(blocks = []) {
    const targets = [];

    const walk = (list) => {
      for (const block of list ?? []) {
        if (block.type === 'noteEmbed') targets.push(block.target);
        if (block.children) walk(block.children);
      }
    };
    walk(blocks);

    return [...new Set(targets)];
  }

  /**
   * Fetches each embedded note once and keeps it. An embed is a preview, not a
   * second copy of the note: it never edits, so a stale card costs nothing next
   * to refetching every note on every keystroke.
   */
  async function loadNoteEmbeds(targets, root, currentPath, files) {
    for (const target of targets) {
      const path = embedNotePath(target, currentPath, files);
      if (!path || path === currentPath) continue;

      const key = rootPathKey(root, path);
      if (noteEmbedCache[key]) continue;

      noteEmbedCache = { ...noteEmbedCache, [key]: { status: 'loading' } };
      let entry;
      try {
        const file = await requestJson(
          `/api/workspace/load?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
        );
        entry = { status: 'ready', content: file.content };
      } catch (err) {
        entry = {
          status: 'error',
          message: err.status === 404 ? 'Note not found.' : err.message
        };
      }
      noteEmbedCache = { ...noteEmbedCache, [key]: entry };
    }
  }

  function embedNotePath(target, currentPath, files) {
    return resolveWikiLinkPath(
      splitEmbedTarget(target).path,
      currentPath,
      files,
      { dailyNoteFolder: activeDailyNoteFolder }
    );
  }

  function buildNoteEmbedViews(targets, cache, root, currentPath, files) {
    const views = {};

    for (const target of targets ?? []) {
      const { heading } = splitEmbedTarget(target);
      const path = embedNotePath(target, currentPath, files);
      const label = wikiLinkLabel(target);

      if (!path) {
        views[target] = { label, status: 'error', message: 'Invalid link.' };
        continue;
      }
      if (path === currentPath) {
        views[target] = {
          label,
          status: 'error',
          message: 'This note embeds itself.'
        };
        continue;
      }

      const entry = cache[rootPathKey(root, path)];
      if (!entry || entry.status !== 'ready') {
        views[target] = { label, ...(entry ?? { status: 'loading' }) };
        continue;
      }

      const section = sliceNoteSection(entry.content, heading);
      if (heading && !section) {
        views[target] = {
          label,
          status: 'error',
          message: `No section named ${heading}.`
        };
        continue;
      }

      views[target] = {
        label,
        status: 'ready',
        blocks: renderMarkdown(section)
      };
    }

    return views;
  }

  function wikiLinkPath(target) {
    return resolveWikiLinkPath(target, selectedPath, workspaceFiles, {
      dailyNoteFolder: activeDailyNoteFolder
    });
  }

  function wikiLink(target) {
    return resolveWikiLink(target, selectedPath, workspaceFiles, {
      dailyNoteFolder: activeDailyNoteFolder
    });
  }

  function wikiLinkHref(target) {
    const path = wikiLinkPath(target);
    return path ? `#${encodeURI(path)}` : '';
  }

  /**
   * A link whose note is not in the workspace. Marked in the preview rather
   * than left to fail on click: a dead link is usually a typo, and seeing it
   * while reading is what gets it fixed. Media embeds resolve against the
   * upload folder and are left to the image renderer.
   */
  function wikiLinkMissing(target) {
    if (isMediaWikiTarget(target)) return false;
    return !wikiLink(target).exists;
  }

  function wikiLinkTitle(target) {
    const { path, exists } = wikiLink(target);
    return exists ? path : `No note named ${splitWikiTarget(target).path}`;
  }

  async function openWikiLink(event, target) {
    event.preventDefault();
    const { path, heading, exists } = wikiLink(target);
    if (!path) {
      error = `Invalid wiki link: ${target}`;
      return;
    }

    // Opening a note that is not there would show an empty page belonging to no
    // file, so the missing note is offered instead of silently loaded.
    if (!exists) {
      // A date that names a missing daily note (a meeting note's Day link)
      // becomes that day's note, from the daily template like any other.
      const day = dailyNoteDateFor(path);
      const create = await askConfirm(
        day
          ? `No daily note for ${splitWikiTarget(target).path} yet. Create it?`
          : `No note named ${splitWikiTarget(target).path}. Create it?`,
        'Create'
      );
      if (!create) return;
      if (day) await openDailyNote(day);
      else await createNoteAt(path);
      return;
    }

    await openFile(path);
    if (heading) await revealHeading(heading);
  }

  /** Creates an empty note at `path` and opens it, the way a new note starts. */
  async function createNoteAt(path) {
    const root = selectedRoot;
    const title = basename(path).replace(/\.(md|markdown)$/i, '');
    const heading = `# ${title}\n\n`;
    const body = isDateNamedPath(path)
      ? heading
      : stampNoteDates(heading, dailyNoteDate(new Date()));

    try {
      await requestJson('/api/workspace/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path, content: body })
      });
      if (root !== selectedRoot) return;
      rememberEditedFile(path, root);
      await loadTree(root);
      await openFile(path);
    } catch (err) {
      error = err.message;
    }
  }

  /**
   * Puts the `#Section` half of a link on screen: the preview scrolls to the
   * heading, and the editor drops the cursor on it, so the same link lands in
   * the same place whichever pane is open.
   */
  async function revealHeading(heading) {
    const line = findHeadingLine(content, heading);
    if (line === null) {
      error = `No section named ${heading} in this note.`;
      return;
    }

    await revealSourceLine(line);
  }

  /**
   * Puts a source line on screen in whichever pane is open: the preview scrolls
   * to it and marks it, the editor drops the cursor on it ready to type.
   */
  async function revealSourceLine(line) {
    await tick();
    if (viewMode === 'preview') {
      revealPreviewLine(line);
      return;
    }

    const doc = editorView?.state.doc;
    if (!doc) return;

    const docLine = doc.line(Math.min(line + 1, doc.lines));
    editorView.dispatch({
      selection: { anchor: docLine.from },
      effects: EditorView.scrollIntoView(docLine.from, { y: 'center' })
    });
    editorView.focus();
  }

  /**
   * Completions inside `[[ ]]`. Note names come from the workspace tree that
   * is already in memory, so the list opens without a round trip; headings
   * need the target note, which is fetched once and kept.
   */
  async function completeReference(context) {
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);
    const citation = citationCompletionQuery(beforeCursor);
    if (citation) {
      return {
        from: context.pos - citation.length,
        filter: false,
        options: citationCompletions(citation.query, bibliography).map(
          toCompletion
        )
      };
    }

    const query = wikiCompletionQuery(beforeCursor);
    if (!query) return null;

    const from = context.pos - query.length;
    if (query.kind === 'heading') {
      const noteContent = await completionNoteContent(query.note);
      if (noteContent === null) return null;

      return {
        from,
        filter: false,
        options: headingCompletions(query.query, noteContent).map(toCompletion)
      };
    }

    return {
      from,
      // Ranked here against both the name and the folder, so a path fragment
      // finds a note the label alone would not match.
      filter: false,
      options: noteCompletions(query.query, workspaceFiles, selectedPath).map(
        toCompletion
      )
    };
  }

  function toCompletion(option) {
    return {
      label: option.label,
      detail: option.detail,
      apply: option.target
    };
  }

  async function completionNoteContent(note) {
    const path = wikiLinkPath(note);
    if (!path) return null;
    if (path === selectedPath) return content;

    const key = rootPathKey(selectedRoot, path);
    if (completionNotes.has(key)) return completionNotes.get(key);

    let noteContent = null;
    try {
      const file = await requestJson(
        `/api/workspace/load?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(path)}`
      );
      noteContent = file.content;
    } catch {
      noteContent = null;
    }
    completionNotes.set(key, noteContent);
    return noteContent;
  }

  /**
   * The notes linking to the open one. Fetched from the same cached corpus the
   * graph is built from, so it costs no walk of the workspace.
   */
  async function loadBacklinks(root, path) {
    const run = ++backlinksRun;
    backlinks = null;
    backlinksStatus = '';
    if (!path || fileKindForPath(path) !== 'markdown') return;

    try {
      const result = await requestJson(
        `/api/workspace/backlinks?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      );
      if (run !== backlinksRun) return;
      backlinks = result;
    } catch {
      if (run !== backlinksRun) return;
      backlinksStatus = 'Could not load backlinks';
    }
  }

  async function openBacklink(note, mention) {
    await openFile(note.path);
    await revealSourceLine(mention.line);
  }

  /**
   * Opens a dead link where it is written. The graph counts the mentions it
   * cannot draw; this is how they get fixed — the note opens in the editor
   * with the cursor already on the line the link sits on. The mode is not
   * remembered, so it does not quietly replace however notes are usually read.
   */
  async function openBrokenLink(link) {
    await openFile(link.path);
    if (selectedPath !== link.path) return;

    setViewMode('edit', { remember: false });
    await revealSourceLine(link.line);
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
    else if (target.view === 'news') await showNews({ remember: false });
    else if (target.view === 'meetings')
      await showMeetings({ remember: false });
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

  // A fresh tree opens its top-level folders, except those holding more than
  // this many files of their own, which stay folded like everything deeper.
  const CROWDED_FOLDER_FILES = 20;

  function defaultExpandedDirectories(nodes) {
    return nodes
      .filter(
        (node) =>
          node.type === 'directory' &&
          (node.children || []).filter((child) => child.type === 'file')
            .length <= CROWDED_FOLDER_FILES
      )
      .map((node) => node.path);
  }

  function reconcileDailyNoteFolder() {
    if (
      !dailyNoteFolderConfigured &&
      !dailyNoteFolders.includes(dailyNoteFolder)
    )
      dailyNoteFolder = '/';
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

    await showFilesPanel();
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

  // A native confirm()/prompt() is modal to the whole window, and in the
  // standalone app window that dialog never paints: the page just stops
  // answering clicks and keys. Asking inside the page keeps the window alive.
  let askRequest = null;
  let askValue = '';
  let askInput = null;
  let askConfirmButton = null;
  let askResolve = null;

  async function ask(request) {
    // A second question replaces the first rather than stranding whoever is
    // still awaiting it, which would leave that caller hung on a dead promise.
    cancelAsk();
    askRequest = request;
    askValue = request.value ?? '';
    const answer = new Promise((resolve) => {
      askResolve = resolve;
    });
    await tick();
    if (request.kind === 'prompt') {
      askInput?.focus();
      askInput?.select();
    } else {
      askConfirmButton?.focus();
    }

    return answer;
  }

  /** Resolves true when confirmed, false when dismissed. */
  function askConfirm(message, confirmLabel = 'OK') {
    return ask({ kind: 'confirm', message, confirmLabel });
  }

  /** Resolves the entered text, or null when dismissed. */
  function askPrompt(message, value = '', confirmLabel = 'Create') {
    return ask({ kind: 'prompt', message, confirmLabel, value });
  }

  function closeAsk(answer) {
    const resolve = askResolve;
    askRequest = null;
    askResolve = null;
    askValue = '';
    resolve?.(answer);
  }

  function submitAsk() {
    closeAsk(askRequest?.kind === 'prompt' ? askValue.trim() : true);
  }

  function cancelAsk() {
    closeAsk(askRequest?.kind === 'prompt' ? null : false);
  }

  function handleAskKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitAsk();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelAsk();
    }
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

  // An empty query lists the recently edited files, so the palette always
  // opens onto something to pick rather than an empty box.
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

  // The same undo-itself behaviour for a `who:` chip, which narrows the view to
  // one person's work.
  function filterByAssignee(assignee, event) {
    event.stopPropagation();
    const next = `who:${assignee}`;
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
        'a, input, button, summary, .mermaid-block, .code-block-bar, .note-embed-body'
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
    expandedDirs = new Set(defaultExpandedDirectories(workspaceTree));
    loadedTreeOnce = true;
  }
</script>

<!-- One row for the board, sections and urgency views. `age` fades old work on
     the board; `showSource` is off under a heading that already names the file. -->
{#snippet taskItem(task, age, showSource)}
  {@const citation = taskCitation(task)}
  <div
    class={`task-row task-age-${age || 'undated'}`}
    class:task-row-done={task.checked}
  >
    <input
      class="task-complete"
      type="checkbox"
      checked={task.checked}
      disabled={completingTask}
      aria-label={`${task.checked ? 'Reopen' : 'Complete'}: ${task.displayText || task.text}`}
      on:change={() => completeTaskItem(task)}
    />
    <div class="task-row-content">
      <!-- A div rather than a button: the text can contain links and who:
           chips, and neither may sit inside a button. -->
      <div
        class="task-title"
        role="button"
        tabindex="0"
        title={`Open ${task.path}:${task.line + 1}`}
        on:click={(event) => openTask(task, event)}
        on:keydown={(event) => openTaskOnKey(task, event)}
      >
        <span class="task-row-text">
          {#if citation}
            {citation.title}
          {:else}
            {#each taskTextSegments(task.displayText || task.text) as segment}
              {#if segment.type === 'link'}
                <a href={segment.href} rel="noreferrer" target="_blank"
                  >{segment.text}</a
                >
              {:else if segment.type === 'assignee'}
                <button
                  class="task-who"
                  class:task-who-active={taskFilter === `who:${segment.name}`}
                  title={`Filter by who:${segment.name}`}
                  type="button"
                  on:click={(event) => filterByAssignee(segment.name, event)}
                >
                  {segment.text}
                </button>
              {:else}
                {segment.text}
              {/if}
            {/each}
          {/if}
        </span>
      </div>
      <div class="task-row-meta">
        {#if task.priority}
          <span
            aria-label={`${task.priority} priority`}
            class={`task-priority task-priority-${task.priority}`}
            title={`${task.priority} priority`}
          >
            {priorityGlyph(task.priority)}
          </span>
        {/if}
        {#if showSource}
          <span class="task-row-source" title={task.path}>
            {taskSourceLabel(task, activeDailyNoteFolder)}
          </span>
        {/if}
        {#if citation}
          <a
            class="task-paper-link"
            href={citation.href}
            rel="noreferrer"
            target="_blank">Open paper ↗</a
          >
        {/if}
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
        {#if task.checked && task.done}
          <span>Done {formatDueLabel(task.done)}</span>
        {/if}
      </div>
    </div>
  </div>
{/snippet}

{#snippet icon(name)}
  <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
    {#each ICONS[name] as d}
      <path {d} />
    {/each}
  </svg>
{/snippet}

{#snippet newsCard(paper)}
  {@const pick = pickById.get(paper.id)}
  {@const clipped = newsClipped.has(paper.id.toLowerCase())}
  <li
    class="news-paper"
    class:picked={pick}
    class:top-pick={pick && topPickIds.has(paper.id)}
  >
    <div class="news-paper-head">
      <h4 class="news-title-heading">
        <a class="news-title" href={paper.url} rel="noreferrer" target="_blank"
          >{@render inline(newsSegments(paper.title, { links: false }))}</a
        >
      </h4>
      <button
        class="news-clip"
        class:clipped
        disabled={clipped || newsClipping.has(paper.id)}
        title={clipped
          ? 'Already in today’s note'
          : 'Add to the Reading section of today’s note'}
        type="button"
        on:click={() => clipPaper(paper)}
      >
        {@render icon(clipped ? 'check' : 'clip')}
        {clipped
          ? 'Clipped'
          : newsClipping.has(paper.id)
            ? 'Clipping...'
            : 'Clip'}
      </button>
    </div>
    <p class="news-meta">
      <span class="news-authors">{shortAuthorList(paper.authors)}</span>
      <span class="news-id">arXiv:{paper.id}</span>
      {#each paper.categories as category}
        <span
          class="news-category"
          class:followed={newsCategories.includes(category)}>{category}</span
        >
      {/each}
      {#if paper.announceType !== 'new'}
        <span class="news-kind">{paper.announceType}</span>
      {/if}
    </p>
    {#if pick}
      <p class="news-why">
        {#if pick.score}
          <span
            aria-label={`Relevance ${pick.score} out of 10`}
            class="news-score"
            title="How strongly the AI recommends it, out of 10"
            >{pick.score}</span
          >
        {/if}
        {#if pick.connection}
          <span class="news-connection">{pick.connection}</span>
        {/if}
        <span class="news-reason">{pick.reason}</span>
      </p>
    {/if}
    <div class="news-abstract" class:expanded={newsExpanded.has(paper.id)}>
      {@render inline(newsSegments(paper.abstract))}
    </div>
    <button
      aria-expanded={newsExpanded.has(paper.id)}
      class="news-more"
      type="button"
      on:click={() => toggleNewsAbstract(paper.id)}
    >
      {newsExpanded.has(paper.id) ? 'Less' : 'More'}
    </button>
  </li>
{/snippet}

{#snippet inline(segments)}
  {#each segments as segment}
    {#if segment.type === 'code'}
      <code>{segment.text}</code>
    {:else if segment.type === 'math'}
      <span class="math-inline">{@html renderMath(segment.text)}</span>
    {:else if segment.type === 'link' && segment.href}
      <a href={segment.href} rel="noreferrer" target="_blank">{segment.text}</a>
    {:else if segment.type === 'citation'}
      {@const entry = bibliographyByKey.get(segment.key)}
      {@const href = citationUrl(entry)}
      {#if entry && href}
        <a
          class="citation"
          data-card={citationCard(entry)}
          {href}
          rel="noreferrer"
          target="_blank">({citationLabel(entry)})</a
        >
      {:else if entry}
        <span class="citation" data-card={citationCard(entry)}
          >({citationLabel(entry)})</span
        >
      {:else}
        <span
          class="citation citation-missing"
          title={`Missing BibTeX key ${segment.key}`}>{segment.text}</span
        >
      {/if}
    {:else if segment.type === 'wikiLink'}
      <a
        class="wiki-link"
        class:wiki-link-missing={wikiLinkMissing(segment.target)}
        href={wikiLinkHref(segment.target)}
        title={wikiLinkTitle(segment.target)}
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
        <!-- Nothing to embed mid-sentence, so it reads as the link it is
             rather than as dead text. -->
        <a
          class="wiki-link"
          class:wiki-link-missing={wikiLinkMissing(segment.target)}
          href={wikiLinkHref(segment.target)}
          title={wikiLinkTitle(segment.target)}
          on:click={(event) => openWikiLink(event, segment.target)}
          >{segment.text}</a
        >
      {/if}
    {:else if segment.type === 'tag'}
      <span class="tag-chip">#{segment.text}</span>
    {:else if segment.type === 'assignee'}
      <span class="task-who" title={`Assigned to ${segment.text}`}
        >{segment.text}</span
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

{#snippet markdownBlocks(blocks, readOnly = false, embedded = false)}
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
        {#each block.paragraphs as paragraph}
          <p data-line={paragraph.line}>{@render inline(paragraph.children)}</p>
        {/each}
      </blockquote>
    {:else if block.type === 'callout'}
      <aside class={`callout callout-${block.variant}`} data-line={block.line}>
        <p class="callout-title">{@render inline(block.title)}</p>
        {#if block.children.length}
          <div class="callout-body">
            {@render markdownBlocks(block.children, readOnly, embedded)}
          </div>
        {/if}
      </aside>
    {:else if block.type === 'details'}
      <details data-line={block.line}>
        <summary>{@render inline(block.summary)}</summary>
        {@render markdownBlocks(block.children, readOnly, embedded)}
      </details>
    {:else if block.type === 'mathBlock'}
      <div class="math-block" data-line={block.line}>
        {@html renderMath(block.text, true)}
      </div>
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
    {:else if block.type === 'noteEmbed'}
      <!-- One level deep only: inside a card the same token is a link, so a
           note that embeds a note that embeds it cannot spiral. -->
      {#if embedded}
        <p data-line={block.line}>
          <a
            class="wiki-link"
            class:wiki-link-missing={wikiLinkMissing(block.target)}
            href={wikiLinkHref(block.target)}
            title={wikiLinkTitle(block.target)}
            on:click={(event) => openWikiLink(event, block.target)}
            >{block.text}</a
          >
        </p>
      {:else}
        {@const view = noteEmbedViews[block.target]}
        <aside class="note-embed" data-line={block.line}>
          <header class="note-embed-header">
            <a
              class="wiki-link"
              class:wiki-link-missing={wikiLinkMissing(block.target)}
              href={wikiLinkHref(block.target)}
              title={wikiLinkTitle(block.target)}
              on:click={(event) => openWikiLink(event, block.target)}
              >{view?.label ?? block.text}</a
            >
            {#if view?.status === 'loading'}
              <span class="note-embed-status">Loading...</span>
            {/if}
          </header>
          <!-- Read-only, and marked so a double-click here never jumps the
               editor: these lines number a different file. -->
          <div class="note-embed-body">
            {#if view?.status === 'error'}
              <p class="preview-empty">{view.message}</p>
            {:else if view?.blocks?.length}
              {@render markdownBlocks(view.blocks, true, true)}
            {:else if view?.status === 'ready'}
              <p class="preview-empty">Nothing to preview</p>
            {/if}
          </div>
        </aside>
      {/if}
    {:else if block.type === 'list'}
      {@render markdownList(block, readOnly)}
    {/if}
  {/each}
{/snippet}

<!-- Its own snippet so it can render itself: a sub-list is a list block
     hanging off the item above it, at any depth. -->
{#snippet markdownList(block, readOnly = false)}
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
        {#if item.list}
          {#each item.list as sublist}
            {@render markdownList(sublist, readOnly)}
          {/each}
        {/if}
      </li>
    {/each}
  </svelte:element>
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

<svelte:window
  bind:innerWidth={viewportWidth}
  on:keydown={handleShortcut}
  on:mousedown={handleMouseNavigation}
  on:mouseup={handleMouseNavigation}
  on:auxclick={handleMouseNavigation}
/>

<main
  bind:this={appShell}
  class:markdown-hidden={markdownViewsCollapsed}
  class:narrow-layout={layout.narrow}
  class="app-shell"
  style:grid-template-columns={shellColumns}
  style:--files-width={`${layout.filesWidth}px`}
  style:--ai-width={`${layout.aiWidth}px`}
>
  <nav class="global-bar" aria-label="Global actions">
    <span aria-hidden="true" class="rail-mark">W</span>
    <button
      aria-label="Open dashboard"
      class:active={!selectedPath && viewMode === 'edit'}
      class="global-action"
      data-tooltip="Dashboard"
      disabled={!workspaceRoots.length}
      type="button"
      on:click={showHome}
    >
      {@render icon('home')}
    </button>
    <button
      aria-label="Open today’s note"
      class:active={selectedPath === todayNotePath() &&
        !WORKSPACE_VIEWS.has(viewMode)}
      class="global-action today-launcher"
      data-tooltip={`Today’s note (${shortcutKey}+Shift+D)`}
      disabled={!workspaceRoots.length}
      type="button"
      on:click={() => openDailyNote()}
    >
      {@render icon('today')}
    </button>
    <button
      aria-controls="files-panel"
      aria-expanded={filesShown}
      aria-label={filesShown ? 'Hide file sidebar' : 'Show file sidebar'}
      class:active={filesShown}
      class="global-action"
      data-tooltip={filesShown ? 'Hide files' : 'Show files'}
      type="button"
      on:click={() => toggleLayoutPanel('files')}
    >
      {@render icon('folder')}
    </button>
    <button
      aria-label="Open daily notes calendar"
      class:active={viewMode === 'calendar'}
      class="global-action calendar-launcher"
      data-tooltip="Daily notes calendar"
      disabled={!workspaceRoots.length}
      type="button"
      on:click={() => showCalendar()}
    >
      {@render icon('calendar')}
    </button>
    <button
      aria-label="Open tasks"
      class:active={viewMode === 'tasks'}
      class="global-action tasks-launcher"
      data-tooltip={`Tasks (${shortcutKey}+Shift+T)`}
      disabled={!workspaceRoots.length}
      type="button"
      on:click={() => showTasks()}
    >
      {@render icon('tasks')}
    </button>
    <button
      aria-label="Open arXiv news"
      class:active={viewMode === 'news'}
      class="global-action news-launcher"
      data-tooltip="arXiv news"
      disabled={!workspaceRoots.length}
      type="button"
      on:click={() => showNews()}
    >
      {@render icon('news')}
    </button>
    <button
      aria-label="Open meetings"
      class:active={viewMode === 'meetings'}
      class="global-action meetings-launcher"
      data-tooltip="Meetings"
      disabled={!workspaceRoots.length}
      type="button"
      on:click={() => showMeetings()}
    >
      {@render icon('meetings')}
    </button>
    <button
      aria-controls="ai-panel"
      aria-expanded={aiShown}
      aria-label={aiShown ? 'Hide AI assistant' : 'Show AI assistant'}
      class:active={aiShown}
      class="global-action"
      data-tooltip={aiShown ? 'Hide AI assistant' : 'AI assistant'}
      type="button"
      on:click={() => toggleLayoutPanel('ai')}
    >
      {@render icon('sparkles')}
    </button>
  </nav>

  <!-- Escape anywhere inside closes the panel's overlay. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <aside
    bind:this={filesPanel}
    aria-label="Workspace files"
    class:panel-overlay={layout.files === 'overlay'}
    class:sidebar-closed={!filesShown}
    class="sidebar"
    id="files-panel"
    tabindex="-1"
    on:keydown={(event) => closeOverlayOnEscape('files', event)}
  >
    <div class="workspace-row">
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
      <button
        aria-controls="files-panel"
        aria-expanded="true"
        aria-label="Collapse file sidebar"
        class="panel-close-button"
        title="Collapse file sidebar"
        type="button"
        on:click={() => hideLayoutPanel('files')}
      >
        {@render icon(layout.files === 'overlay' ? 'close' : 'panelLeft')}
      </button>
    </div>
    <div class="sidebar-title">
      <span>Files</span>
      <span class="sidebar-count">{fileCount} files</span>
      <div class="sidebar-title-actions">
        <button
          aria-label="Create markdown note"
          class="sync-button"
          title="Create markdown note"
          type="button"
          on:click={createMarkdownNote}
        >
          New
        </button>
        <div class="files-menu">
          <button
            aria-expanded={filesMenuOpen}
            aria-haspopup="menu"
            aria-label="More file actions"
            class="sidebar-icon-button"
            title="More file actions"
            type="button"
            on:click={() => (filesMenuOpen = !filesMenuOpen)}
            on:keydown={closeFilesMenuOnEscape}
          >
            {@render icon('more')}
          </button>
          {#if filesMenuOpen}
            <button
              aria-label="Close file actions"
              class="view-menu-backdrop"
              tabindex="-1"
              type="button"
              on:click={() => (filesMenuOpen = false)}
            ></button>
            <div
              class="view-menu-list files-menu-list"
              role="menu"
              tabindex="-1"
              on:keydown={closeFilesMenuOnEscape}
            >
              <button
                role="menuitem"
                type="button"
                on:click={() => runFilesMenu(syncWorkspace)}
              >
                {@render icon('refresh')} Sync files
              </button>
              <button
                disabled={!selectedPath}
                role="menuitem"
                type="button"
                on:click={() => runFilesMenu(revealSelectedFileInSidebar)}
              >
                {@render icon('file')} Show current file
              </button>
              <hr class="view-menu-divider" />
              <button
                role="menuitem"
                type="button"
                on:click={() => runFilesMenu(collapseAll)}
              >
                {@render icon('collapseAll')} Collapse all folders
              </button>
              <button
                role="menuitem"
                type="button"
                on:click={() => runFilesMenu(expandAll)}
              >
                {@render icon('expandAll')} Expand all folders
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
    <div class="sidebar-search">
      {@render icon('search')}
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
    </div>

    {#if searchQuery.trim()}
      <div class="search-results" aria-live="polite">
        {#each searchResults as result}
          <button
            class:active={result.path === selectedPath}
            class="search-result"
            type="button"
            on:click={() => {
              openSearchResult(result);
              closeFilesOverlayAfterOpen();
            }}
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
                {@render icon('close')}
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
            on:click={() => {
              if (node.type === 'directory') return toggleFolder(node.path);
              openFile(node.path);
              closeFilesOverlayAfterOpen();
            }}
          >
            <span aria-hidden="true" class="tree-twisty"
              >{#if node.type === 'directory'}{@render icon(
                  'chevronRight'
                )}{/if}</span
            >
            <span aria-hidden="true" class="tree-icon"
              >{@render icon(
                node.type === 'directory' ? 'folder' : 'file'
              )}</span
            >
            <span class="tree-name">{node.name}</span>
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
    <footer class={`sidebar-status sidebar-status-${saveView.tone}`}>
      <span aria-hidden="true" class="sidebar-status-dot"></span>
      <span role="status">{saveView.label}</span>
    </footer>
    {#if layout.files === 'docked'}
      <!-- A focusable separator is the ARIA window-splitter pattern. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        aria-controls="files-panel"
        aria-label="Resize file sidebar"
        aria-orientation="vertical"
        aria-valuemax={WIDTH_LIMITS.files.max}
        aria-valuemin={WIDTH_LIMITS.files.min}
        aria-valuenow={layout.filesWidth}
        class="resize-handle resize-handle-files"
        role="separator"
        tabindex="0"
        title="Drag or use arrow keys to resize. Double-click to reset."
        on:dblclick={() => resetPanelWidth('files')}
        on:keydown={(event) => resizePanelByKey('files', event)}
        on:pointerdown={(event) => startPanelResize('files', event)}
      ></div>
    {/if}
  </aside>

  <section
    class="workspace"
    inert={modalPanelOpen}
    on:focusin={trackWorkspaceFocus}
  >
    <header class:compact={!documentControls} class="topbar">
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
            {@render icon('chevronLeft')}
          </button>
          <button
            aria-label="Go forward"
            class="history-button"
            disabled={!canNavigateForward}
            title="Go forward"
            type="button"
            on:click={navigateForward}
          >
            {@render icon('chevronRight')}
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
          {#if toolbarFolder}<span class="current-file-folder"
              >{toolbarFolder}</span
            >{/if}<span class="current-file-name">{toolbarName}</span>
        </button>
      </div>
      <div class="topbar-actions">
        <input
          bind:this={uploadInput}
          class="hidden"
          type="file"
          accept="image/*,application/pdf,.pdf"
          multiple
          on:change={chooseUploadFiles}
        />
        {#if documentControls}
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
              {@render icon('chevronLeft')}
            </button>
            <span aria-hidden="true">Day</span>
            <button
              aria-label="Open the next daily note"
              disabled={!newerDailyNotePath}
              title={newerDailyNotePath
                ? `Newer daily note (${newerDailyNotePath})`
                : 'No newer daily note'}
              type="button"
              on:click={openNewerDailyNote}
            >
              {@render icon('chevronRight')}
            </button>
          </div>
          {#if selectedPath}
            <div class="view-toggle" aria-label="View mode">
              <button
                class:active={viewMode === 'edit' && selectedIsMarkdown}
                disabled={!selectedIsMarkdown}
                type="button"
                on:click={() => setViewMode('edit')}
              >
                Edit
              </button>
              <button
                class:active={viewMode === 'preview'}
                type="button"
                on:click={() => setViewMode('preview')}
              >
                Preview
              </button>
            </div>
          {/if}
        {/if}
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
            {@render icon('more')}
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
              {#if documentControls}
                <button
                  class:active={viewMode === 'diff' && selectedIsMarkdown}
                  disabled={!selectedPath || !selectedIsMarkdown}
                  role="menuitem"
                  type="button"
                  on:click={chooseDiffView}
                >
                  Diff
                </button>
              {/if}
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
              {#if viewMode === 'tasks'}
                <hr class="view-menu-divider" />
                {#if taskGrouping !== 'urgency'}
                  <button
                    aria-pressed={editingSections}
                    class:active={editingSections}
                    role="menuitem"
                    type="button"
                    on:click={() => {
                      closeViewMenu();
                      editingSections = !editingSections;
                    }}
                  >
                    Edit sections
                  </button>
                {/if}
                <button
                  role="menuitem"
                  type="button"
                  on:click={() => {
                    closeViewMenu();
                    loadTasks(selectedRoot);
                  }}
                >
                  Refresh tasks
                </button>
              {/if}
              {#if documentControls}
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
                  class="view-menu-danger"
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

    {#if calendarDetail}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="markdown-help-layer" on:keydown={closeCalendarDetailOnEscape}>
        <button
          aria-label="Close meeting details"
          class="markdown-help-backdrop"
          tabindex="-1"
          type="button"
          on:click={() => (calendarDetail = null)}
        ></button>
        <dialog
          aria-label="Meetings on {calendarDayLabel(calendarDetail.day)}"
          class="markdown-help calendar-detail"
          open
        >
          <header>
            <h2>{calendarDayLabel(calendarDetail.day)}</h2>
            <button
              bind:this={calendarDetailClose}
              aria-label="Close meeting details"
              title="Close"
              type="button"
              on:click={() => (calendarDetail = null)}
            >
              {@render icon('close')}
            </button>
          </header>
          <ul>
            {#each calendarDetail.events as event, index}
              <li>
                <details open={index === calendarDetail.open}>
                  <summary>
                    <span>{eventTimeRange(event)}</span>
                    <strong>{event.title}</strong>
                  </summary>
                  <dl>
                    {#if event.url}
                      <div>
                        <dt>Join</dt>
                        <dd>
                          <a href={event.url} rel="noreferrer" target="_blank"
                            >{event.url}</a
                          >
                        </dd>
                      </div>
                    {/if}
                    {#if event.location}
                      <div>
                        <dt>Where</dt>
                        <dd>
                          {#each linkParts(event.location) as part}{#if part.url}<a
                                href={part.url}
                                rel="noreferrer"
                                target="_blank">{part.text}</a
                              >{:else}{part.text}{/if}{/each}
                        </dd>
                      </div>
                    {/if}
                    {#if event.organizer}
                      <div>
                        <dt>Organizer</dt>
                        <dd>{event.organizer}</dd>
                      </div>
                    {/if}
                    {#if event.attendees?.length}
                      <div>
                        <dt>Guests ({event.attendees.length})</dt>
                        <dd>{event.attendees.join(', ')}</dd>
                      </div>
                    {/if}
                    {#if event.description}
                      <div>
                        <dt>Description</dt>
                        <dd class="calendar-detail-description">
                          {#each linkParts(event.description) as part}{#if part.url}<a
                                href={part.url}
                                rel="noreferrer"
                                target="_blank">{part.text}</a
                              >{:else}{part.text}{/if}{/each}
                        </dd>
                      </div>
                    {/if}
                  </dl>
                  <div class="calendar-detail-actions">
                    <button
                      type="button"
                      on:click={() =>
                        addMeetingToDayNote(calendarDetail.day, event)}
                    >
                      Add to the day's note
                    </button>
                    <!-- A label, so the native file picker opens without script. -->
                    <label
                      title="Zoom's audio transcript (.vtt), or .srt / .txt captions"
                    >
                      Add transcript…
                      <input
                        accept=".vtt,.srt,.txt,text/vtt,text/plain"
                        hidden
                        type="file"
                        on:change={(changed) =>
                          addCalendarTranscript(
                            calendarDetail.day,
                            event,
                            changed.currentTarget
                          )}
                      />
                    </label>
                    <button
                      title="AI minutes and action items from the transcript"
                      type="button"
                      on:click={() =>
                        summarizeCalendarMeeting(calendarDetail.day, event)}
                    >
                      Summarize
                    </button>
                  </div>
                </details>
              </li>
            {/each}
          </ul>
          <footer>
            <button
              type="button"
              on:click={() => {
                const { day } = calendarDetail;
                calendarDetail = null;
                openDailyNote(day.date);
              }}
            >
              Open the day's note
            </button>
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
              {@render icon('close')}
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
              <dt>Task assignee</dt>
              <dd>
                <code>- [ ] who:julien and who:jack will ship it</code>
                the names stay in the sentence; filter the Tasks view with
                <code>who:julien</code>; open tasks with no name get
                <code>who:me</code> and no due date get <code>due:+7d</code>
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
              <dt>Snippets</dt>
              <dd>
                type one and press <code>Tab</code>
                {#each SNIPPETS as snippet}
                  <code title={snippet.hint}>/{snippet.name}</code>
                {/each}
              </dd>
            </div>
            <div>
              <dt>Shortcuts</dt>
              <dd>
                <code>{shortcutKey}+Shift+D</code> today’s note
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

    {#if askRequest}
      <div class="ask-layer">
        <button
          aria-label="Cancel"
          class="ask-backdrop"
          type="button"
          on:click={cancelAsk}
        ></button>
        <dialog aria-label={askRequest.message} class="ask" open>
          <p>{askRequest.message}</p>
          {#if askRequest.kind === 'prompt'}
            <input
              bind:this={askInput}
              bind:value={askValue}
              aria-label={askRequest.message}
              type="text"
              on:keydown={handleAskKeydown}
            />
          {/if}
          <footer>
            <button
              type="button"
              on:click={cancelAsk}
              on:keydown={handleAskKeydown}>Cancel</button
            >
            <button
              bind:this={askConfirmButton}
              class="primary"
              type="button"
              on:click={submitAsk}
              on:keydown={handleAskKeydown}>{askRequest.confirmLabel}</button
            >
          </footer>
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

            {#if dailyQuote}
              <blockquote class="home-quote">{dailyQuote}</blockquote>
            {/if}

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
                    Edit a note and it will stay within reach here.
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
              <div class="tasks-summary">
                <span>
                  {openTaskCount - referenceCount} open tasks · {referenceCount}
                  {referenceCount === 1
                    ? 'reference'
                    : 'references'}{showCompletedTasks
                    ? `, ${doneTaskCount} done`
                    : ''}{hiddenTaskCount
                    ? ` · ${hiddenTaskCount} filtered out`
                    : ''}
                </span>
                <div class="search-field">
                  {@render icon('search')}
                  <input
                    class="tasks-filter"
                    type="search"
                    placeholder="Search tasks and references"
                    aria-label="Filter tasks"
                    title={'Filter by text, #tag, or who:name — who: alone shows everything assigned'}
                    bind:this={taskFilterInput}
                    bind:value={taskFilter}
                    on:keydown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      if (taskFilter) taskFilter = '';
                      else event.currentTarget.blur();
                    }}
                  />
                </div>
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
                {#if editingSections && taskGrouping !== 'urgency'}
                  <button
                    type="button"
                    on:click={() => (editingSections = false)}
                  >
                    Done editing
                  </button>
                {/if}
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
                              {@render taskItem(card.task, card.age, true)}
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
                        {group.kind === 'file'
                          ? readableTaskSource(group.label)
                          : group.label}
                      </h4>
                    {/if}
                    <ul>
                      {#each group.tasks as task}
                        <li>
                          {@render taskItem(task, '', group.kind !== 'file')}
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
                No matching items. Clear your filters or write <code
                  >- [ ] something</code
                > in a note.
              </p>
            {/if}
          </section>
        {/if}
        {#if viewMode === 'news'}
          <section class="news-pane" aria-label="arXiv news">
            <header class="tasks-toolbar news-toolbar">
              <h2>
                arXiv
                {#if newsDayOptions.length > 1}
                  <span class="news-days" role="group" aria-label="Listing day">
                    <button
                      aria-label="Earlier day"
                      data-tooltip="Earlier day"
                      disabled={!olderNewsDay}
                      type="button"
                      on:click={() => selectNewsDay(olderNewsDay)}
                    >
                      {@render icon('chevronLeft')}
                    </button>
                    <select
                      aria-label="Show the listing of"
                      title="Listings of the last month are kept"
                      value={newsShownDay}
                      on:change={(event) =>
                        selectNewsDay(event.currentTarget.value)}
                    >
                      {#each newsDayOptions as day (day)}
                        <option value={day}
                          >{newsDayLabel(day)}{day === newsLatestDay
                            ? ' · latest'
                            : ''}</option
                        >
                      {/each}
                    </select>
                    <button
                      aria-label="Later day"
                      data-tooltip="Later day"
                      disabled={!newerNewsDay}
                      type="button"
                      on:click={() => selectNewsDay(newerNewsDay)}
                    >
                      {@render icon('chevronRight')}
                    </button>
                  </span>
                {:else if newsPublished}
                  <span class="news-date"
                    >{newsPublished.replace(/ \d\d:\d\d:\d\d.*$/, '')}</span
                  >
                {/if}
              </h2>
              <div class="tasks-summary">
                <span>
                  {visiblePapers.length} papers{hiddenReplacementCount
                    ? ` · ${hiddenReplacementCount} updates hidden`
                    : ''}
                </span>
                <div
                  class="tasks-grouping"
                  role="group"
                  aria-label="Order papers"
                >
                  <button
                    type="button"
                    class:active={newsFilter.sort !== 'arxiv'}
                    aria-pressed={newsFilter.sort !== 'arxiv'}
                    title="AI picks first, then by how closely each paper matches your notes"
                    on:click={() => setNewsFilter({ sort: 'rank' })}
                  >
                    For you
                  </button>
                  <button
                    type="button"
                    class:active={newsFilter.sort === 'arxiv'}
                    aria-pressed={newsFilter.sort === 'arxiv'}
                    title="The order arXiv lists them in"
                    on:click={() => setNewsFilter({ sort: 'arxiv' })}
                  >
                    arXiv
                  </button>
                </div>
                <div class="search-field news-filter">
                  {@render icon('search')}
                  <input
                    class="tasks-filter"
                    type="search"
                    placeholder="Filter papers"
                    aria-label="Filter papers"
                    title="Every word must appear in the title, authors, or abstract"
                    value={newsFilter.query}
                    on:input={(event) =>
                      setNewsFilter({ query: event.currentTarget.value })}
                  />
                </div>
                <label class="tasks-toggle">
                  <input
                    type="checkbox"
                    checked={newsFilter.includeReplacements}
                    on:change={(event) =>
                      setNewsFilter({
                        includeReplacements: event.currentTarget.checked
                      })}
                  />
                  Updates
                </label>
                <button
                  type="button"
                  title="Edit what the AI ranks papers against"
                  on:click={openNewsInstructions}
                >
                  Instructions
                </button>
                <button
                  class="primary"
                  type="button"
                  title="Fetch the listing from arXiv again"
                  on:click={refreshNews}
                >
                  {@render icon('refresh')}
                  Refresh
                </button>
              </div>
              <div
                class="news-categories"
                role="group"
                aria-label="Show categories"
              >
                {#each newsCategories as category}
                  <button
                    type="button"
                    class:active={newsFilter.categories.includes(category)}
                    aria-pressed={newsFilter.categories.includes(category)}
                    on:click={() => toggleNewsCategory(category)}
                  >
                    {category} <span>{newsCounts.get(category) ?? 0}</span>
                  </button>
                {/each}
              </div>
            </header>
            {#if newsStatus || newsWarning}
              <p class="tasks-note">
                {newsStatus || `Showing the last listing: ${newsWarning}`}
              </p>
            {/if}
            {#if newsRankStatus || newsRanking?.warning}
              <p class="tasks-note news-rank-note">
                {newsRankStatus || newsRanking.warning}
              </p>
            {/if}
            {#if pickedPapers.length}
              <h3 class="news-section">
                Top picks <span>{topPapers.length}</span>
                <i aria-hidden="true" class="news-section-rule"></i>
                <button
                  type="button"
                  title="Ask the AI to rank these papers again"
                  disabled={!!newsRankStatus}
                  on:click={() => rankNews({ refresh: true })}
                >
                  Re-rank
                </button>
              </h3>
              <ol class="news-list">
                {#each topPapers as paper (paper.id)}
                  {@render newsCard(paper)}
                {/each}
              </ol>
              {#if morePicks.length}
                <h3 class="news-section">
                  Also relevant <span>{morePicks.length}</span>
                  <i aria-hidden="true" class="news-section-rule"></i>
                </h3>
                <ol class="news-list">
                  {#each morePicks as paper (paper.id)}
                    {@render newsCard(paper)}
                  {/each}
                </ol>
              {/if}
              <h3 class="news-section">
                Everything else <span>{otherPapers.length}</span>
                <i aria-hidden="true" class="news-section-rule"></i>
              </h3>
            {/if}
            <ol class="news-list">
              {#each otherPapers as paper (paper.id)}
                {@render newsCard(paper)}
              {:else}
                {#if !newsStatus && !pickedPapers.length}
                  <li class="preview-empty">
                    {newsPapers.length
                      ? 'No paper matches this filter.'
                      : `arXiv has no announcements today. It publishes none on weekends.${newsDays.length ? ' Earlier days are in the day menu above.' : ''}`}
                  </li>
                {/if}
              {/each}
            </ol>
          </section>
        {/if}
        {#if meetingsVisited}
          <MeetingsView
            active={viewMode === 'meetings'}
            onOpenNote={openMeetingNote}
            onFilesChanged={() => loadTree(selectedRoot)}
            root={selectedRoot}
            timeZone={meetingTimeZone || undefined}
          />
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
                  {@render icon('chevronLeft')}
                </button>
                <h2>{calendarMonthName}</h2>
                <button
                  aria-label="Next month"
                  type="button"
                  on:click={() => moveCalendarMonth(1)}
                >
                  {@render icon('chevronRight')}
                </button>
              </div>
              <div class="calendar-controls">
                <button type="button" on:click={showCurrentMonth}>Today</button>
              </div>
              {#if dailyNoteFolderMissing}
                <p class="calendar-folder-warning">
                  Using / because {dailyNoteFolder}, set in
                  .webmd/settings.json, is not in this workspace.
                </p>
              {/if}
              {#if dailyNoteTemplateMissing && dailyNoteTemplatePath}
                <p class="calendar-folder-warning">
                  New daily notes start empty because {dailyNoteTemplatePath},
                  set in .webmd/settings.json, does not exist.
                </p>
              {/if}
              {#if settingsWarning}
                <p class="calendar-folder-warning">{settingsWarning}</p>
              {/if}
              {#if calendarEventsError}
                <p class="calendar-folder-warning">{calendarEventsError}</p>
              {/if}
            </header>
            <div class="calendar-grid" aria-label={calendarMonthName}>
              {#each WEEK_DAYS as weekday}
                <span class="calendar-weekday">{weekday}</span>
              {/each}
              {#each calendarDays as day}
                {@const path = calendarDayPath(day)}
                {@const hasNote = dailyNotePaths.has(path)}
                {@const dateText = dailyNoteDate(day.date)}
                {@const dayEvents = calendarEventsOnDay.get(dateText) ?? []}
                <div class="calendar-cell">
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
                  </button>
                  {#if dayEvents.length}
                    <!-- Beside the day button, not in it: an event opens its
                         details, the rest of the cell still opens the note. -->
                    <ul
                      class="calendar-events"
                      class:outside-month={!day.currentMonth}
                    >
                      {#each dayEvents.slice(0, 3) as event, index}
                        <li class:all-day={event.allDay}>
                          <button
                            type="button"
                            on:click={() =>
                              openCalendarDetail(day, dayEvents, index)}
                          >
                            {calendarEventLabel(event)}
                          </button>
                        </li>
                      {/each}
                      {#if dayEvents.length > 3}
                        <li class="calendar-events-more">
                          <button
                            type="button"
                            on:click={() => openCalendarDetail(day, dayEvents)}
                          >
                            +{dayEvents.length - 3} more
                          </button>
                        </li>
                      {/if}
                    </ul>
                  {/if}
                </div>
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
                  >{graphView.nodes.length} nodes · {graphView.edges.length} links</span
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
                        <title>{node.summary || node.path}</title>
                      </g>
                    {/each}
                  </g>
                </svg>
              {/if}
            </div>
            {#if graphData.unresolved}
              <footer class="graph-broken">
                <button
                  aria-expanded={brokenLinksOpen}
                  class="graph-broken-toggle"
                  type="button"
                  on:click={() => (brokenLinksOpen = !brokenLinksOpen)}
                >
                  {brokenLinksOpen ? '▾' : '▸'}
                  {graphData.unresolved} unresolved wiki-link {graphData.unresolved ===
                  1
                    ? 'mention is'
                    : 'mentions are'} not drawn
                </button>
                {#if brokenLinksOpen}
                  <ul class="graph-broken-list">
                    {#each graphData.broken ?? [] as link}
                      <li>
                        <button
                          type="button"
                          on:click={() => openBrokenLink(link)}
                          title={`${link.path}, line ${link.line + 1}`}
                        >
                          <span class="graph-broken-note">{link.name}</span>
                          <span class="graph-broken-target"
                            >[[{link.target}]]</span
                          >
                        </button>
                      </li>
                    {/each}
                    {#if (graphData.broken?.length ?? 0) < graphData.unresolved}
                      <li class="graph-broken-more">
                        Showing the first {graphData.broken.length}.
                      </li>
                    {/if}
                  </ul>
                {/if}
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
              <!-- The bar doubles as the way into the work it is measuring:
                   clicking it scrolls to the first box still to be ticked. With
                   nothing left open there is nowhere to go, so it is inert. -->
              <button
                aria-label={firstOpenTask
                  ? `${noteProgress.done} of ${noteProgress.total} tasks done. Go to the first unfinished task`
                  : `${noteProgress.done} of ${noteProgress.total} tasks done`}
                class="task-progress"
                disabled={!firstOpenTask}
                title={firstOpenTask ? 'Go to the first unfinished task' : ''}
                type="button"
                on:click={() => revealPreviewLine(firstOpenTask.line)}
              >
                <div class="task-progress-track">
                  <div
                    class="task-progress-fill"
                    style={`width: ${Math.round((noteProgress.done / noteProgress.total) * 100)}%`}
                  ></div>
                </div>
                <span>{noteProgress.done}/{noteProgress.total} done</span>
              </button>
            {/if}
            {#if renderedBlocks.length}
              {@render markdownBlocks(renderedBlocks)}
            {:else}
              <p class="preview-empty">Empty file</p>
            {/if}
            {#if citedReferences.length}
              <section class="references" aria-label="References">
                <h2>References</h2>
                <ol>
                  {#each citedReferences as reference}
                    <li id={`reference-${reference.key}`}>
                      {#if reference.entry}
                        {@const href = citationUrl(reference.entry)}
                        {#if href}
                          <a {href} rel="noreferrer" target="_blank"
                            >{reference.entry.title || reference.key}</a
                          >
                        {:else}
                          <span>{reference.entry.title || reference.key}</span>
                        {/if}
                        <small>
                          {[
                            citationAuthors(reference.entry),
                            reference.entry.year,
                            citationVenue(reference.entry)
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          {#if reference.entry.arxiv}
                            ·
                            <a
                              href={`https://arxiv.org/abs/${reference.entry.arxiv}`}
                              rel="noreferrer"
                              target="_blank"
                              >{citationArxiv(reference.entry)}</a
                            >
                          {/if}
                        </small>
                      {:else}
                        <span class="citation-missing"
                          >Missing BibTeX key: {reference.key}</span
                        >
                      {/if}
                    </li>
                  {/each}
                </ol>
              </section>
            {/if}
            {#if backlinksStatus}
              <p class="backlinks-status">{backlinksStatus}</p>
            {:else if backlinks && backlinks.total}
              <section class="backlinks" aria-label="Linked mentions">
                <button
                  aria-expanded={backlinksOpen}
                  class="backlinks-toggle"
                  type="button"
                  on:click={() => (backlinksOpen = !backlinksOpen)}
                >
                  {backlinksOpen ? '▾' : '▸'}
                  {backlinks.total}
                  {backlinks.total === 1 ? 'linked mention' : 'linked mentions'}
                  in {backlinks.notes.length}
                  {backlinks.notes.length === 1 ? 'note' : 'notes'}
                </button>
                {#if backlinksOpen}
                  <ul class="backlinks-list">
                    {#each backlinks.notes as note}
                      <li class="backlinks-note">
                        <a
                          class="wiki-link"
                          href={`#${encodeURI(note.path)}`}
                          title={note.path}
                          on:click|preventDefault={() => openFile(note.path)}
                          >{note.name}</a
                        >
                        <ul class="backlinks-mentions">
                          {#each note.mentions as mention}
                            <li>
                              <button
                                class="backlinks-mention"
                                type="button"
                                on:click={() => openBacklink(note, mention)}
                                >{mention.text}</button
                              >
                            </li>
                          {/each}
                        </ul>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
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
        {#if filingPanel && filingPanel.root === selectedRoot && filingPanel.path === selectedPath}
          <section class="inline-edit-panel" aria-label="File to projects">
            <header class="inline-edit-header">
              <strong>
                {#if filingPanel.step === 'review'}
                  Projects this day touched
                {:else if filingPanel.step === 'walk'}
                  Filing {filingPanel.index + 1} of {filingPanel.queue.length}
                {:else}
                  Done filing
                {/if}
              </strong>
              <div class="inline-edit-actions">
                <button type="button" on:click={dismissProjectFiling}>
                  {filingPanel.step === 'done' ? 'Close' : 'Cancel'}
                </button>
                {#if filingPanel.step === 'review' && filingPanel.entries.length}
                  <button
                    class="primary"
                    disabled={!filingPanel.selected.size}
                    type="button"
                    on:click={startProjectFiling}
                  >
                    Review {filingPanel.selected.size} one by one
                  </button>
                {:else if filingPanel.step === 'walk'}
                  <button
                    disabled={filingPanel.busy}
                    type="button"
                    on:click={skipFilingEntry}
                  >
                    Skip
                  </button>
                  <button
                    class="primary"
                    disabled={filingPanel.busy}
                    type="button"
                    on:click={fileProjectEntry}
                  >
                    {filingPanel.busy ? 'Filing...' : 'File it'}
                  </button>
                {/if}
              </div>
            </header>
            <div class="related-body">
              {#if filingPanel.warning}
                <p class="ai-preset-warning">{filingPanel.warning}</p>
              {/if}

              {#if filingPanel.step === 'review'}
                {#if filingPanel.entries.length}
                  <ul class="related-list">
                    {#each filingPanel.entries as entry}
                      <li class="related-item">
                        <label class="related-choice">
                          <input
                            checked={filingPanel.selected.has(entry.path)}
                            type="checkbox"
                            on:change={() => toggleFilingEntry(entry)}
                          />
                          <span class="related-bullet">{entry.title}</span>
                        </label>
                        <span class="related-path">{entry.path}</span>
                      </li>
                    {/each}
                  </ul>
                  <p class="related-note">
                    Nothing is written yet. Each note you keep is shown on its
                    own, with the line it would gain, before anything changes.
                  </p>
                {:else}
                  <p class="empty-copy">
                    No project note looked like this day advanced it.
                  </p>
                {/if}
                {#if filingPanel.filed.length}
                  <p class="related-note">
                    Already linked to this day, so left alone: {filingPanel
                      .filed.length} note{filingPanel.filed.length === 1
                      ? ''
                      : 's'}.
                  </p>
                {/if}
              {:else if filingPanel.step === 'walk'}
                {@const entry = filingPanel.queue[filingPanel.index]}
                <p class="filing-target">
                  <strong>{entry.title}</strong>
                  <span class="related-path">{entry.path}</span>
                </p>
                <pre class="filing-bullet">{filingBulletText(entry)}</pre>
                <p class="related-note">
                  Appended under <code>## {PROJECT_LOG_HEADING}</code>, added at
                  the end of that note if it has none. Nothing else in it
                  changes.
                </p>
              {:else}
                <ul class="related-list">
                  {#each filingPanel.results as result}
                    <li class="related-item filing-result">
                      <span class="related-bullet">
                        {result.state === 'filed'
                          ? 'Filed'
                          : result.state === 'already'
                            ? 'Already there'
                            : 'Skipped'}
                      </span>
                      <span class="related-path">{result.path}</span>
                    </li>
                  {/each}
                </ul>
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
                {@render icon('chevronLeft')}
              </button>
              <button
                aria-label="Newer reference note"
                disabled={!newerReferencePath}
                title="Newer note"
                type="button"
                on:click={() => stepReferenceNote(1)}
              >
                {@render icon('chevronRight')}
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
              {@render icon('close')}
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
      <!-- The sidebar footer owns the save status; it only moves down here
           while the sidebar is hidden, so one is ever on screen. -->
      {#if !filesShown}
        <span class={`statusbar-save sidebar-status-${saveView.tone}`}>
          <span aria-hidden="true" class="sidebar-status-dot"></span>
          <span role="status">{saveView.label}</span>
        </span>
      {/if}
      <span class="statusbar-selection"
        >Selected text: {selectedText.length}</span
      >
    </footer>
  </section>

  <!-- Escape anywhere inside closes the panel's overlay. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <aside
    bind:this={aiPanel}
    aria-label="AI assistant"
    class:panel-overlay={layout.ai === 'overlay'}
    class:panel-closed={!aiShown}
    class="ai-panel"
    id="ai-panel"
    tabindex="-1"
    on:keydown={(event) => closeOverlayOnEscape('ai', event)}
  >
    {#if layout.ai === 'docked'}
      <!-- A focusable separator is the ARIA window-splitter pattern. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        aria-controls="ai-panel"
        aria-label="Resize AI assistant"
        aria-orientation="vertical"
        aria-valuemax={WIDTH_LIMITS.ai.max}
        aria-valuemin={WIDTH_LIMITS.ai.min}
        aria-valuenow={layout.aiWidth}
        class="resize-handle resize-handle-ai"
        role="separator"
        tabindex="0"
        title="Drag or use arrow keys to resize. Double-click to reset."
        on:dblclick={() => resetPanelWidth('ai')}
        on:keydown={(event) => resizePanelByKey('ai', event)}
        on:pointerdown={(event) => startPanelResize('ai', event)}
      ></div>
    {/if}
    <header class="ai-header">
      <h2>AI assistant</h2>
      {#if layout.ai === 'docked'}
        <button
          aria-label={markdownViewsHidden
            ? 'Show the Markdown views'
            : 'Hide the Markdown views and widen this panel'}
          aria-pressed={markdownViewsHidden}
          class="panel-close-button"
          title={markdownViewsHidden
            ? 'Show the Markdown views'
            : 'Hide the Markdown views and widen this panel'}
          type="button"
          on:click={() => (markdownViewsHidden = !markdownViewsHidden)}
        >
          {@render icon(markdownViewsHidden ? 'collapseWide' : 'expandWide')}
        </button>
      {/if}
      <button
        aria-controls="ai-panel"
        aria-expanded="true"
        aria-label="Close AI assistant"
        class="panel-close-button"
        title="Close AI assistant"
        type="button"
        on:click={() => hideLayoutPanel('ai')}
      >
        {@render icon(layout.ai === 'overlay' ? 'close' : 'panelRight')}
      </button>
    </header>
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
              {:else if message.role === 'user'}
                <p>{message.text}</p>
              {:else}
                <div class="ai-markdown">
                  {@render markdownBlocks(renderMarkdown(message.text), true)}
                </div>
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
          disabled={filingLoading || !filingNotePath}
          title={filingNotePath
            ? `File this day's work into the project notes it belongs in`
            : `Only for a daily note in ${activeDailyNoteFolder}`}
          type="button"
          on:click={requestProjectFiling}
        >
          {filingLoading ? 'Reading the day...' : 'File to projects'}
        </button>
        {#if filingStatus}
          <span class="ai-connect-status">{filingStatus}</span>
        {/if}
      </div>
      {#if presetGroups.length}
        <details class="ai-preset">
          <summary class="ai-preset-label" id="ai-preset-heading"
            >Prompts</summary
          >
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
        </details>
      {/if}
      {#if aiPresetWarning}
        <p class="ai-preset-warning">{aiPresetWarning}</p>
      {/if}
      <details class={`ai-context ai-context-${aiContext.kind}`}>
        <summary>
          <span class="ai-context-label">Context</span>
          <span class="ai-context-summary" id="ai-context-summary"
            >{aiContext.summary}</span
          >
        </summary>
        <div class="ai-context-body">
          {#each aiContext.details as detail}
            <p>{detail}</p>
          {/each}
          {#if aiContext.excerpt}
            <blockquote>{aiContext.excerpt}</blockquote>
          {/if}
          <p class="ai-context-edit">
            The pencil drafts a rewrite of the editor selection only, shown as a
            diff; the note changes only if you accept it.
          </p>
        </div>
      </details>
      <textarea
        aria-label="Ask AI"
        aria-describedby="ai-context-summary"
        bind:this={chatInput}
        bind:value={chatPrompt}
        disabled={chatStreaming || inlineEditLoading}
        placeholder={aiContext.kind === 'selection'
          ? 'Ask about the selection'
          : aiContext.kind === 'note'
            ? 'Ask about this note'
            : 'Ask AI'}
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
  </aside>

  {#if modalPanelOpen}
    <button
      aria-label="Close panel"
      class="panel-backdrop"
      tabindex="-1"
      type="button"
      on:click={() =>
        hideLayoutPanel(layout.files === 'overlay' ? 'files' : 'ai')}
    ></button>
  {/if}
</main>
