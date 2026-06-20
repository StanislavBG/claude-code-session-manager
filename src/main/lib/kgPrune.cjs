'use strict';

/**
 * kgPrune.cjs — decay-based node eviction for per-project knowledge graphs.
 *
 * API:
 *   nodeEvictionScore(node, degree, nowMs) → number   (higher = keep)
 *   pruneGraph(graph, maxNodes, nowMs)     → { nodes, edges, evicted }
 *
 * Complexity:
 *   nodeEvictionScore: O(1)
 *   pruneGraph: O(E + N log N) where N=nodes, E=edges
 *     - one O(E) pass to build degree map
 *     - one O(N log N) sort to select top-maxNodes
 *     - one O(E) pass to drop dangling edges
 */

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const W_RECENCY = 0.5;  // freshness — recently-touched nodes stay relevant
const W_DEGREE  = 0.3;  // connectivity — hubs link disparate ideas together
const W_COUNT   = 0.2;  // frequency — often-mentioned = important to the dev

/**
 * Score a node for retention. Higher = more worth keeping.
 *
 * Weighting rationale:
 *   Recency (50%): a node last seen 30 days ago decays to ~50% of a just-seen
 *   node — exponential decay keeps the graph current without hard cutoffs.
 *   Degree (30%): hub nodes (many connections) preserve graph coherence; without
 *   them the remaining graph fragments into disconnected islands.
 *   Count (20%): how often the developer mentioned something matters, but a
 *   high-count stale node should still decay below a freshly-active low-count one.
 *
 * @param {object} node    KgNode with lastTs (ISO string|null), count (number)
 * @param {number} degree  edge count touching this node (src or dst)
 * @param {number} nowMs   Date.now() equivalent from caller (kept pure/testable)
 * @returns {number}
 */
function nodeEvictionScore(node, degree, nowMs) {
  let recency = 0;
  if (node.lastTs) {
    const ageMs = nowMs - new Date(node.lastTs).getTime();
    recency = Math.exp(-ageMs / HALF_LIFE_MS);   // 1.0 = just seen, decays to 0
  }
  const degScore  = Math.log1p(degree);           // log scale: 0→0, 1→0.69, 10→2.4
  const cntScore  = Math.log1p(node.count ?? 0);  // same — avoids linear blow-up
  return W_RECENCY * recency + W_DEGREE * degScore + W_COUNT * cntScore;
}

/**
 * Prune a graph to at most maxNodes nodes, evicting the lowest-scored ones and
 * all edges that referenced evicted nodes.
 *
 * @param {{ nodes: object[], edges: object[] }} graph
 * @param {number} maxNodes  cap; 0 = disabled (returns graph unchanged)
 * @param {number} nowMs     caller-supplied timestamp (keeps scorer pure)
 * @returns {{ nodes: object[], edges: object[], evicted: number }}
 */
function pruneGraph(graph, maxNodes, nowMs) {
  if (!maxNodes || graph.nodes.length <= maxNodes) {
    return { nodes: graph.nodes, edges: graph.edges, evicted: 0 };
  }

  // O(E): build id → degree map in a single pass over edges.
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  // O(N log N): score + sort; keep the top maxNodes.
  const scored = graph.nodes.map((n) => ({ n, s: nodeEvictionScore(n, degree.get(n.id) ?? 0, nowMs) }));
  scored.sort((a, b) => b.s - a.s);   // descending: highest score first
  const kept = scored.slice(0, maxNodes);
  const evicted = scored.length - kept.length;

  if (evicted === 0) return { nodes: graph.nodes, edges: graph.edges, evicted: 0 };

  const keptIds = new Set(kept.map((x) => x.n.id));

  // O(E): drop every edge whose src or dst was evicted (no dangling references).
  const edges = graph.edges.filter((e) => keptIds.has(e.src) && keptIds.has(e.dst));

  return { nodes: kept.map((x) => x.n), edges, evicted };
}

module.exports = { nodeEvictionScore, pruneGraph };
