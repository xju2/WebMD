<script>
  // The Meetings destination: upcoming Indico meetings from the workspace's
  // sources, one meeting's agenda, and the note that goes with it. It stays
  // mounted while the user visits other views, so the list, the selection,
  // and the scroll position are where they were left.
  import { onDestroy, onMount, tick } from 'svelte';
  import { ICONS } from './icons.js';
  import {
    describeAgendaTime,
    describeMeetingTime,
    describeRange,
    filterMeetings,
    groupMeetings,
    keepSelection,
    meetingPlace,
    meetingsPane,
    sourceNotices
  } from './meetings.js';

  export let root = '0';
  export let active = false;
  // Opens a note in the editor; the parent owns navigation and the tree.
  export let onOpenNote = async () => {};

  const COMPACT_WIDTH = 720;

  let loadedRoot = null;
  let loading = false;
  let loadError = '';
  let listing = null;
  let sources = [];
  let warnings = [];
  let noteFolder = '/meetings';
  let sourceFilter = '';
  let selectedKey = '';
  let detailOpen = false;
  let detail = null;
  let detailKey = '';
  let detailLoading = false;
  let detailError = null;
  let noteBusy = false;
  let noteError = '';
  let manageOpen = false;
  let newUrl = '';
  let newLabel = '';
  let sourceBusy = false;
  let sourceError = '';
  let paneWidth = 1200;
  let pane;
  let detailHeading;
  let listButtons = new Map();
  let urlInput;
  let observer;
  let request = 0;
  let now = Date.now();

  $: compact = paneWidth < COMPACT_WIDTH;
  $: layout = meetingsPane({ compact, detailOpen: detailOpen && !!selectedKey });
  $: meetings = listing?.meetings ?? [];
  $: shown = filterMeetings(meetings, sourceFilter);
  $: sections = groupMeetings(shown, now);
  $: shownCount = sections.reduce((sum, section) => sum + section.meetings.length, 0);
  $: selected = meetings.find((meeting) => meeting.key === selectedKey) || null;
  $: sourceById = new Map(sources.map((source) => [source.id, source]));
  $: notices = sourceNotices(listing?.statuses, sourceById);
  $: blocked = notices.some((notice) => notice.tone === 'error');
  $: range = listing ? describeRange(listing.from, listing.to) : '';
  $: if (active && root !== loadedRoot) resetFor(root);
  $: if (active && loadedRoot === root && !loading && !listing && !loadError)
    load();

  onMount(() => {
    observer = new ResizeObserver(([entry]) => {
      paneWidth = entry.contentRect.width;
    });
    if (pane) observer.observe(pane);
  });
  onDestroy(() => observer?.disconnect());

  // Returning to the view picks up notes created or renamed elsewhere; the
  // server's cache keeps this from costing Indico anything.
  let wasActive = false;
  $: {
    if (active && !wasActive && listing) load({ quiet: true });
    wasActive = active;
  }

  function resetFor(nextRoot) {
    loadedRoot = nextRoot;
    listing = null;
    sources = [];
    warnings = [];
    loadError = '';
    sourceFilter = '';
    selectedKey = '';
    detailOpen = false;
    detail = null;
    detailKey = '';
    detailError = null;
    manageOpen = false;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(
        body?.error || `Request failed with ${response.status}.`
      );
      error.status = response.status;
      error.kind = body?.kind || '';
      throw error;
    }
    return body;
  }

  async function load({ refresh = false, quiet = false } = {}) {
    const current = ++request;
    const forRoot = root;
    if (!quiet) loading = true;
    loadError = '';
    try {
      const body = await requestJson(
        `/api/meetings?root=${encodeURIComponent(forRoot)}${refresh ? '&refresh=1' : ''}`
      );
      if (current !== request || forRoot !== root) return;
      now = Date.now();
      listing = body;
      sources = body.sources;
      warnings = body.warnings;
      noteFolder = body.noteFolder;
      if (sourceFilter && !sources.some((source) => source.id === sourceFilter))
        sourceFilter = '';
      selectedKey = keepSelection(body.meetings, selectedKey);
      if (!selectedKey) detailOpen = false;
      if (selectedKey && (refresh || detailKey !== selectedKey))
        loadDetail(selectedKey, { refresh });
      else if (detail && selectedKey === detailKey) {
        // The note may have been created or renamed since the detail loaded.
        const fresh = body.meetings.find((item) => item.key === selectedKey);
        if (fresh) detail = { ...detail, notePath: fresh.notePath };
      }
    } catch (error) {
      if (current !== request) return;
      // A listing already on screen stays; the failure is said above it.
      loadError = error.message;
    } finally {
      if (current === request) loading = false;
    }
  }

  async function choose(meeting) {
    selectedKey = meeting.key;
    detailOpen = true;
    noteError = '';
    if (detailKey !== meeting.key) loadDetail(meeting.key);
    await tick();
    // Narrow panes swap the list for the meeting, so focus follows it there.
    if (compact) detailHeading?.focus();
  }

  async function backToList() {
    const key = selectedKey;
    detailOpen = false;
    await tick();
    listButtons.get(key)?.focus();
  }

  async function loadDetail(key, { refresh = false } = {}) {
    const meeting = meetings.find((item) => item.key === key);
    if (!meeting) return;
    detailKey = key;
    detail = null;
    detailError = null;
    detailLoading = true;
    try {
      const body = await requestJson(
        `/api/meetings/event?root=${encodeURIComponent(root)}&origin=${encodeURIComponent(meeting.origin)}&id=${encodeURIComponent(meeting.eventId)}${refresh ? '&refresh=1' : ''}`
      );
      if (detailKey !== key) return;
      detail = body;
    } catch (error) {
      if (detailKey !== key) return;
      detailError = { message: error.message, kind: error.kind };
    } finally {
      if (detailKey === key) detailLoading = false;
    }
  }

  async function openNote() {
    const meeting = selected;
    if (!meeting || noteBusy) return;
    noteBusy = true;
    noteError = '';
    try {
      // Always asked of the server, which looks the note up by its Indico link
      // first: a note renamed since the list loaded is still the one opened.
      const result = await requestJson('/api/meetings/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, origin: meeting.origin, id: meeting.eventId })
      });
      markNote(meeting.key, result.path);
      await onOpenNote(result.path, { created: result.created });
    } catch (error) {
      noteError = error.message;
    } finally {
      noteBusy = false;
    }
  }

  function markNote(key, path) {
    if (listing) {
      listing = {
        ...listing,
        meetings: listing.meetings.map((item) =>
          item.key === key ? { ...item, notePath: path } : item
        )
      };
    }
    if (detail?.key === key) detail = { ...detail, notePath: path };
  }

  async function toggleManage() {
    manageOpen = !manageOpen;
    sourceError = '';
    if (manageOpen) {
      await tick();
      urlInput?.focus();
    }
  }

  async function addSource() {
    if (!newUrl.trim() || sourceBusy) return;
    sourceBusy = true;
    sourceError = '';
    try {
      const body = await requestJson('/api/meetings/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, url: newUrl, label: newLabel })
      });
      sources = body.sources;
      warnings = body.warnings;
      newUrl = '';
      newLabel = '';
      await load();
    } catch (error) {
      sourceError = error.message;
    } finally {
      sourceBusy = false;
    }
  }

  async function removeSource(source) {
    if (sourceBusy) return;
    sourceBusy = true;
    sourceError = '';
    try {
      const body = await requestJson('/api/meetings/sources', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, id: source.id })
      });
      sources = body.sources;
      warnings = body.warnings;
      await load();
    } catch (error) {
      sourceError = error.message;
    } finally {
      sourceBusy = false;
    }
  }

  function trackButton(node, key) {
    listButtons.set(key, node);
    return {
      update(next) {
        listButtons.delete(key);
        key = next;
        listButtons.set(key, node);
      },
      destroy() {
        if (listButtons.get(key) === node) listButtons.delete(key);
      }
    };
  }

  function sourceNames(meeting) {
    return (meeting.sources || [])
      .map((id) => sourceById.get(id)?.label || id)
      .join(', ');
  }

  function tokenState(source) {
    if (source.configured) return `${source.tokenVariable} set`;
    return 'No token: public meetings only';
  }
