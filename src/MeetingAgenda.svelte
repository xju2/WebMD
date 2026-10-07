<script>
  // One meeting's materials and timetable, as Indico lays it out. Shared by
  // the Meetings view and the reference pane beside a meeting's note.
  import {
    agendaGroups,
    describeAgendaTime,
    describeSessionTime,
    materialHref
  } from './meetings.js';

  // The meeting the times are read against (its own day goes unsaid).
  export let meeting = null;
  // The event as /api/meetings/event returns it, once loaded.
  export let detail = null;
  export let loading = false;
  export let error = null;
  export let zone = undefined;
  export let onRetry = () => {};
</script>

{#if detail?.materials?.length}
  <h4 class="meetings-agenda-title">Materials</h4>
  <p class="meetings-materials">
    {#each detail.materials as material (material.id + material.url)}
      <a href={materialHref(material)} rel="noopener noreferrer" target="_blank">{material.title}</a>
    {/each}
  </p>
{/if}

<h4 class="meetings-agenda-title">Agenda</h4>
{#if loading}
  <p class="tasks-note" aria-live="polite">Loading agenda…</p>
{:else if error}
  <p class="meetings-notice {error.kind === 'auth' || error.kind === 'network' || error.kind === 'timeout' ? 'error' : 'hint'}" role="alert">
    {error.message}
    <button class="meetings-link-button" type="button" on:click={onRetry}>
      Try again
    </button>
  </p>
{:else if detail?.agenda?.length || detail?.sessions?.length}
  <ol class="meetings-agenda">
    {#each agendaGroups(detail.agenda, detail.sessions) as group, index (index)}
      {#if group.session}
        <li class="meetings-agenda-session">
          <span class="meetings-agenda-time">{group.session.start ? describeSessionTime(group.session, meeting, { timeZone: zone }) : ''}</span>
          <span class="meetings-agenda-main">
            <strong>{group.session.title}</strong>
            {#if group.session.conveners?.length}
              <span class="meetings-agenda-meta">{group.session.conveners.join(', ')}</span>
            {/if}
          </span>
        </li>
      {/if}
      {#each group.items as item (item.id + item.start.iso)}
        <li>
          <span class="meetings-agenda-time">{describeAgendaTime(item, meeting, { timeZone: zone })}</span>
          <span class="meetings-agenda-main">
            {#if item.url}
              <a href={item.url} rel="noopener noreferrer" target="_blank">{item.title}</a>
            {:else}
              <span>{item.title}</span>
            {/if}
            {#if item.speakers.length}
              <span class="meetings-agenda-meta">{item.speakers.join(', ')}</span>
            {/if}
            {#if item.materials?.length}
              <span class="meetings-materials">
                {#each item.materials as material (material.id + material.url)}
                  <a href={materialHref(material)} rel="noopener noreferrer" target="_blank">{material.title}</a>
                {/each}
              </span>
            {/if}
          </span>
        </li>
      {/each}
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
