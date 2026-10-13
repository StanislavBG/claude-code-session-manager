import { describe, expect, it } from 'vitest'
import {
  CLUSTER_DOT_CLASSES, buildClusters, buildRows, filterRows, lineDiff, navCounts,
  searchRows, slugFromTitle, sortRows,
} from '../memory/explorer/model'
import { MEMORY_SLUG_RE } from '../../../lib/memorySlug'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

const entries = [
  { name: 'MEMORY.md', path: '/m/MEMORY.md', mtimeMs: NOW, bytes: 10 },
  { name: 'alpha.md', path: '/m/alpha.md', mtimeMs: NOW - 2 * DAY, bytes: 300 },
  { name: 'beta.md', path: '/m/beta.md', mtimeMs: NOW - 30 * DAY, bytes: 100 },
  { name: 'gamma.md', path: '/m/gamma.md', mtimeMs: NOW - 10 * DAY, bytes: 200 },
]
const se = (name: string, o: object = {}) => ({
  name, ageDays: 0, inboundLinks: 0, deadRefs: [], stale: false, reasons: [],
  description: null, type: null, originSessionId: null, outLinks: [], danglingLinks: [], ...o,
})
const stale = {
  workspace: 'w', error: null,
  entries: [
    se('alpha.md', { outLinks: ['beta'], description: 'Deploy Notes', type: 'project' }),
    se('beta.md', { stale: true, reasons: ['old'], danglingLinks: ['nope'] }),
    se('gamma.md', { stale: true, deadRefs: ['x.ts'], outLinks: ['beta'] }),
  ],
  index: { lines: 1, bytes: 1, maxLines: 200, maxBytes: 1, overBudget: false, nearBudget: false, orphans: ['gamma.md'], dangling: [] },
}
const agg = {
  workspace: 'w', generatedAt: 1, cached: true, orphans: [],
  clusters: [
    { id: 'c1', name: 'One', summary: 's', memberSlugs: ['alpha', 'beta'], links: [{ from: 'alpha', to: 'beta' }] },
    { id: 'c2', name: 'Two', summary: 's', memberSlugs: ['zzz'], links: [] },
  ],
}

describe('buildRows', () => {
  const rows = buildRows(entries, stale, agg, NOW)
  const by = (s: string) => rows.find((r) => r.slug === s)!
  it('excludes MEMORY.md and computes ageDays', () => {
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'beta', 'gamma'])
    expect(by('beta').ageDays).toBe(30)
  })
  it('inverts outLinks', () => {
    expect(by('beta').inLinks.sort()).toEqual(['alpha', 'gamma'])
    expect(by('alpha').inLinks).toEqual([])
  })
  it('broken / notIndexed / ageOnlyStale / clusterId', () => {
    expect(by('beta').broken).toBe(true)
    expect(by('gamma').broken).toBe(true)
    expect(by('alpha').broken).toBe(false)
    expect(by('gamma').notIndexed).toBe(true)
    expect(by('beta').ageOnlyStale).toBe(true)
    expect(by('gamma').ageOnlyStale).toBe(false)
    expect(by('alpha').clusterId).toBe('c1')
    expect(by('gamma').clusterId).toBeNull()
    expect(by('alpha').description).toBe('Deploy Notes')
  })
  it('falls back with null stale/agg', () => {
    const r = buildRows(entries, null, null, NOW)[0]
    expect(r).toMatchObject({ description: '', outLinks: [], inLinks: [], clusterId: null, stale: false, broken: false, notIndexed: false })
  })
})

describe('filterRows / sortRows / navCounts', () => {
  const rows = buildRows(entries, stale, agg, NOW)
  const slugs = (r: typeof rows) => r.map((x) => x.slug)
  it('views', () => {
    for (const v of ['ask', 'clusters', 'archived'] as const) expect(filterRows(rows, v, '')).toEqual([])
    expect(slugs(filterRows(rows, 'all', ''))).toHaveLength(3)
    expect(slugs(filterRows(rows, 'stale', ''))).toEqual(['beta', 'gamma'])
    expect(slugs(filterRows(rows, 'broken', ''))).toEqual(['beta', 'gamma'])
    expect(slugs(filterRows(rows, 'unindexed', ''))).toEqual(['gamma'])
    expect(slugs(filterRows(rows, 'cluster:c1', ''))).toEqual(['alpha', 'beta'])
    expect(slugs(filterRows(rows, 'cluster:unclustered', ''))).toEqual(['gamma'])
  })
  it('recent = within 7 days', () => {
    const real = Date.now
    Date.now = () => NOW
    try { expect(slugs(filterRows(rows, 'recent', ''))).toEqual(['alpha']) } finally { Date.now = real }
  })
  it('query is case-insensitive over slug/description', () => {
    expect(slugs(filterRows(rows, 'all', 'DEPLOY'))).toEqual(['alpha'])
    expect(slugs(filterRows(rows, 'all', 'GAM'))).toEqual(['gamma'])
  })
  it('sorts', () => {
    expect(slugs(sortRows(rows, 'recent'))).toEqual(['alpha', 'gamma', 'beta'])
    expect(slugs(sortRows(rows, 'name'))).toEqual(['alpha', 'beta', 'gamma'])
    expect(slugs(sortRows(rows, 'size'))).toEqual(['alpha', 'gamma', 'beta'])
  })
  it('searchRows limit', () => {
    expect(searchRows(rows, '', 2)).toHaveLength(2)
    expect(searchRows(rows, 'a')).toHaveLength(3)
  })
  it('navCounts', () => {
    const real = Date.now
    Date.now = () => NOW
    try { expect(navCounts(rows)).toEqual({ all: 3, stale: 2, broken: 2, recent: 1, unindexed: 1 }) } finally { Date.now = real }
  })
})

describe('buildClusters', () => {
  it('dotClass wraps, counts', () => {
    const rows = buildRows(entries, stale, agg, NOW)
    const cs = buildClusters(agg, rows)
    expect(cs[0]).toMatchObject({ id: 'c1', linkCount: 1, staleCount: 1, dotClass: CLUSTER_DOT_CLASSES[0] })
    expect(cs[1].dotClass).toBe(CLUSTER_DOT_CLASSES[1])
    const many = { ...agg, clusters: Array.from({ length: 9 }, (_, i) => ({ ...agg.clusters[1], id: `k${i}` })) }
    expect(buildClusters(many, rows)[8].dotClass).toBe(CLUSTER_DOT_CLASSES[0])
    expect(buildClusters(null, rows)).toEqual([])
  })
})

describe('slugFromTitle', () => {
  it('slugifies', () => {
    expect(slugFromTitle('Deploy freeze Fridays!')).toBe('deploy_freeze_fridays')
    expect(slugFromTitle('')).toBe('untitled_memory')
    expect(slugFromTitle('!!!')).toBe('untitled_memory')
    for (const t of ['Hello World', '***', 'ünï cödé']) expect(MEMORY_SLUG_RE.test(slugFromTitle(t))).toBe(true)
  })
})

describe('lineDiff', () => {
  it('only changed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([{ sign: '−', text: 'b' }, { sign: '+', text: 'x' }])
    expect(lineDiff('a', 'a')).toEqual([])
  })
  it('handles empty sides', () => {
    expect(lineDiff('', 'a')).toEqual([{ sign: '+', text: 'a' }])
    expect(lineDiff('a', '')).toEqual([{ sign: '−', text: 'a' }])
  })
})