</script>

{#snippet icon(name)}
  <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
    {#each ICONS[name] as d}
      <path {d} />
    {/each}
  </svg>
{/snippet}

<section
  bind:this={pane}
  class="meetings-pane"
  class:compact
  aria-label="Meetings"
  hidden={!active}
>
  <header class="tasks-toolbar meetings-toolbar">
    <h2>
      Meetings
      {#if range}<span class="news-date">{range}</span>{/if}
    </h2>
    <div class="tasks-summary">
      {#if sources.length > 1}
        <select
          aria-label="Show meetings from"
          class="meetings-filter"
          bind:value={sourceFilter}
        >
          <option value="">All sources</option>
          {#each sources as source (source.id)}
            <option value={source.id}>{source.label}</option>
          {/each}
        </select>
      {/if}
      <button
        type="button"
        aria-expanded={manageOpen}
        aria-controls="meetings-sources"
        on:click={toggleManage}
      >
        {@render icon('plus')}
        Add source
      </button>
      <button
        class="primary"
        type="button"
        disabled={loading || !sources.length}
        title="Ask Indico again, skipping the cache"
        on:click={() => load({ refresh: true })}
      >
        {@render icon('refresh')}
        {loading && listing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    {#if manageOpen}
      <div class="meetings-sources" id="meetings-sources">
        <form class="meetings-add" on:submit|preventDefault={addSource}>
          <label class="meetings-field meetings-field-url">
            <span>Indico category or event link</span>
            <input
              bind:this={urlInput}
              bind:value={newUrl}
              autocomplete="off"
              inputmode="url"
              placeholder="https://indico.cern.ch/category/1234/"
              spellcheck="false"
              type="url"
            />
          </label>
          <label class="meetings-field">
            <span>Label (optional)</span>
            <input bind:value={newLabel} autocomplete="off" placeholder="Weekly meetings" />
          </label>
          <div class="meetings-add-actions">
            <button class="primary" type="submit" disabled={sourceBusy || !newUrl.trim()}>
              Add
            </button>
            <button type="button" on:click={toggleManage}>Done</button>
          </div>
        </form>
        {#if sourceError}
          <p class="meetings-notice error" role="alert">{sourceError}</p>
        {/if}
        {#if sources.length}
          <ul class="meetings-source-list" aria-label="Meeting sources">
            {#each sources as source (source.id)}
              <li>
                <div>
                  <span class="meetings-source-label">{source.label}</span>
                  <span class="meetings-source-meta">
                    {source.kind} · {new URL(source.origin).hostname} · {tokenState(source)}
                  </span>
                </div>
                <button
                  type="button"
                  class="meetings-link-button"
                  disabled={sourceBusy}
                  aria-label={`Remove ${source.label}`}
                  on:click={() => removeSource(source)}
                >
                  Remove
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="meetings-help">
          Saved in <code>.webmd/meetings.json</code>. Protected meetings need a token in
          <code>~/.webmd.conf</code>, never here. Notes go to <code>{noteFolder}</code>.
        </p>
      </div>
    {/if}
  </header>

  <div class="meetings-status" aria-live="polite">
    {#if loading && !listing}
      <p class="tasks-note">Loading meetings…</p>
    {/if}
    {#if loadError}
      <p class="meetings-notice error" role="alert">
        Could not load meetings: {loadError}
        <button class="meetings-link-button" type="button" on:click={() => load()}>
          Try again
        </button>
      </p>
    {/if}
    {#each warnings as warning}
      <p class="meetings-notice hint">{warning}</p>
    {/each}
    {#each notices as notice}
      <p class="meetings-notice {notice.tone}" data-kind={notice.kind}>
        {notice.text}
        {#if notice.kind === 'auth' || notice.kind === 'config' || notice.kind === 'maybe_protected'}
          <span class="meetings-notice-help">
            Create a token in Indico under My profile → Settings → API tokens with
            the <code>read:legacy_api</code> scope, put it in <code>~/.webmd.conf</code>,
            and restart WebMD.
          </span>
        {/if}
      </p>
    {/each}
  </div>

  {#if listing && !sources.length}
    <div class="meetings-empty">
      <h3>Follow an Indico category or event</h3>
      <p>
        Paste a category link to see its meetings for the next two weeks, or an
        event link to follow one meeting. Each meeting can open a Markdown note
        of its own.
      </p>
      {#if !manageOpen}
        <button class="meetings-empty-action" type="button" on:click={toggleManage}>
          {@render icon('plus')} Add source
        </button>
      {/if}
    </div>
  {:else if listing && !meetings.length}
    {#if !blocked}
      <p class="preview-empty meetings-none">
        No upcoming meetings in the next two weeks.
      </p>
    {/if}
  {:else if listing}
    <div class="meetings-body" data-layout={layout}>
      <nav class="meetings-list" aria-label="Upcoming meetings" hidden={layout === 'detail'}>
        {#each sections as section (section.id)}
          <h3 class="meetings-section">
            {section.label} <span>{section.meetings.length}</span>
          </h3>
          <ul>
            {#each section.meetings as meeting (meeting.key)}
              {@const time = describeMeetingTime(meeting)}
              <li>
                <button
                  use:trackButton={meeting.key}
                  type="button"
                  class="meetings-item"
                  class:selected={meeting.key === selectedKey}
                  aria-current={meeting.key === selectedKey ? 'true' : undefined}
                  on:click={() => choose(meeting)}
                >
                  <span class="meetings-item-time">
                    <span>{time.day}</span>
                    <span>{time.time}</span>
                  </span>
                  <span class="meetings-item-main">
                    <span class="meetings-item-title">{meeting.title}</span>
                    <span class="meetings-item-meta">
                      {#if meeting.protected}
                        <span class="meetings-lock" title="Protected in Indico">
                          {@render icon('lock')}<span class="visually-hidden">Protected.</span>
                        </span>
                      {/if}
                      {meetingPlace(meeting) || meeting.category || sourceNames(meeting)}
                    </span>
                  </span>
                  {#if meeting.notePath}
                    <span class="meetings-item-note" title="Has a note">
                      {@render icon('file')}<span class="visually-hidden">Has a note.</span>
                    </span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="preview-empty">No upcoming meetings from this source.</p>
        {/each}
        {#if shownCount}
          <p class="meetings-count">{shownCount} meetings</p>
        {/if}
      </nav>

      <article
        class="meetings-detail"
        aria-label={selected ? selected.title : 'Meeting'}
        hidden={layout === 'list'}
      >
        {#if selected}
          {@const time = describeMeetingTime(selected)}
          {@const view = detail?.key === selected.key ? detail : selected}
          {#if compact}
            <button class="meetings-back" type="button" on:click={backToList}>
              {@render icon('chevronLeft')} All meetings
            </button>
          {/if}
          <h3 bind:this={detailHeading} tabindex="-1">{selected.title}</h3>
          <dl class="meetings-facts">
            <div>
              <dt>When</dt>
              <dd>
                {time.full}
                {#if time.zoned}<span class="meetings-zone">({time.zoned})</span>{/if}
              </dd>
            </div>
            {#if meetingPlace(view)}
              <div><dt>Where</dt><dd>{meetingPlace(view)}</dd></div>
            {/if}
            {#if view.address}
              <div><dt>Address</dt><dd>{view.address}</dd></div>
            {/if}
            <div>
              <dt>Source</dt>
              <dd>
                {sourceNames(selected)}
                {#if selected.protected}<span class="meetings-tag">Protected</span>{/if}
              </dd>
            </div>
            {#if view.notePath}
              <div><dt>Note</dt><dd class="meetings-note-path">{view.notePath}</dd></div>
            {/if}
          </dl>
          <div class="meetings-actions">
            <button
              class="primary"
              type="button"
              disabled={noteBusy}
              on:click={openNote}
            >
              {@render icon('file')}
              {noteBusy ? 'Opening…' : view.notePath ? 'Open note' : 'Create note'}
            </button>
            <a
              class="meetings-open-indico"
              href={selected.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {@render icon('external')} Open in Indico
            </a>
          </div>
          {#if noteError}
            <p class="meetings-notice error" role="alert">{noteError}</p>
          {/if}

          {#if view.description}
            <details class="meetings-description">
              <summary>Description</summary>
              <p>{view.description}</p>
            </details>
          {/if}

          <h4 class="meetings-agenda-title">Agenda</h4>
          {#if detailLoading}
            <p class="tasks-note" aria-live="polite">Loading agenda…</p>
          {:else if detailError}
            <p class="meetings-notice {detailError.kind === 'auth' || detailError.kind === 'network' || detailError.kind === 'timeout' ? 'error' : 'hint'}" role="alert">
              {detailError.message}
              <button
                class="meetings-link-button"
                type="button"
                on:click={() => loadDetail(selected.key, { refresh: true })}
              >
                Try again
              </button>
            </p>
          {:else if detail?.agenda?.length}
            <ol class="meetings-agenda">
              {#each detail.agenda as item (item.id + item.start.iso)}
                <li>
                  <span class="meetings-agenda-time">{describeAgendaTime(item, selected)}</span>
                  <span class="meetings-agenda-main">
                    {#if item.url}
                      <a href={item.url} rel="noopener noreferrer" target="_blank">{item.title}</a>
                    {:else}
                      <span>{item.title}</span>
                    {/if}
                    {#if item.speakers.length || item.session}
                      <span class="meetings-agenda-meta">
                        {item.speakers.join(', ')}{item.speakers.length && item.session ? ' · ' : ''}{item.session}
                      </span>
                    {/if}
                  </span>
                </li>
              {/each}
            </ol>
            {#if detail.unscheduled}
              <p class="tasks-note">
                {detail.unscheduled} more {detail.unscheduled === 1 ? 'contribution is' : 'contributions are'} not on the timetable yet.
              </p>
            {/if}
          {:else if detail}
            <p class="preview-empty">Indico lists no timetable for this meeting yet.</p>
          {/if}
        {:else}
          <p class="preview-empty meetings-pick">Choose a meeting to see its agenda.</p>
        {/if}
      </article>
    </div>
  {/if}
</section>
