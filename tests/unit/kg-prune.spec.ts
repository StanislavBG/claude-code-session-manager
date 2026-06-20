import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { nodeEvictionScore, pruneGraph } = require('../../src/main/lib/kgPrune.cjs') as {
  nodeEvictionScore: (node: { lastTs: string | null; count: number }, degree: number, nowMs: number) => number
  pruneGraph: (
    graph: { nodes: { id: string; lastTs: string | null; count: number }[]; edges: { src: string; dst: string; relation: string; weight: number; lastTs: string | null }[] },
    maxNodes: number,
    nowMs: number
  ) => { nodes: { id: string }[]; edges: { src: string; dst: string }[]; evicted: number }
}

const NOW = new Date('2026-01-01T00:00:00Z').getTime()
const RECENT = new Date('2025-12-31T00:00:00Z').toISOString()
const STALE  = new Date('2025-01-01T00:00:00Z').toISOString() // ~1 year old

function makeNode(id: string, lastTs: string | null = null, count = 1) {
  return { id, key: id, name: id, type: 'concept', description: '', count, firstTs: null, lastTs }
}

function makeEdge(src: string, dst: string, relation = 'related_to') {
  return { src, dst, relation, weight: 1, lastTs: null }
}

describe('nodeEvictionScore', () => {
  test('recent node scores higher than stale node (same degree + count)', () => {
    const recent = nodeEvictionScore({ lastTs: RECENT, count: 1 }, 0, NOW)
    const stale  = nodeEvictionScore({ lastTs: STALE,  count: 1 }, 0, NOW)
    expect(recent).toBeGreaterThan(stale)
  })

  test('well-connected node scores higher than isolated node (same recency + count)', () => {
    const hub      = nodeEvictionScore({ lastTs: RECENT, count: 1 }, 10, NOW)
    const isolated = nodeEvictionScore({ lastTs: RECENT, count: 1 }, 0,  NOW)
    expect(hub).toBeGreaterThan(isolated)
  })

  test('frequently-seen node scores higher than rare node (same recency + degree)', () => {
    const frequent = nodeEvictionScore({ lastTs: RECENT, count: 20 }, 0, NOW)
    const rare     = nodeEvictionScore({ lastTs: RECENT, count: 1  }, 0, NOW)
    expect(frequent).toBeGreaterThan(rare)
  })

  test('node with null lastTs scores lower than a stale node', () => {
    const missing = nodeEvictionScore({ lastTs: null,  count: 1 }, 0, NOW)
    const stale   = nodeEvictionScore({ lastTs: STALE, count: 1 }, 0, NOW)
    expect(missing).toBeLessThan(stale)
  })

  test('recent + well-connected + frequent beats stale + isolated + rare', () => {
    const best  = nodeEvictionScore({ lastTs: RECENT, count: 20 }, 10, NOW)
    const worst = nodeEvictionScore({ lastTs: STALE,  count: 1  }, 0,  NOW)
    expect(best).toBeGreaterThan(worst)
  })
})

describe('pruneGraph', () => {
  test('no-op when node count is at the cap', () => {
    const nodes = [makeNode('a'), makeNode('b')]
    const edges = [makeEdge('a', 'b')]
    const result = pruneGraph({ nodes, edges }, 2, NOW)
    expect(result.evicted).toBe(0)
    expect(result.nodes).toBe(nodes)  // same reference — unchanged
    expect(result.edges).toBe(edges)
  })

  test('no-op when node count is below the cap', () => {
    const nodes = [makeNode('a')]
    const edges: ReturnType<typeof makeEdge>[] = []
    const result = pruneGraph({ nodes, edges }, 5, NOW)
    expect(result.evicted).toBe(0)
  })

  test('no-op when maxNodes === 0 (cap disabled)', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`n${i}`, STALE))
    const edges: ReturnType<typeof makeEdge>[] = []
    const result = pruneGraph({ nodes, edges }, 0, NOW)
    expect(result.evicted).toBe(0)
    expect(result.nodes.length).toBe(10)
  })

  test('keeps exactly maxNodes when over the cap', () => {
    const nodes = [
      makeNode('frequent', RECENT, 50),
      makeNode('hub',      RECENT, 1),
      makeNode('stale',    STALE,  1),
    ]
    const edges = [makeEdge('frequent', 'hub'), makeEdge('hub', 'stale')]
    const result = pruneGraph({ nodes, edges }, 2, NOW)
    expect(result.nodes.length).toBe(2)
    expect(result.evicted).toBe(1)
  })

  test('removes dangling edges — no edge referencing an evicted node', () => {
    const nodes = [
      makeNode('a', RECENT, 50),  // high score — kept
      makeNode('b', STALE,  1),   // low score — evicted
      makeNode('c', RECENT, 30),  // kept
    ]
    const edges = [
      makeEdge('a', 'b'),  // b evicted → should be dropped
      makeEdge('a', 'c'),  // both kept → should survive
      makeEdge('b', 'c'),  // b evicted → should be dropped
    ]
    const result = pruneGraph({ nodes, edges }, 2, NOW)
    expect(result.nodes.length).toBe(2)
    const ids = new Set(result.nodes.map((n) => n.id))
    for (const e of result.edges) {
      expect(ids.has(e.src)).toBe(true)
      expect(ids.has(e.dst)).toBe(true)
    }
  })

  test('zero dangling edges when all edges reference evicted nodes', () => {
    const nodes = [
      makeNode('keep',  RECENT, 100),
      makeNode('drop1', STALE,  1),
      makeNode('drop2', STALE,  1),
    ]
    const edges = [makeEdge('drop1', 'drop2')]
    const result = pruneGraph({ nodes, edges }, 1, NOW)
    expect(result.nodes.length).toBe(1)
    expect(result.nodes[0].id).toBe('keep')
    expect(result.edges.length).toBe(0)
  })

  test('evicted count matches nodes removed', () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode(`n${i}`, i < 5 ? RECENT : STALE, i < 5 ? 10 : 1)
    )
    const edges: ReturnType<typeof makeEdge>[] = []
    const result = pruneGraph({ nodes, edges }, 5, NOW)
    expect(result.evicted).toBe(5)
    expect(result.nodes.length).toBe(5)
  })
})
