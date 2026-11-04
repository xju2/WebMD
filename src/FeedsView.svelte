<script>
  // The Feeds destination: what the sources in .webmd/feeds.json published
  // this week, newest first, each labeled Hype, Facts and Signal by the model.
  // Fetching and labeling start when the view opens or Refresh is pressed.
  import { ICONS } from './icons.js';

  export let root = '0';
  export let active = false;
  // Opens a workspace file in the editor, after the server has started it.
  export let onOpenFile = async () => {};
  // The links in today's note, and how an item is added to it.
  export let clipped = new Set();
  export let onClip = async () => {};

  const LABELS = ['signal', 'facts', 'hype'];
  const LABEL_NAMES = { signal: 'Signal', facts: 'Facts', hype: 'Hype' };
  // A label applies from this score up; the model scores each one 0 to 100.
  const THRESHOLD = 50;
  const FILTER_KEY = 'webmd:feeds-filter';

  let loadedRoot = null;
  let items = [];
  let sources = [];
  let warning = '';
  let status = '';
  let labelStatus = '';
  let labelError = '';
  let label = readFilter();
  let source = '';
  let query = '';
  let showSources = false;
  // url → { loading, error, url, blocks }: articles read in WebMD.
  let articles = new Map();
  let expanded = new Set();
  let clipping = new Set();

  function readFilter() {
    try {
      return localStorage.getItem(FILTER_KEY) || '';
    } catch {
      return '';
    }
  }

  $: saveFilter(label);

  function saveFilter(value) {
    try {
      localStorage.setItem(FILTER_KEY, value);
    } catch {
      // Storage may be blocked; the filter still works this session.
    }
  }

  $: if (active && root !== loadedRoot) load(root);
  $: failed = sources.filter((entry) => entry.error);
  $: words = query.toLowerCase().split(/\s+/).filter(Boolean);
  $: shown = items.filter((item) => {
    if (source && item.source !== source) return false;
    if (label && !(item.hfs?.[label] >= THRESHOLD)) return false;
    const haystack =
      `${item.title} ${item.excerpt ?? ''} ${item.source} ${item.publisher ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  $: counts = Object.fromEntries(
    LABELS.map((name) => [
      name,
      items.filter((item) => item.hfs?.[name] >= THRESHOLD).length
    ])
  );
  $: days = groupByDay(shown);

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(body?.error || `Request failed with ${response.status}.`);
    return body;
  }

  async function load(nextRoot, { refresh = false } = {}) {
    loadedRoot = nextRoot;
    status = refresh ? 'Fetching every source again…' : 'Fetching feeds…';
    try {
      const body = await requestJson(
        `/api/feeds?root=${encodeURIComponent(nextRoot)}${refresh ? '&refresh=1' : ''}`
      );
      if (loadedRoot !== nextRoot) return;
      items = body.items;
      sources = body.sources;
      warning = body.warning ?? '';
      status = '';
      labelAll(nextRoot);
    } catch (err) {
      if (loadedRoot === nextRoot) status = err.message;
    }
  }

  // One batch per request until none is left, so labels fill in as they come.
  let labeling = false;
  async function labelAll(forRoot) {
    if (labeling) return;
    labeling = true;
    labelError = '';
    try {
      let remaining = items.filter((item) => !item.hfs).length;
      while (remaining && loadedRoot === forRoot) {
        labelStatus = `Labeling ${remaining} items…`;
        const body = await requestJson('/api/feeds/label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: forRoot })
        });
        if (loadedRoot !== forRoot) break;
        items = items.map((item) =>
          body.labels[item.url] ? { ...item, hfs: body.labels[item.url] } : item
        );
        remaining = body.remaining;
      }
    } catch (err) {
      labelError = `Labeling stopped: ${err.message}`;
    } finally {
      labeling = false;
      labelStatus = '';
    }
  }

  /** The article behind an item, fetched once and kept for the session. */
  async function readArticle(item) {
    const known = articles.get(item.url);
    if (known && !known.error) return known.loading ?? known;
    const loading = requestJson(
      `/api/feeds/article?root=${encodeURIComponent(root)}&url=${encodeURIComponent(item.url)}`
    ).then(
      (article) => {
        articles = new Map(articles).set(item.url, article);
        return article;
      },
      (err) => {
        articles = new Map(articles).set(item.url, { error: err.message });
        return null;
      }
    );
    articles = new Map(articles).set(item.url, { loading });
    return loading;
  }

  function toggleMore(item) {
    const next = new Set(expanded);
    if (next.has(item.url)) next.delete(item.url);
    else {
      next.add(item.url);
      readArticle(item);
    }
    expanded = next;
  }

  const isClipped = (item, clippedUrls, read) =>
    clippedUrls.has(item.url) ||
    (read.get(item.url)?.url && clippedUrls.has(read.get(item.url).url));

  // A Google News item is clipped with its article's own link when that can
  // be found; otherwise with Google's.
  async function clip(item) {
    clipping = new Set(clipping).add(item.url);
    try {
      const article = /^https:\/\/news\.google\.com\//.test(item.url)
        ? await readArticle(item)
        : null;
      await onClip(item, article?.url || item.url);
    } catch (err) {
      status = `Could not clip: ${err.message}`;
    } finally {
      const next = new Set(clipping);
      next.delete(item.url);
      clipping = next;
    }
  }

  async function openSources() {
    try {
      const { path } = await requestJson('/api/feeds/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root })
      });
      await onOpenFile(path);
    } catch (err) {
      status = `Could not open the sources: ${err.message}`;
    }
  }

  function groupByDay(list) {
    const groups = [];
    for (const item of list) {
      const day = dayLabel(item.published || item.firstSeen);
      if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
      groups.at(-1).items.push(item);
    }
    return groups;
  }

  function dayLabel(iso) {
    const date = new Date(iso);
    const today = new Date();
    const start = (value) =>
      new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const ago = Math.round((start(today) - start(date)) / 86_400_000);
    if (ago <= 0) return 'Today';
    if (ago === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
  }

  const time = (iso) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    });
</script>

<section class="news-pane feeds-pane" aria-label="Feeds" hidden={!active}>
  <header class="tasks-toolbar news-toolbar">
    <h2>Feeds</h2>
    <div class="tasks-summary">
      <span>{shown.length} items</span>
      <span class="feeds-labels" role="group" aria-label="Label">
        <button
          aria-pressed={!label}
          class:active={!label}
          type="button"
          on:click={() => (label = '')}>All</button
        >
        {#each LABELS as name}
          <button
            aria-pressed={label === name}
            class:active={label === name}
            class={`feeds-label-${name}`}
            title={`${LABEL_NAMES[name]} scored ${THRESHOLD} or more`}
            type="button"
            on:click={() => (label = label === name ? '' : name)}
            >{LABEL_NAMES[name]} <span>{counts[name]}</span></button
          >
        {/each}
      </span>
      <select
        aria-label="Source"
        class="news-category-select"
        bind:value={source}
      >
        <option value="">All sources</option>
        {#each sources as entry (entry.name)}
          <option value={entry.name}>{entry.name} ({entry.count})</option>
        {/each}
      </select>
      <div class="search-field news-filter">
        <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
          {#each ICONS.search as d}<path {d} />{/each}
        </svg>
        <input
          class="tasks-filter"
          type="search"
          placeholder="Filter items"
          aria-label="Filter items"
          title="Every word must appear in the title, summary, or source"
          bind:value={query}
        />
      </div>
      <button
        type="button"
        title="Edit the sources and Google News topics in .webmd/feeds.json"
        on:click={openSources}>Sources</button
      >
      <button
        aria-label="Refresh"
        class="primary"
        type="button"
        title="Fetch every source again"
        disabled={status.startsWith('Fetching')}
        on:click={() => load(root, { refresh: true })}
      >
        <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
          {#each ICONS.refresh as d}<path {d} />{/each}
        </svg>
        <span class="news-refresh-label">Refresh</span>
      </button>
    </div>
  </header>
  {#if status}<p class="tasks-note">{status}</p>{/if}
  {#if warning}<p class="tasks-note">{warning}</p>{/if}
  {#if labelStatus || labelError}
    <p class="tasks-note">{labelStatus || labelError}</p>
  {/if}
  {#if failed.length}
    <p class="tasks-note">
      <button
        class="feeds-failed"
        type="button"
        on:click={() => (showSources = !showSources)}
      >
        {failed.length} of {sources.length} sources failed{showSources
          ? ''
          : ' (show)'}
      </button>
      {#if showSources}
        {#each failed as entry (entry.name)}
          <br />{entry.name}: {entry.error}
        {/each}
      {/if}
    </p>
  {/if}
  {#each days as group (group.day)}
    <h3 class="news-section">
      {group.day} <span>{group.items.length}</span>
      <i aria-hidden="true" class="news-section-rule"></i>
    </h3>
    <ol class="news-list">
      {#each group.items as item (item.url)}
        <li class="news-paper">
          <h4 class="news-title-heading">
            <a
              class="news-title"
              href={item.url}
              rel="noreferrer"
              target="_blank">{item.title}</a
            >
          </h4>
          <p class="news-meta">
            <span
              >{item.publisher
                ? `${item.publisher} · ${item.source}`
                : item.source}</span
            >
            {#if item.published}<span class="news-id"
                >{time(item.published)}</span
              >{/if}
            {#if item.discussion && item.discussion !== item.url}
              <a
                class="news-id"
                href={item.discussion}
                rel="noreferrer"
                target="_blank">{item.points ?? 0} points</a
              >
            {/if}
            {#if item.hfs}
              {#each LABELS as name}
                <span
                  class={`feeds-score feeds-label-${name}`}
                  class:strong={item.hfs[name] >= THRESHOLD}
                  title={`${LABEL_NAMES[name]} ${item.hfs[name]} of 100`}
                  >{LABEL_NAMES[name]} {item.hfs[name]}</span
                >
              {/each}
            {/if}
          </p>
          {#if expanded.has(item.url)}
            {@const article = articles.get(item.url)}
            <div class="feeds-article">
              {#if !article || article.loading}
                <p class="feeds-article-note">Reading the article…</p>
              {:else if article.error || !article.blocks.length}
                <p class="feeds-article-note">
                  {article.error ||
                    'This page cannot be read here: it renders in the browser or sits behind a paywall.'}
                </p>
                {#if item.excerpt}<p>{item.excerpt}</p>{/if}
              {:else}
                {#each article.blocks as block}
                  {#if block.tag === 'h'}<h5>{block.text}</h5>
                  {:else if block.tag === 'li'}<p class="feeds-article-li">
                      {block.text}
                    </p>
                  {:else if block.tag === 'pre'}<pre>{block.text}</pre>
                  {:else if block.tag === 'blockquote'}<blockquote>
                      {block.text}
                    </blockquote>
                  {:else}<p>{block.text}</p>{/if}
                {/each}
              {/if}
              {#if article?.url || !article?.loading}
                <a
                  class="feeds-article-original"
                  href={article?.url || item.url}
                  rel="noreferrer"
                  target="_blank">Open the original ↗</a
                >
              {/if}
            </div>
          {:else if item.excerpt}
            <div class="news-abstract">{item.excerpt}</div>
          {/if}
          <div class="news-paper-foot">
            <button
              aria-expanded={expanded.has(item.url)}
              class="news-more"
              type="button"
              title="Read the article here"
              on:click={() => toggleMore(item)}
            >
              {expanded.has(item.url) ? 'Less' : 'More'}
            </button>
            <div class="news-actions">
              {#if isClipped(item, clipped, articles)}
                <button class="news-clip clipped" disabled type="button">
                  <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
                    {#each ICONS.check as d}<path {d} />{/each}
                  </svg>
                  Clipped
                </button>
              {:else}
                <button
                  class="news-clip"
                  disabled={clipping.has(item.url)}
                  title="Add to the Reading section of today’s note"
                  type="button"
                  on:click={() => clip(item)}
                >
                  <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
                    {#each ICONS.clip as d}<path {d} />{/each}
                  </svg>
                  {clipping.has(item.url) ? 'Clipping…' : 'Clip'}
                </button>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    {#if !status}
      <ol class="news-list">
        <li class="preview-empty">
          {items.length
            ? 'No item matches this filter.'
            : 'No source has published anything this week.'}
        </li>
      </ol>
    {/if}
  {/each}
</section>
