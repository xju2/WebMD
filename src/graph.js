const WIDTH = 1000;
const HEIGHT = 700;

export function layoutGraph(graph, scope = 'wiki', currentPath = '') {
  const selected = new Set(
    scope === 'all'
      ? graph.nodes.map((node) => node.path)
      : scope === 'local'
        ? localPaths(graph, currentPath)
        : graph.nodes
            .filter((node) => node.path.startsWith('/wiki/'))
            .map((node) => node.path)
  );
  const edges = graph.edges.filter(
    (edge) => selected.has(edge.source) && selected.has(edge.target)
  );
  const degrees = new Map();
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  const nodes = graph.nodes
    .filter((node) => selected.has(node.path))
    .map((node, index, visible) => {
      const angle = (index / Math.max(visible.length, 1)) * Math.PI * 2;
      const radius = 120 + (hash(node.path) % 170);
      return {
        ...node,
        degree: degrees.get(node.path) || 0,
        radius: 5 + Math.min(degrees.get(node.path) || 0, 20) * 0.25,
        x: WIDTH / 2 + Math.cos(angle) * radius,
        y: HEIGHT / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0
      };
    });
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const linked = edges.map((edge) => ({
    source: byPath.get(edge.source),
    target: byPath.get(edge.target)
  }));

  // ponytail: O(n²) force layout is plenty for personal wikis; use Canvas/WebGL
  // with a spatial index when visible graphs reach thousands of nodes.
  for (let step = 0; step < 140; step += 1) {
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left];
        const b = nodes[right];
        const dx = b.x - a.x || 0.1;
        const dy = b.y - a.y || 0.1;
        const distanceSquared = dx * dx + dy * dy;
        const distance = Math.sqrt(distanceSquared);
        const force = 1000 / Math.max(distanceSquared, 100);
        a.vx -= (dx / distance) * force;
        a.vy -= (dy / distance) * force;
        b.vx += (dx / distance) * force;
        b.vy += (dy / distance) * force;
      }
    }
    for (const edge of linked) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = (distance - 90) * 0.006;
      edge.source.vx += (dx / distance) * force;
      edge.source.vy += (dy / distance) * force;
      edge.target.vx -= (dx / distance) * force;
      edge.target.vy -= (dy / distance) * force;
    }
    for (const node of nodes) {
      node.vx = (node.vx + (WIDTH / 2 - node.x) * 0.002) * 0.76;
      node.vy = (node.vy + (HEIGHT / 2 - node.y) * 0.002) * 0.76;
      node.x = Math.max(30, Math.min(WIDTH - 30, node.x + node.vx));
      node.y = Math.max(30, Math.min(HEIGHT - 30, node.y + node.vy));
    }
  }

  return { nodes, edges: linked };
}

function localPaths(graph, currentPath) {
  if (!currentPath) return [];
  const paths = new Set([currentPath]);
  for (const edge of graph.edges) {
    if (edge.source === currentPath) paths.add(edge.target);
    if (edge.target === currentPath) paths.add(edge.source);
  }
  return [...paths];
}

function hash(value) {
  let result = 0;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}
