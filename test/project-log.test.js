import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProjectLogMessages,
  MAX_TARGETS,
  parseProjectLogEntries,
  rankProjectCandidates
} from '../server/project-log.js';

function markdown(path, content) {
  return { path, fileKind: 'markdown', content };
}

const DAILY_FOLDER = '/raw/dailynotes';

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

function rank(files = CORPUS, target = TARGET) {
  return rankProjectCandidates(files, target, {
    dailyNoteFolder: DAILY_FOLDER
  });
}

test('keeps project notes that share subject matter and drops ones that share nothing', () => {
  const paths = rank().candidates.map((candidate) => candidate.path);
  assert.deepEqual(paths, ['/wiki/concepts/triton-serving.md']);
});

test('never offers another daily note as a filing target', () => {
  const paths = rank().candidates.map((candidate) => candidate.path);
  assert.ok(!paths.some((path) => path.startsWith(DAILY_FOLDER)));
});

test('reports project notes that already link to the day instead of offering them', () => {
  const files = [
    ...CORPUS,
    markdown(
      '/wiki/projects/serving.md',
      '# Serving\n\nONNX inference on GPU instances.\n\n## Log\n\n- [[2026-07-09]] — filed earlier\n'
    )
  ];
  const { candidates, filed } = rankProjectCandidates(files, TARGET, {
    dailyNoteFolder: DAILY_FOLDER
  });

  assert.deepEqual(filed, ['/wiki/projects/serving.md']);
  assert.ok(
    !candidates.some(
      (candidate) => candidate.path === '/wiki/projects/serving.md'
    )
  );
});

test('never offers the day itself', () => {
  const files = [...CORPUS, markdown(TARGET.path, TARGET.content)];
  const paths = rank(files).candidates.map((candidate) => candidate.path);
  assert.ok(!paths.includes(TARGET.path));
});

test('skips files that are not markdown', () => {
  const paths = rank().candidates.map((candidate) => candidate.path);
  assert.ok(!paths.some((path) => path.endsWith('.png')));
});

test('carries the title, tags, and a snippet into the prompt', () => {
  const { candidates } = rank();
  const triton = candidates.find(
    (candidate) => candidate.path === '/wiki/concepts/triton-serving.md'
  );

  assert.equal(triton.title, 'Triton Serving');
  assert.deepEqual(triton.tags, ['inference']);
  assert.match(triton.snippet, /^Triton batches ONNX/);

  const [system, user] = buildProjectLogMessages(TARGET, candidates);
  assert.equal(system.role, 'developer');
  assert.match(
    user.content,
    /\/wiki\/concepts\/triton-serving\.md — Triton Serving \[tags: inference\]/
  );
  assert.match(user.content, /Triton kept dropping ONNX/);
});

test('reads entries out of a fenced reply', () => {
  const { candidates } = rank();
  const reply =
    'Here you go:\n```json\n[{"path": "/wiki/concepts/triton-serving.md", "summary": "Dropped requests once instances went past four."}]\n```';

  const { entries, warning } = parseProjectLogEntries(reply, candidates);
  assert.equal(warning, undefined);
  assert.deepEqual(entries, [
    {
      path: '/wiki/concepts/triton-serving.md',
      title: 'Triton Serving',
      summary: 'Dropped requests once instances went past four.'
    }
  ]);
});

test('drops paths the model was never offered', () => {
  const { candidates } = rank();
  const reply =
    '[{"path": "/wiki/concepts/invented.md", "summary": "nope"}, {"path": "/wiki/concepts/triton-serving.md", "summary": "yes"}]';

  const { entries, warning } = parseProjectLogEntries(reply, candidates);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['/wiki/concepts/triton-serving.md']
  );
  assert.match(warning, /does not exist/);
});

test('drops an entry with no summary, because a bare backlink says nothing', () => {
  const { candidates } = rank();
  const reply = `[{"path": "${candidates[0].path}", "summary": "  "}]`;

  const { entries, warning } = parseProjectLogEntries(reply, candidates);
  assert.deepEqual(entries, []);
  assert.match(warning, /no summary/);
});

test('caps the number of targets and drops repeats', () => {
  const { candidates } = rank();
  const replies = Array.from({ length: MAX_TARGETS + 3 }, () => ({
    path: candidates[0].path,
    summary: 'same'
  }));

  const { entries } = parseProjectLogEntries(
    JSON.stringify(replies),
    candidates
  );
  assert.equal(entries.length, 1);
});

test('reports an unusable reply instead of throwing', () => {
  const { entries, warning } = parseProjectLogEntries(
    'I could not decide.',
    []
  );
  assert.deepEqual(entries, []);
  assert.match(warning, /did not return/);
});

test('treats an empty list as a valid answer', () => {
  const { entries, warning } = parseProjectLogEntries('[]', []);
  assert.deepEqual(entries, []);
  assert.equal(warning, undefined);
});
