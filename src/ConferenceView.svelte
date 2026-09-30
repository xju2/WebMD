<script>
  // The Conference destination: one Indico event planned hour by hour. The
  // model scores each day's best local matches once; each day's plan is built
  // here from the scores, and choosing another talk swaps it in without
  // asking again. A poster session is one stop with its best posters listed.
  import { onDestroy, onMount } from 'svelte';
  import { ICONS } from './icons.js';
  import {
    POSTERS_SHOWN,
    agendaDays,
    backupFor,
    choose,
    dayUnits,
    planDay,
    talkSpan,
    unitScores
  } from './conference-plan.js';
  import { newsDayLabel, newsRankSummary } from './news.js';

  export let root = '0';
  export let active = false;
  export let onOpenNote = async () => {};
  export let onFilesChanged = async () => {};

  const MINUTE = 60000;
  // One grid row per five minutes; a 20-minute talk is four rows tall.
  const SLOT_MINUTES = 5;

  let loadedRoot = null;
  let conferences = [];
  let urlDraft = '';
  let currentUrl = '';
  let busy = false;
  let error = '';
  let data = null;
  let plans = {};
  let dayDate = '';
  let mode = 'plan';
  let noteBusy = false;
  let noteError = '';
  let noteMessage = '';
  let now = Date.now();
  let clock;

  $: if (active && root !== loadedRoot) resetFor(root);
  $: meeting = data?.meeting ?? null;
  $: scoreById = new Map(
    Object.entries(data?.ranking?.scores ?? {}).map(([id, value]) => [
      id,
      value.score
    ])
  );
  $: reasonById = new Map(
    Object.entries(data?.ranking?.scores ?? {}).map(([id, value]) => [
      id,
      value.reason || ''
    ])
  );
  $: localIds = new Set(
    Object.entries(data?.ranking?.scores ?? {})
      .filter(([, value]) => value.local)
      .map(([id]) => id)
  );
  $: days = meeting ? splitDays(meeting.agenda, scoreById) : [];
  $: day = days.find((item) => item.date === dayDate) || days[0] || null;
  $: plan = day ? plans[day.date] || [] : [];
  $: rows = day ? planRows(plan, day.units, day.scores) : [];
  $: today = meeting ? zoneDate(now, meeting.timezone) : '';
  $: grid = day ? gridLayout(day.units) : null;
  $: planned = new Set(plan.map((item) => item.id));

  onMount(() => {
    clock = setInterval(() => {
      if (active) now = Date.now();
    }, 60000);
  });
  onDestroy(() => clearInterval(clock));

  async function resetFor(nextRoot) {
    loadedRoot = nextRoot;
    data = null;
    plans = {};
    currentUrl = '';
    error = '';
    noteMessage = '';
    noteError = '';
    try {
      const body = await requestJson(
        `/api/conferences?root=${encodeURIComponent(nextRoot)}`
      );
      if (loadedRoot === nextRoot) conferences = body.conferences;
    } catch (err) {
      error = err.message;
    }
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok)
      throw new Error(body?.error || `Request failed with ${response.status}.`);
    return body;
  }

  // Plan asks the model only when the server has no scores for this agenda
  // and these instructions; Re-rank always asks.
  async function planConference(url, { refresh = false } = {}) {
    if (!url.trim() || busy) return;
    busy = true;
    error = '';
    noteMessage = '';
    noteError = '';
    try {
      const body = await requestJson('/api/conference/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, url: url.trim(), refresh })
      });
      data = body;
      currentUrl = body.meeting.key;
      urlDraft = '';
      const scores = new Map(
        Object.entries(body.ranking.scores).map(([id, value]) => [
          id,
          value.score
        ])
      );
      const split = splitDays(body.meeting.agenda, scores);
      plans = Object.fromEntries(
        split.map((item) => [item.date, planDay(item.units, item.scores)])
      );
      const localToday = zoneDate(Date.now(), body.meeting.timezone);
      if (!split.some((item) => item.date === dayDate))
        dayDate = split.some((item) => item.date === localToday)
          ? localToday
          : split[0]?.date || '';
      const listed = await requestJson(
        `/api/conferences?root=${encodeURIComponent(root)}`
      );
      conferences = listed.conferences;
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  /** Each day with its planning units (poster sessions folded) and their scores. */
  function splitDays(agenda, scores) {
    return agendaDays(agenda).map((item) => {
      const units = dayUnits(item.talks, scores);
      return { ...item, units, scores: unitScores(units, scores) };
    });
  }

  async function forget(url) {
    try {
      const body = await requestJson('/api/conferences', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, url })
      });
      conferences = body.conferences;
    } catch (err) {
      error = err.message;
    }
  }

  function pick(talk) {
    if (!day) return;
    plans = { ...plans, [day.date]: choose(plan, talk) };
    noteMessage = '';
  }

  async function saveNote() {
    if (!meeting || noteBusy) return;
    noteBusy = true;
    noteError = '';
    noteMessage = '';
    try {
      const body = await requestJson('/api/conference/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root,
          url: currentUrl,
          days: Object.fromEntries(
            Object.entries(plans).map(([date, items]) => [
              date,
              items.map((item) => item.id)
            ])
          )
        })
      });
      data = { ...data, planPath: body.path };
      noteMessage = body.created ? 'Plan note created.' : 'Plan note updated.';
      if (body.created) onFilesChanged();
    } catch (err) {
      noteError = err.message;
    } finally {
      noteBusy = false;
    }
  }

  /** The plan with the free time between talks, as rows to draw. */
  function planRows(items, talks, scores) {
    const out = [];
    let previousEnd = null;
    for (const item of items) {
      const span = talkSpan(item);
      const gap =
        previousEnd == null
          ? 0
          : Math.round((span.start - previousEnd) / MINUTE);
      if (gap >= 10)
        out.push({ kind: 'free', minutes: gap, key: `free-${item.id}` });
      out.push({
        kind: 'talk',
        item,
        span,
        backup: backupFor(item, talks, items, scores),
        key: item.id
      });
      previousEnd = span.end;
    }
    return out;
  }

  /** Rooms as columns and five-minute rows, from the day's first hour. */
  function gridLayout(talks) {
    const spans = talks.map((item) => talkSpan(item));
    const first = Math.min(...spans.map((span) => span.start));
    const last = Math.max(...spans.map((span) => span.end));
    // The first talk's wall-clock minutes, so the grid starts on its hour.
    const [hours, minutes] = talks
      .reduce((earliest, item) =>
        item.start.at < earliest.start.at ? item : earliest
      )
      .start.time.split(':')
      .map(Number);
    const origin = first - minutes * MINUTE;
    const rooms = [
      ...new Set(talks.map((item) => item.room || 'Unassigned'))
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const row = (at) => Math.round((at - origin) / (SLOT_MINUTES * MINUTE)) + 2;
    const hourCount = Math.ceil((last - origin) / (60 * MINUTE));
    return {
      rooms,
      rowCount: row(last),
      hours: Array.from({ length: hourCount }, (_, index) => ({
        label: `${String((hours + index) % 24).padStart(2, '0')}:00`,
        row: row(origin + index * 60 * MINUTE)
      })),
      cells: talks.map((item, index) => ({
        item,
        column: rooms.indexOf(item.room || 'Unassigned') + 2,
        from: row(spans[index].start),
        to: Math.max(row(spans[index].end), row(spans[index].start) + 1)
      }))
    };
  }

  function zoneDate(at, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'UTC'
      }).format(at);
    } catch {
      return new Date(at).toISOString().slice(0, 10);
    }
  }

  function endTime(item) {
    if (item.end?.time && item.end.at > item.start.at) return item.end.time;
    const [hours, minutes] = item.start.time.split(':').map(Number);
    const total =
      hours * 60 +
      minutes +
      Math.round((talkSpan(item).end - item.start.at) / MINUTE);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function tier(score) {
    return score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low';
  }

  function isNow(span) {
    return day?.date === today && span.start <= now && now < span.end;
  }
</script>

{#snippet icon(name)}
  <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
    {#each ICONS[name] as d}
      <path {d} />
    {/each}
  </svg>
{/snippet}

{#snippet score(item)}
  {@const value = day?.scores.get(item.id) ?? scoreById.get(item.id)}
  {#if value}
    <span
      class="conference-score {tier(value)}"
      class:local={localIds.has(item.id)}
      title={localIds.has(item.id)
        ? 'Not read by the model: scored by keyword match with your notes'
        : 'Scored by the model'}>{value}</span
    >
  {/if}
{/snippet}

<section class="conference-pane" aria-label="Conference" hidden={!active}>
  <header class="tasks-toolbar conference-toolbar">
    <h2>
      Conference
      {#if meeting}<span class="news-date">{meeting.title}</span>{/if}
    </h2>
    <div class="tasks-summary">
      <form
        class="conference-open"
        on:submit|preventDefault={() => planConference(urlDraft)}
      >
        <input
          bind:value={urlDraft}
          aria-label="Indico event link"
          autocomplete="off"
          inputmode="url"
          placeholder="https://indico.cern.ch/event/1234/"
          spellcheck="false"
          type="url"
        />
        <button
          class="primary"
          type="submit"
          disabled={busy || !urlDraft.trim()}
        >
          {@render icon('sparkles')}
          {busy && !meeting ? 'Planning…' : 'Plan'}
        </button>
      </form>
      {#if conferences.length > 1 || (conferences.length && !meeting)}
        <select
          aria-label="Planned conferences"
          class="meetings-filter"
          value={currentUrl}
          on:change={(event) => planConference(event.currentTarget.value)}
        >
          {#if !meeting}<option value="">Planned conferences</option>{/if}
          {#each conferences as item (item.url)}
            <option value={item.url}>{item.title}</option>
          {/each}
        </select>
      {/if}
    </div>
  </header>

  {#if error}
    <p class="meetings-notice error conference-notice" role="alert">{error}</p>
  {/if}

  {#if !meeting}
    <div class="conference-empty">
      {#if busy}
        <p class="tasks-note" aria-live="polite">
          Reading the agenda and scoring each day’s best matches… a big
          conference takes a minute.
        </p>
      {:else}
        <p class="preview-empty">
          Paste a conference’s Indico event link. Each day’s talks are matched
          against your arXiv News instructions and notes, the model judges the
          best of them, and each day becomes one plan you can follow hour by
          hour.
        </p>
        {#if conferences.length}
          <ul class="conference-recent" aria-label="Planned conferences">
            {#each conferences as item (item.url)}
              <li>
                <button
                  class="meetings-link-button"
                  type="button"
                  on:click={() => planConference(item.url)}
                >
                  {item.title}
                </button>
                <span class="meetings-zone"
                  >{item.start}{item.end && item.end !== item.start
                    ? ` – ${item.end}`
                    : ''}</span
                >
                <button
                  class="meetings-link-button"
                  type="button"
                  on:click={() => forget(item.url)}
                >
                  Forget
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="conference-bar">
      <div class="conference-days" role="tablist" aria-label="Conference days">
        {#each days as item (item.date)}
          <button
            role="tab"
            type="button"
            aria-selected={item.date === day?.date}
            class:active={item.date === day?.date}
            on:click={() => (dayDate = item.date)}
          >
            {newsDayLabel(item.date)}
            {#if item.date === today}<span class="conference-today">today</span
              >{/if}
          </button>
        {/each}
      </div>
      <div class="conference-actions">
        <div class="conference-mode" role="group" aria-label="Layout">
          <button
            type="button"
            class:active={mode === 'plan'}
            aria-pressed={mode === 'plan'}
            on:click={() => (mode = 'plan')}>Plan</button
          >
          <button
            type="button"
            class:active={mode === 'grid'}
            aria-pressed={mode === 'grid'}
            on:click={() => (mode = 'grid')}>All tracks</button
          >
        </div>
        <button
          type="button"
          disabled={busy}
          on:click={() => planConference(currentUrl, { refresh: true })}
        >
          {@render icon('refresh')}
          {busy ? 'Ranking…' : 'Re-rank'}
        </button>
        <button
          class="primary"
          type="button"
          disabled={noteBusy}
          on:click={saveNote}
        >
          {@render icon('file')}
          {noteBusy
            ? 'Saving…'
            : data.planPath
              ? 'Update plan note'
              : 'Save plan to note'}
        </button>
        {#if data.planPath}
          <button type="button" on:click={() => onOpenNote(data.planPath)}
            >Open note</button
          >
        {/if}
      </div>
    </div>
    <p class="tasks-note conference-meta">
      Times in {meeting.timezone}. {newsRankSummary(data.ranking, 'talks')}
      {#if data.ranking.total > data.ranking.reviewed}
        · {(data.ranking.total - data.ranking.reviewed).toLocaleString('en-US')}
        more matched to your notes locally{/if}
      {#if noteMessage}<span role="status">· {noteMessage}</span>{/if}
    </p>
    {#if noteError}
      <p class="meetings-notice error conference-notice" role="alert">
        {noteError}
      </p>
    {/if}
    {#each data.ranking.warnings ?? [] as warning}
      <p class="meetings-notice hint conference-notice" role="status">
        {warning}
      </p>
    {/each}

    {#if day && mode === 'plan'}
      <ol
        class="conference-plan"
        aria-label="Plan for {newsDayLabel(day.date)}"
      >
        {#each rows as row (row.key)}
          {#if row.kind === 'free'}
            <li class="conference-free">Free · {row.minutes} min</li>
          {:else}
            {@const item = row.item}
            <li class="conference-talk" class:now={isNow(row.span)}>
              <span class="conference-time"
                >{item.start.time}<small>{endTime(item)}</small></span
              >
              <div class="conference-main">
                <div class="conference-title">
                  {@render score(item)}
                  {#if item.url}
                    <a href={item.url} rel="noopener noreferrer" target="_blank"
                      >{item.title}</a
                    >
                  {:else}
                    <span>{item.title}</span>
                  {/if}
                </div>
                {#if item.posters}
                  {@const shown = item.posters.slice(0, POSTERS_SHOWN)}
                  <span class="conference-where">
                    {#if item.room}<strong>{item.room}</strong>{/if}
                    {item.posters.length.toLocaleString('en-US')} posters · the best
                    {shown.length} to visit
                  </span>
                  <ol class="conference-posters">
                    {#each shown as poster (poster.id)}
                      <li>
                        {@render score(poster)}
                        <span>
                          {#if poster.url}
                            <a
                              href={poster.url}
                              rel="noopener noreferrer"
                              target="_blank">{poster.title}</a
                            >
                          {:else}
                            {poster.title}
                          {/if}
                          {#if reasonById.get(poster.id)}
                            <small>{reasonById.get(poster.id)}</small>
                          {/if}
                        </span>
                      </li>
                    {/each}
                  </ol>
                {:else}
                  <span class="conference-where">
                    {#if item.room}<strong>{item.room}</strong>{/if}
                    {[item.speakers.join(', '), item.session]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                {/if}
                {#if reasonById.get(item.id)}
                  <span class="conference-reason"
                    >{reasonById.get(item.id)}</span
                  >
                {/if}
                {#if row.backup}
                  <span class="conference-backup">
                    Or
                    <button
                      class="meetings-link-button"
                      type="button"
                      title="Go to this talk instead"
                      on:click={() => pick(row.backup)}
                    >
                      {row.backup.title}
                    </button>
                    {#if row.backup.room}· {row.backup.room}{/if}
                    {@render score(row.backup)}
                  </span>
                {/if}
              </div>
            </li>
          {/if}
        {:else}
          <li class="preview-empty">
            No talk on this day scored high enough to plan.
          </li>
        {/each}
      </ol>
    {:else if day && grid}
      <p class="tasks-note conference-meta">
        Your plan is filled in. Pick any other talk to go there instead.
      </p>
      <div class="conference-grid-scroll">
        <div
          class="conference-grid"
          style="grid-template-columns: 3.5rem repeat({grid.rooms
            .length}, minmax(10rem, 1fr)); grid-template-rows: auto repeat({grid.rowCount -
            1}, 11px);"
        >
          {#each grid.rooms as room, index (room)}
            <div
              class="conference-room"
              style="grid-column: {index + 2}; grid-row: 1;"
            >
              {room}
            </div>
          {/each}
          {#each grid.hours as hour (hour.label)}
            <div
              class="conference-hour"
              style="grid-column: 1; grid-row: {hour.row} / span 12;"
            >
              {hour.label}
            </div>
          {/each}
          {#each grid.cells as cell (cell.item.id + cell.item.start.at)}
            <button
              type="button"
              class="conference-cell {tier(day.scores.get(cell.item.id) || 0)}"
              class:chosen={planned.has(cell.item.id)}
              aria-pressed={planned.has(cell.item.id)}
              style="grid-column: {cell.column}; grid-row: {cell.from} / {cell.to};"
              title="{cell.item.start.time}–{endTime(cell.item)} {cell.item
                .title}{reasonById.get(cell.item.id)
                ? `\n${reasonById.get(cell.item.id)}`
                : ''}"
              on:click={() => pick(cell.item)}
            >
              <span class="conference-cell-time"
                >{cell.item.start.time}{#if day.scores.get(cell.item.id)}
                  · {day.scores.get(cell.item.id)}{/if}</span
              >
              {cell.item.title}{#if cell.item.posters}
                · {cell.item.posters.length} posters{/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</section>
