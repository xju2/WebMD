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
  citationCard,
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

test('shows only the title on the preview hover card', () => {
  const [entry] = parseBibtex(BIBTEX);
  assert.equal(citationCard(entry), 'A Citation-Aware Knowledge Graph');
});

test('drops an arXiv version suffix before looking a paper up', () => {
  assert.deepEqual(citationSource('https://arxiv.org/abs/2608.00146v3'), {
    kind: 'arxiv',
    id: '2608.00146'
  });
  assert.deepEqual(citationSource('https://arxiv.org/pdf/2608.00146v3'), {
    kind: 'arxiv',
    id: '2608.00146'
  });
});

test('falls back to arXiv’s DOI when INSPIRE has no such paper', async () => {
  const requests = [];
  const { bibtex, entry } = await fetchCitationBibtex(
    'https://arxiv.org/abs/2401.01234',
    {
      fetchImpl: async (url) => {
        requests.push(url);
        return url.includes('inspirehep')
          ? new Response('', { status: 404 })
          : new Response(`@misc{https://doi.org/10.48550/arxiv.2401.01234,
  doi = {10.48550/ARXIV.2401.01234},
  author = {Li, Jinqing and Ma, Jun},
  title = {Mixture cure models},
  year = {2024}
}`);
      }
    }
  );
  assert.deepEqual(requests, [
    'https://inspirehep.net/api/arxiv/2401.01234?format=bibtex',
    'https://doi.org/10.48550/arXiv.2401.01234'
  ]);
  // The DataCite key is a URL, which would be unusable as [@...] in a note.
  assert.equal(entry.key, 'arXiv:2401.01234');
  assert.equal(entry.arxiv, '2401.01234');
  assert.equal(citationArxiv(entry), 'arXiv:2401.01234');
  assert.match(bibtex, /@misc\{arXiv:2401\.01234,/);
});

test('names the paper when no catalogue has it', async () => {
  await assert.rejects(
    fetchCitationBibtex('https://arxiv.org/abs/9999.99999', {
      fetchImpl: async () => new Response('', { status: 404 })
    }),
    /No catalogue has arXiv:9999\.99999 .*returned 404/
  );
  await assert.rejects(
    fetchCitationBibtex('https://inspirehep.net/literature/12345', {
      fetchImpl: async () => new Response('', { status: 500 })
    }),
    /Citation lookup failed with 500/
  );
});
