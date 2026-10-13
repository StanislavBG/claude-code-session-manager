import type {
  MemoryAgent,
  MemoryAggregateResult,
  MemoryEntry,
  MemoryStaleResult,
} from '../../../../../preload/api'

export type ExplorerScope = { kind: 'workspace' } | { kind: 'agent'; agent: MemoryAgent }

export type ExplorerView =
  | 'all' | 'ask' | 'clusters' | 'stale' | 'broken' | 'recent' | 'unindexed' | 'archived'
  | `cluster:${string}`

export type SortKey = 'recent' | 'name' | 'size'

export interface MemoryRow {
  name: string
  slug: string
  path: string
  description: string
  bytes: number
  mtimeMs: number
  ageDays: number
  stale: boolean
  staleReasons: string[]
  ageOnlyStale: boolean
  deadRefs: string[]
  broken: boolean
  danglingLinks: string[]
  outLinks: string[]
  inLinks: string[]
  notIndexed: boolean
  clusterId: string | null
  type: string | null
  originSessionId: string | null
}

export interface ClusterInfo {
  id: string
  name: string
  summary: string
  memberSlugs: string[]
  linkCount: number
  staleCount: number
  dotClass: string
}

export const CLUSTER_DOT_CLASSES: readonly string[] = [
  'bg-accent', 'bg-sage-dark', 'bg-honey', 'bg-fg-dim',
  'bg-fg-faint', 'bg-hive-teal', 'bg-butter', 'bg-delta-bad',
]

const DAY_MS = 86_400_000
const INDEX_FILE = 'MEMORY.md'
const MAX_DIFF_LINES = 2000

const stem = (s: string): string => s.replace(/\.md$/, '')

export function buildRows(
  entries: MemoryEntry[],
  stale: MemoryStaleResult | null,
  agg: MemoryAggregateResult | null,
  now: number,
): MemoryRow[] {
  const staleByName = new Map((stale?.entries ?? []).map((e) => [e.name, e]))
  const orphans = new Set(stale?.index?.orphans ?? [])
  const clusterBySlug = new Map<string, string>()
  for (const c of agg?.clusters ?? []) {
    for (const s of c.memberSlugs) if (!clusterBySlug.has(s)) clusterBySlug.set(s, c.id)
  }
  const kept = entries.filter((e) => e.name !== INDEX_FILE)
  const inLinks = new Map<string, string[]>()
  for (const e of kept) {
    const from = stem(e.name)
    const out = staleByName.get(e.name)?.outLinks ?? staleByName.get(from)?.outLinks ?? []
    for (const t of out) {
      const key = stem(t)
      const list = inLinks.get(key) ?? []
      if (!list.includes(from)) list.push(from)
      inLinks.set(key, list)
    }
  }
  return kept.map((e) => {
    const slug = stem(e.name)
    const s = staleByName.get(e.name) ?? staleByName.get(slug)
    const deadRefs = s?.deadRefs ?? []
    const danglingLinks = s?.danglingLinks ?? []
    const isStale = s?.stale ?? false
    return {
      name: e.name,
      slug,
      path: e.path,
      description: s?.description ?? '',
      bytes: e.bytes,
      mtimeMs: e.mtimeMs,
      ageDays: Math.floor((now - e.mtimeMs) / DAY_MS),
      stale: isStale,
      staleReasons: s?.reasons ?? [],
      ageOnlyStale: isStale && deadRefs.length === 0,
      deadRefs,
      broken: deadRefs.length > 0 || danglingLinks.length > 0,
      danglingLinks,
      outLinks: s?.outLinks ?? [],
      inLinks: inLinks.get(slug) ?? [],
      notIndexed: orphans.has(e.name) || orphans.has(slug),
      clusterId: clusterBySlug.get(slug) ?? null,
      type: s?.type ?? null,
      originSessionId: s?.originSessionId ?? null,
    }
  })
}

export function buildClusters(agg: MemoryAggregateResult | null, rows: MemoryRow[]): ClusterInfo[] {
  const staleSlugs = new Set(rows.filter((r) => r.stale).map((r) => r.slug))
  return (agg?.clusters ?? []).map((c, i) => ({
    id: c.id,
    name: c.name,
    summary: c.summary,
    memberSlugs: c.memberSlugs,
    linkCount: c.links.length,
    staleCount: c.memberSlugs.filter((s) => staleSlugs.has(s)).length,
    dotClass: CLUSTER_DOT_CLASSES[i % CLUSTER_DOT_CLASSES.length],
  }))
}

export function searchRows(rows: MemoryRow[], q: string, limit?: number): MemoryRow[] {
  const needle = q.trim().toLowerCase()
  const hits = needle
    ? rows.filter((r) => r.slug.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle))
    : rows
  return limit === undefined ? hits : hits.slice(0, limit)
}

export function filterRows(rows: MemoryRow[], view: ExplorerView, query: string): MemoryRow[] {
  let base: MemoryRow[]
  if (view === 'ask' || view === 'clusters' || view === 'archived') return []
  if (view === 'all') base = rows
  else if (view === 'stale') base = rows.filter((r) => r.stale)
  else if (view === 'broken') base = rows.filter((r) => r.broken)
  else if (view === 'recent') base = rows.filter((r) => Date.now() - r.mtimeMs <= 7 * DAY_MS)
  else if (view === 'unindexed') base = rows.filter((r) => r.notIndexed)
  else if (view === 'cluster:unclustered') base = rows.filter((r) => r.clusterId === null)
  else if (view.startsWith('cluster:')) base = rows.filter((r) => r.clusterId === view.slice('cluster:'.length))
  else base = rows
  return searchRows(base, query)
}

export function sortRows(rows: MemoryRow[], sort: SortKey): MemoryRow[] {
  const out = [...rows]
  if (sort === 'recent') out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  else if (sort === 'name') out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  else out.sort((a, b) => b.bytes - a.bytes)
  return out
}

export function navCounts(rows: MemoryRow[]): {
  all: number; stale: number; broken: number; recent: number; unindexed: number
} {
  return {
    all: rows.length,
    stale: filterRows(rows, 'stale', '').length,
    broken: filterRows(rows, 'broken', '').length,
    recent: filterRows(rows, 'recent', '').length,
    unindexed: filterRows(rows, 'unindexed', '').length,
  }
}

export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'untitled_memory'
}

export function lineDiff(before: string, after: string): { sign: '−' | '+' | ' '; text: string }[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text) => ({ sign: '−' as const, text })),
      ...b.map((text) => ({ sign: '+' as const, text })),
    ]
  }
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: { sign: '−' | '+' | ' '; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ sign: '−', text: a[i++] })
    else out.push({ sign: '+', text: b[j++] })
  }
  while (i < n) out.push({ sign: '−', text: a[i++] })
  while (j < m) out.push({ sign: '+', text: b[j++] })
  return out
}
