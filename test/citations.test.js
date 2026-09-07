import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citationArxiv,
  citationAuthors,
  citationCompletionQuery,
  citationCompletions,
  citationKeys,
  citationPasteSource,
  citationSource,
  citationSummary,
  citationVenue,
  parseBibtex
} from '../src/citations.js';
import { fetchCitationBibtex } from '../server/citations.js';

const BIBTEX = `@article{Ju:2026abc,
  author = {Ju, Xiangyang and Doe, Jane},
  title = {{A Citation-Aware} Knowledge Graph},
  year = {2026},
  doi = {10.1234/example.1}
}`;

test('parses BibTeX fields with nested braces', () => {
  assert.deepEqual(parseBibtex(BIBTEX)[0], {
    key: 'Ju:2026abc',
    type: 'article',
    fields: {
      author: 'Ju, Xiangyang and Doe, Jane',
      title: '{A Citation-Aware} Knowledge Graph',
      year: '2026',
      doi: '10.1234/example.1'
    },
    title: 'A Citation-Aware Knowledge Graph',
    author: 'Ju, Xiangyang and Doe, Jane',
    year: '2026',
    doi: '10.1234/example.1',
    url: '',
    arxiv: ''
  });
});

test('finds Pandoc citations and completes BibTeX keys', () => {
  const entries = parseBibtex(BIBTEX);
  assert.deepEqual(citationKeys('See [@Ju:2026abc] twice [@Ju:2026abc].'), [
    'Ju:2026abc',
    'Ju:2026abc'
  ]);
  assert.deepEqual(citationCompletionQuery('See [@Ju:'), {
    query: 'Ju:',
    length: 3
  });
  assert.equal(citationCompletions('graph', entries)[0].target, 'Ju:2026abc');
});

test('recognises supported citation links', () => {
  assert.deepEqual(citationSource('https://doi.org/10.1234/example.1'), {
    kind: 'doi',
    id: '10.1234/example.1'
  });
  assert.deepEqual(citationSource('https://arxiv.org/abs/2608.00146'), {
    kind: 'arxiv',
    id: '2608.00146'
  });
  assert.deepEqual(citationSource('https://inspirehep.net/literature/12345'), {
    kind: 'inspire',
    id: '12345'
  });
  assert.equal(citationPasteSource('https://example.com'), null);
});

test('fetches BibTeX with content negotiation', async () => {
  const requests = [];
  const result = await fetchCitationBibtex(
    'https://doi.org/10.1234/example.1',
    {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(BIBTEX);
      }
    }
  );
  assert.equal(result.entry.key, 'Ju:2026abc');
  assert.equal(requests[0].url, 'https://doi.org/10.1234/example.1');
  assert.equal(requests[0].options.headers.Accept, 'application/x-bibtex');
});

test('compresses author lists and names the venue', () => {
  const [entry] = parseBibtex(`@article{Aad:2012tfa,
  author = {Aad, Georges and Abajyan, Tatevik and Zwalinski, L.},
  title = {{Observation of a new particle}},
  journal = {Phys. Lett. B},
  volume = {716},
  pages = {1--29},
  year = {2012},
  eprint = {1207.7214},
  doi = {10.1016/j.physletb.2012.08.020}
}`);
  assert.equal(citationAuthors(entry), 'Aad et al.');
  assert.equal(citationVenue(entry), 'Phys. Lett. B 716, 1–29');
  assert.equal(citationArxiv(entry), 'arXiv:1207.7214');
  assert.equal(
    citationSummary(entry),
    'Aad et al. — Observation of a new particle — 2012 — Phys. Lett. B 716, 1–29 — arXiv:1207.7214'
  );
});

test('keeps a pair of authors and copes with a bare preprint', () => {
  const [entry] = parseBibtex(BIBTEX);
  assert.equal(citationAuthors(entry), 'Ju and Doe');
  assert.equal(citationVenue(entry), '');
  assert.equal(citationArxiv(entry), '');
  assert.equal(
    citationSummary(entry),
    'Ju and Doe — A Citation-Aware Knowledge Graph — 2026'
  );
});
