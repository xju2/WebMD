import { citationSource, parseBibtex } from '../src/citations.js';
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

export async function fetchCitationBibtex(source, { fetchImpl = fetch } = {}) {
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
    const bibtex = tidyArxivEntry((await response.text()).trim(), reference);
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

// DataCite keys its entries by the DOI URL, which makes for an unusable
// `[@https://doi.org/...]` in the note, and it drops the eprint field that
// names the preprint. Both are worth fixing before the entry is filed away.
function tidyArxivEntry(bibtex, { kind, id }) {
  if (kind !== 'arxiv' || !/@\w+\s*\{\s*https?:\/\//i.test(bibtex)) {
    return bibtex;
  }
  return bibtex
    .replace(/(@\w+\s*\{\s*)[^,]+/i, `$1arXiv:${id}`)
    .replace(
      /\n\}\s*$/,
      `,\n  eprint = {${id}},\n  archivePrefix = {arXiv}\n}`
    );
}
