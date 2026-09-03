import { citationSource, parseBibtex } from '../src/citations.js';
import { WorkspaceError } from './workspace.js';

export async function fetchCitationBibtex(source, { fetchImpl = fetch } = {}) {
  const reference = citationSource(source);
  if (!reference) {
    throw new WorkspaceError(
      400,
      'An arXiv, DOI, or INSPIRE literature link is required.'
    );
  }

  const url =
    reference.kind === 'doi'
      ? `https://doi.org/${reference.id}`
      : reference.kind === 'arxiv'
        ? `https://inspirehep.net/api/arxiv/${encodeURIComponent(reference.id)}?format=bibtex`
        : `https://inspirehep.net/api/literature/${reference.id}?format=bibtex`;
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
    throw new WorkspaceError(
      502,
      `Citation lookup failed with ${response?.status || 'no response'}.`
    );
  }

  const bibtex = (await response.text()).trim();
  const entry = parseBibtex(bibtex)[0];
  if (!entry)
    throw new WorkspaceError(502, 'Citation lookup returned no BibTeX entry.');
  return { bibtex, entry };
}
