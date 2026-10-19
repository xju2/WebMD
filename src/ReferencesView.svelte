<script>
  // The References destination: every entry of references.bib, filtered as you
  // type. "Ask AI" is a button, not a timer: it sends the query and a keyword
  // shortlist to the model and shows its picks, each with a reason.
  import { citationUrl } from './citations.js';
  import { ICONS } from './icons.js';

  export let root = '0';
  export let active = false;
  // A note is open in a column beside the list, to write while you read.
  export let beside = false;
  export let notesOpen = false;
  export let onToggleNotes = () => {};

  let loadedRoot = null;
  let entries = [];
  let query = '';
  let picks = null;
  let usage = null;
  let reviewed = 0;
  let history = [];
  let busy = false;
  let error = '';
  let copied = '';
  let author = '';
  let open = new Set();

  const ACCENTS = { '`': '̀', "'": '́', '^': '̂', '~': '̃', '"': '̈' };
  const GREEK = {
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    mu: 'μ',
    nu: 'ν',
    pi: 'π',
    sigma: 'σ',
    tau: 'τ',
    omega: 'ω',
    Lambda: 'Λ',
    Delta: 'Δ'
  };

  // BibTeX keeps LaTeX in titles and names (Sol\`ene, Ly$\alpha$); show it as text.
  const plain = (text = '') =>
    text
      .replace(/\\[ij]\b/g, (m) => m[1])
      .replace(
        /\\([`'^~"])\s*(\w)/g,
        (_, mark, letter) => letter + ACCENTS[mark]
      )
      .replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? m)
      .replace(/[$\\]/g, '')
      .normalize('NFC');

  // BibTeX writes "Last, First"; read as "First Last" so names are not mistaken for a list.
  const authorsOf = (entry) =>
    (entry.author || '')
      .split(/\s+and\s+/)
      .map((name) => name.trim().replace(/^([^,]+),\s*(.+)$/, '$2 $1'))
      .filter((name) => name && name !== 'others')
      .map(plain);
  const etAl = (entry) => /\band\s+others\b/.test(entry.author || '');

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

  const HISTORY_LIMIT = 10;
  const historyKey = (value) => `webmd:reference-searches:${value}`;

  function saveHistory() {
    try {
      localStorage.setItem(historyKey(root), JSON.stringify(history));
    } catch {
      // Storage may be blocked; the list still works this session.
    }
  }

  // "claude-sonnet-5-5 read 150 entries · 3,210 in / 120 out tokens · about $0.0123"
  function usageSummary(value, count) {
    if (!value?.model) return '';
    const n = (x) => Number(x).toLocaleString('en-US');
    return [
      `${value.model} read ${n(count)} entries`,
      value.inputTokens != null &&
        `${n(value.inputTokens)} in / ${n(value.outputTokens)} out tokens`,
      value.cost != null &&
        `about $${value.cost.toFixed(value.cost < 0.01 ? 4 : 2)}`
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function restore(item) {
    query = item.query;
    picks = item.matches;
    usage = item.usage;
    reviewed = item.reviewed;
    error = '';
  }

  async function load(nextRoot) {
    loadedRoot = nextRoot;
    try {
      history = JSON.parse(localStorage.getItem(historyKey(nextRoot))) || [];
    } catch {
      history = [];
    }
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
      usage = body.usage ?? null;
      reviewed = body.reviewed;
      history = [
        {
          query: query.trim(),
          matches: body.matches,
          usage,
          reviewed,
          at: Date.now()
        },
        ...history.filter((item) => item.query !== query.trim())
      ].slice(0, HISTORY_LIMIT);
      saveHistory();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  function toggle(key) {
    open.has(key) ? open.delete(key) : open.add(key);
    open = open;
  }

  async function copyCite(key, text = `[@${key}]`) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => (copied = copied === key ? '' : copied), 1500);
    } catch {
      error = 'Could not copy to the clipboard.';
    }
  }
</script>

<section
  class="references-pane"
  class:beside
  aria-label="References"
  hidden={!active}
>
  <header class="tasks-toolbar">
    <h2>References <span class="news-date">{entries.length} entries</span></h2>
    <form class="references-search" on:submit|preventDefault={askAi}>
      <input
        bind:value={query}
        aria-label="Search references"
        autocomplete="off"
        placeholder="Search title, author, year, key…"
        spellcheck="false"
        type="search"
        on:input={() => (picks = null)}
      />
      <button
        aria-pressed={notesOpen}
        class="news-notes-toggle"
        class:active={notesOpen}
        type="button"
        title="Show a note beside the list, to write while you read"
        on:click={onToggleNotes}
      >
        Notes
      </button>
      <button class="primary" type="submit" disabled={busy || !query.trim()}>
        <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
          {#each ICONS.sparkles as d}<path {d} />{/each}
        </svg>
        {busy ? 'Asking…' : 'Ask AI'}
      </button>
    </form>
  </header>
  <div class="references-body">
    {#if error}<p class="references-error" role="alert">{error}</p>{/if}
    {#if author}
      <p class="references-filter">
        Author <strong>{author}</strong>
        <button type="button" on:click={() => (author = '')}>Clear</button>
      </p>
    {/if}
    {#if history.length}
      <div class="references-history" aria-label="Recent AI searches">
        {#each history as item (item.query)}
          <button
            class:active={picks && item.query === query}
            type="button"
            title={usageSummary(item.usage, item.reviewed) ||
              'Show this search again without asking'}
            on:click={() => restore(item)}>{item.query}</button
          >
        {/each}
      </div>
    {/if}
    {#if picks}
      <p class="references-hint">
        {picks.length
          ? `AI picked ${picks.length} of ${entries.length}`
          : 'AI found nothing relevant'}
        {#if usageSummary(usage, reviewed)}· {usageSummary(
            usage,
            reviewed
          )}{/if}
      </p>
    {/if}
    <ul class="references-list">
      {#each shown as entry (entry.key)}
        <li class="references-card">
          <h3>{plain(entry.title) || entry.key}</h3>
          <p class="references-meta">
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
            {#if authorsOf(entry).length > 6 || etAl(entry)}<span>et al.</span
              >{/if}
            {#if entry.year}<span class="references-year">{entry.year}</span
              >{/if}
          </p>
          {#if entry.reason}<p class="references-reason">{entry.reason}</p>{/if}
          <div class="references-actions">
            <button
              class="references-key"
              type="button"
              title="Copy citation"
              on:click={() => copyCite(entry.key)}
            >
              {copied === entry.key ? 'Copied' : `[@${entry.key}]`}
            </button>
            <button type="button" on:click={() => toggle(entry.key)}>
              {open.has(entry.key) ? 'Hide BibTeX' : 'BibTeX'}
            </button>
            {#if citationUrl(entry)}
              <a href={citationUrl(entry)} target="_blank" rel="noreferrer"
                >Open ↗</a
              >
            {/if}
          </div>
          {#if open.has(entry.key)}
            <div class="references-bibtex">
              <button
                type="button"
                on:click={() => copyCite(entry.key + '.bib', entry.raw)}
              >
                {copied === entry.key + '.bib' ? 'Copied' : 'Copy entry'}
              </button>
              <pre>{entry.raw}</pre>
            </div>
          {/if}
        </li>
      {:else}
        <li class="references-empty">
          {entries.length
            ? 'No entry matches.'
            : 'references.bib has no entries.'}
        </li>
      {/each}
    </ul>
  </div>
</section>
