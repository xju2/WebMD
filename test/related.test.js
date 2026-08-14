import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRelatedMessages,
  MAX_SUGGESTIONS,
  parseRelatedSuggestions,
  rankRelatedCandidates
} from '../server/related.js';

function markdown(path, content) {
  return { path, fileKind: 'markdown', content };
}

const CORPUS = [
  markdown(
    '/wiki/concepts/triton-serving.md',
    '---\ntags: [inference]\n---\n\n# Triton Serving\n\nTriton batches ONNX inference requests across GPU model instances.'
  ),
  markdown(
    '/wiki/concepts/pastry.md',
    '# Pastry\n\nLamination folds butter into dough so the layers separate in the oven.'
  ),
  markdown(
    '/raw/dailynotes/2026-07-08.md',
    '# 2026-07-08\n\nMeasured Triton throughput for the ONNX model and tuned instance counts.'
  ),
  { path: '/assets/diagram.png', fileKind: 'image' }
];

const TARGET = {
  path: '/raw/dailynotes/2026-07-09.md',
  content:
    '# 2026-07-09\n\nTriton kept dropping ONNX inference requests once the GPU instance count went up.'
};

test('keeps notes that share subject matter and drops ones that share nothing', () => {
  const paths = rankRelatedCandidates(CORPUS, TARGET).map(
    (candidate) => candidate.path
  );

  assert.deepEqual(paths.slice().sort(), [
    '/raw/dailynotes/2026-07-08.md',
    '/wiki/concepts/triton-serving.md'
  ]);
});

test('never suggests the note itself or anything it already links to', () => {
  const target = {
    ...TARGET,
    content: `${TARGET.content}\n\nSee [[concepts/triton-serving]].`
  };
  const paths = rankRelatedCandidates(
    [...CORPUS, markdown(target.path, target.content)],
    target
  ).map((candidate) => candidate.path);

  assert.ok(!paths.includes(target.path));
  assert.ok(!paths.includes('/wiki/concepts/triton-serving.md'));
});

test('skips files that are not markdown', () => {
  const paths = rankRelatedCandidates(CORPUS, TARGET).map(
    (candidate) => candidate.path
  );
  assert.ok(!paths.some((path) => path.endsWith('.png')));
});

test('carries the title, tags, and a snippet into the prompt', () => {
  const candidates = rankRelatedCandidates(CORPUS, TARGET);
  const triton = candidates.find(
    (candidate) => candidate.path === '/wiki/concepts/triton-serving.md'
  );

  assert.equal(triton.title, 'Triton Serving');
  assert.deepEqual(triton.tags, ['inference']);
  assert.match(triton.snippet, /^Triton batches ONNX/);

  const [system, user] = buildRelatedMessages(TARGET, candidates);
  assert.equal(system.role, 'developer');
  assert.match(
    user.content,
    /\/wiki\/concepts\/triton-serving\.md — Triton Serving \[tags: inference\]/
  );
  assert.match(user.content, /Triton kept dropping ONNX/);
});

test('reads suggestions out of a fenced reply', () => {
  const candidates = rankRelatedCandidates(CORPUS, TARGET);
  const reply =
    'Here you go:\n```json\n[{"path": "/wiki/concepts/triton-serving.md", "reason": "same serving stack"}]\n```';

  const { suggestions, warning } = parseRelatedSuggestions(reply, candidates);
  assert.equal(warning, undefined);
  assert.deepEqual(suggestions, [
    {
      path: '/wiki/concepts/triton-serving.md',
      title: 'Triton Serving',
      reason: 'same serving stack'
    }
  ]);
});

test('drops paths the model was never offered', () => {
  const candidates = rankRelatedCandidates(CORPUS, TARGET);
  const reply =
    '[{"path": "/wiki/concepts/invented.md", "reason": "nope"}, {"path": "/wiki/concepts/triton-serving.md", "reason": "yes"}]';

  const { suggestions, warning } = parseRelatedSuggestions(reply, candidates);
  assert.deepEqual(
    suggestions.map((suggestion) => suggestion.path),
    ['/wiki/concepts/triton-serving.md']
  );
  assert.match(warning, /does not exist/);
});

test('caps the number of suggestions and drops repeats', () => {
  const candidates = rankRelatedCandidates(CORPUS, TARGET);
  const entries = Array.from({ length: MAX_SUGGESTIONS + 3 }, () => ({
    path: candidates[0].path,
    reason: 'same'
  }));

  const { suggestions } = parseRelatedSuggestions(
    JSON.stringify(entries),
    candidates
  );
  assert.equal(suggestions.length, 1);
});

test('reports an unusable reply instead of throwing', () => {
  const { suggestions, warning } = parseRelatedSuggestions(
    'I could not decide.',
    []
  );
  assert.deepEqual(suggestions, []);
  assert.match(warning, /did not return/);
});

test('treats an empty list as a valid answer', () => {
  const { suggestions, warning } = parseRelatedSuggestions('[]', []);
  assert.deepEqual(suggestions, []);
  assert.equal(warning, undefined);
});
