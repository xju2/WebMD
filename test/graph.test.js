import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGraph } from '../src/graph.js';

const graph = {
  nodes: [
    { path: '/wiki/a.md', name: 'a', group: 'wiki' },
    { path: '/wiki/b.md', name: 'b', group: 'wiki' },
    { path: '/raw/c.md', name: 'c', group: 'raw' }
  ],
  edges: [
    { source: '/wiki/a.md', target: '/wiki/b.md' },
    { source: '/raw/c.md', target: '/wiki/a.md' }
  ]
};

test('lays out wiki, local, and full graph scopes', () => {
  assert.equal(layoutGraph(graph, 'wiki').nodes.length, 2);
  assert.equal(layoutGraph(graph, 'local', '/raw/c.md').nodes.length, 2);
  const full = layoutGraph(graph, 'all');
  assert.equal(full.nodes.length, 3);
  assert.equal(full.edges.length, 2);
  assert.ok(full.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});
