import {
  citationFallbackKey,
  citationSource,
  parseBibtex
} from '../src/citations.js';
import { WorkspaceError } from './workspace.js';

// INSPIRE only indexes high-energy physics, so an arXiv paper from any other
// field is missing there. arXiv mints a DOI for every paper it holds, and
// DataCite serves BibTeX for it, which makes doi.org the catch-all second try.
function lookupUrls({ kind, id }) {
  if (kind === 'doi') return [`https://doi.org/${id}`];
  if (kind === 'inspire')
    return [`https://inspirehep.net/api/literature/${id}?format=bibtex`];
  return [
    `https://inspirehep.net/api/arxiv/${encodeURIComponent(id)}?format=bibtex`,
    `https://doi.org/10.48550/arXiv.${encodeURIComponent(id)}`
  ];
}

/**
 * The arXiv categories INSPIRE indexes: high-energy physics and the fields it
 * borders. A paper listed only under, say, cs.LG will never appear there, so
 * its entry is never marked as waiting for INSPIRE.
 */
const INSPIRE_CATEGORY =
  /^(hep-|nucl-|gr-qc|astro-ph|math-ph|physics\.(acc-ph|ins-det|data-an|hep-ph))/i;

export function inspireIndexes(categories) {
  // Nothing said about the paper, as for a pasted link: assume it may be there.
  if (!categories?.length) return true;
  return categories.some((category) => INSPIRE_CATEGORY.test(category));
}

export async function fetchCitationBibtex(
  source,
  { fetchImpl = fetch, categories } = {}
) {
  const reference = citationSource(source);
  if (!reference) {
    throw new WorkspaceError(
      400,
      'An arXiv, DOI, or INSPIRE literature link is required.'
    );
  }

  const urls = lookupUrls(reference);
  let failure;
  for (const url of urls) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/x-bibtex' }
      });
    } catch (error) {
      throw new WorkspaceError(
        502,
        `Could not fetch citation: ${error.message}.`
      );
    }
    if (!response?.ok) {
      failure = response?.status || 'no response';
      continue;
    }
    const bibtex = tidyArxivEntry((await response.text()).trim(), reference, {
      categories
    });
    const entry = parseBibtex(bibtex)[0];
    if (!entry) {
      failure = 'an unreadable BibTeX entry';
      continue;
    }
    return { bibtex, entry };
  }

  throw new WorkspaceError(
    502,
    reference.kind === 'arxiv'
      ? `No catalogue has arXiv:${reference.id} (INSPIRE and arXiv both returned ${failure}).`
      : `Citation lookup failed with ${failure}.`
  );
}

/**
 * DataCite keys its entries by the DOI URL, which makes for an unusable
 * `[@https://doi.org/...]` in the note, and it drops the eprint field that
 * names the preprint. The entry is rekeyed the way Zotero would key it, and
 * marked `webmdfallback` so the Update keys sweep knows to ask INSPIRE about
 * this paper again — INSPIRE's own entry carries no such field.
 */
function tidyArxivEntry(bibtex, { kind, id }, { categories } = {}) {
  if (kind !== 'arxiv' || !/@\w+\s*\{\s*https?:\/\//i.test(bibtex)) {
    return bibtex;
  }
  const key = citationFallbackKey(parseBibtex(bibtex)[0] ?? {});
  return bibtex
    .replace(/(@\w+\s*\{\s*)[^,]+/i, `$1${key}`)
    .replace(
      /\n?\}\s*$/,
      `,\n  eprint = {${id}},\n  archivePrefix = {arXiv}${
        inspireIndexes(categories) ? `,\n  webmdfallback = {${id}}` : ''
      }\n}`
    );
}

/**
 * A paper clipped before INSPIRE indexed it is filed under arXiv's DOI record,
 * keyed `arXiv:<id>`. This asks INSPIRE about each of those again, and for
 * every paper it now holds swaps the entry for INSPIRE's and rewrites the
 * citations in the notes, so nothing that was already cited breaks.
 */
export async function upgradeArxivCitationKeys(
  workspace,
  { fetchImpl = fetch, limit = 25 } = {}
) {
  const pending = (await workspace.references())
    .map((entry) => ({
      entry,
      // Entries WebMD filed from arXiv's DOI record. The `arXiv:<id>` key is
      // how they were marked before `webmdfallback` existed.
      id:
        entry.fields?.webmdfallback ||
        (/^arxiv:/i.test(entry.key) ? entry.arxiv : '')
    }))
    .filter((pending) => pending.id)
    .slice(0, limit);
  const upgraded = [];

  for (const { entry, id } of pending) {
    let citation;
    try {
      citation = await fetchCitationBibtex(`https://arxiv.org/abs/${id}`, {
        fetchImpl
      });
    } catch {
      // No catalogue answered; the next press can try this paper again.
      continue;
    }
    // Another fallback entry: INSPIRE still does not hold the paper.
    if (citation.entry.fields?.webmdfallback) continue;

    await workspace.replaceReference(entry.key, citation.bibtex);
    const notes = [];
    for (const file of await workspace.markdownFiles()) {
      if (!file.content.includes(`[@${entry.key}]`)) continue;
      await workspace.editFile(file.path, (content) =>
        content.split(`[@${entry.key}]`).join(`[@${citation.entry.key}]`)
      );
      notes.push(file.path);
    }
    upgraded.push({ from: entry.key, to: citation.entry.key, notes });
  }

  return {
    checked: pending.length,
    upgraded,
    entries: await workspace.references()
  };
}
