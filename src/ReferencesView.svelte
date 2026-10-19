<script>
  // The References destination: every entry of references.bib, filtered as you
  // type. "Ask AI" is a button, not a timer: it sends the query and a keyword
  // shortlist to the model and shows its picks, each with a reason.
  import { citationUrl } from './citations.js';
  import { ICONS } from './icons.js';

  export let root = '0';
  export let active = false;

  let loadedRoot = null;
  let entries = [];
  let query = '';
  let picks = null;
  let busy = false;
  let error = '';
  let copied = '';
  let author = '';

  const authorsOf = (entry) =>
    (entry.author || '')
      .split(/\s+and\s+/)
      .map((name) => name.trim())
      .filter(Boolean);

  $: if (active && root !== loadedRoot) load(root);
  $: words = query.toLowerCase().split(/\s+/).filter(Boolean);
  $: byKey = new Map(entries.map((entry) => [entry.key, entry]));
  $: shown = picks
    ? picks.flatMap((pick) =>
        byKey.has(pick.key)
          ? [{ ...byKey.get(pick.key), reason: pick.reason }]
          : []
      )
    : entries.filter((entry) => {
        if (author && !authorsOf(entry).includes(author)) return false;
        const haystack =
          `${entry.key} ${entry.title} ${entry.author} ${entry.year} ${entry.fields?.abstract ?? ''}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      });

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(body?.error || `Request failed with ${response.status}.`);
    return body;
  }

  async function load(nextRoot) {
    loadedRoot = nextRoot;
    picks = null;
    error = '';
    try {
      const body = await requestJson(
        `/api/workspace/references?root=${encodeURIComponent(nextRoot)}`
      );
      if (loadedRoot === nextRoot) entries = body.entries;
    } catch (err) {
      error = err.message;
    }
  }

  async function askAi() {
    if (!query.trim() || busy) return;
    busy = true;
    error = '';
    try {
      const body = await requestJson('/api/workspace/references/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, query: query.trim() })
      });
      picks = body.matches;
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  async function copyCite(key) {
    try {
      await navigator.clipboard.writeText(`[@${key}]`);
      copied = key;
      setTimeout(() => (copied = copied === key ? '' : copied), 1500);
    } catch {
      error = 'Could not copy to the clipboard.';
    }
  }
</script>

<section class="references-pane" aria-label="References" hidden={!active}>
  <header class="tasks-toolbar">
    <h2>References <span class="news-date">{entries.length} entries</span></h2>
    <form class="conference-open" on:submit|preventDefault={askAi}>
      <input
        bind:value={query}
        aria-label="Search references"
        autocomplete="off"
        placeholder="Search title, author, year, key…"
        spellcheck="false"
        type="search"
        on:input={() => (picks = null)}
      />
      <button class="primary" type="submit" disabled={busy || !query.trim()}>
        <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
          {#each ICONS.sparkles as d}<path {d} />{/each}
        </svg>
        {busy ? 'Asking…' : 'Ask AI'}
      </button>
    </form>
  </header>
  {#if author}
    <p class="references-filter">
      Author: <strong>{author}</strong>
      <button type="button" on:click={() => (author = '')}>Clear</button>
    </p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <ul class="references-list">
    {#each shown as entry (entry.key)}
      <li>
        <strong>{entry.title || entry.key}</strong>
        <span class="references-meta">
          {#each authorsOf(entry).slice(0, 6) as name}
            <button
              class="references-author"
              type="button"
              on:click={() => {
                author = name;
                picks = null;
              }}>{name}</button
            >
          {/each}
          {#if authorsOf(entry).length > 6}and {authorsOf(entry).length - 6} more{/if}
          {entry.year}
        </span>
        {#if entry.reason}<em>{entry.reason}</em>{/if}
        <span class="references-actions">
          <button type="button" on:click={() => copyCite(entry.key)}>
            {copied === entry.key ? 'Copied' : `[@${entry.key}]`}
          </button>
          {#if citationUrl(entry)}
            <a href={citationUrl(entry)} target="_blank" rel="noreferrer"
              >Open</a
            >
          {/if}
        </span>
      </li>
    {:else}
      <li class="references-empty">
        {entries.length
          ? 'No entry matches.'
          : 'references.bib has no entries.'}
      </li>
    {/each}
  </ul>
</section>
