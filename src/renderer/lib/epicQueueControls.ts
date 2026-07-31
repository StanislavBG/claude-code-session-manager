/**
 * Pure filter/sort/group/paging/keyboard-nav logic for the Epic queue's
 * control layer (search, filter chips, group/sort selects, per-section
 * paging, pin-to-top). No DOM, no React — unit-testable in isolation.
 * `EpicQueueControls.tsx` is the thin container that wires this to
 * `EpicQueue`. Mirrors session-manager-operations/design-mocks/epics/
 * epics-mock.jsx's EpicQueue state machine (matches/sorted/sections/flat).
 */
import type { PromptSession, PromptSessionEvent } from '../state/promptSessions'
import { epicDisplayStatus, epicPrds, epicStats, type EpicDisplayStatus, type EpicSnapshots } from './epicDerive'

export type EpicFilterKey = 'open' | 'needs' | 'running' | 'pinned' | 'all'
export type EpicGroupKey = 'status' | 'tag' | 'recency'
export type EpicSortKey = 'recent' | 'title' | 'prdCount' | 'tokens' | 'turns'

/** First page size per section; "show more" reveals this many additional rows. */
export const PAGE = 18
export const PAGE_INCREMENT = 40

export const STATUS_GROUP_ORDER: EpicDisplayStatus[] = ['running', 'needs', 'queued', 'draft', 'completed']
export const TAG_GROUP_ORDER: ReadonlyArray<string> = ['feature', 'bug', 'discussion']
export const RECENCY_GROUP_ORDER: ReadonlyArray<string> = ['Today', 'This week', 'This month', 'Older']

export interface EpicCounts {
  open: number
  needs: number
  running: number
  pinned: number
  all: number
}

/** O(n) over `epics` — one pass, no nested loops. */
export function epicCounts(
  epics: readonly PromptSession[],
  snapshots: EpicSnapshots,
  pins: ReadonlySet<string>,
): EpicCounts {
  let needs = 0
  let running = 0
  let completed = 0
  let pinned = 0
  for (const epic of epics) {
    const status = epicDisplayStatus(epic.id, snapshots)
    if (status === 'needs') needs++
    else if (status === 'running') running++
    else if (status === 'completed') completed++
    if (pins.has(epic.id)) pinned++
  }
  // Intersected with the live `epics` list, not `pins.size` — a persisted
  // pin can outlive the epic it pointed to (archived/deleted/other
  // project), and the chip must reflect what's actually reachable here.
  return { open: epics.length - completed, needs, running, pinned, all: epics.length }
}

/** Last-activity timestamp (ms) — most recent event, falling back to createdAt. */
export function lastActivityMs(epic: PromptSession, events: Record<string, PromptSessionEvent[]>): number {
  const tail = events[epic.id]?.slice(-1)[0] ?? null
  const at = tail?.at ?? epic.createdAt
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? 0 : ms
}

/** Search matches title (== goalText, there is no separate title field) + goal + kind/tag. */
export function matchesSearch(epic: PromptSession, needle: string): boolean {
  if (!needle) return true
  const haystack = `${epic.goalText} ${epic.tag ?? ''}`.toLowerCase()
  return haystack.includes(needle.toLowerCase())
}

export function filterEpics(
  epics: readonly PromptSession[],
  snapshots: EpicSnapshots,
  filter: EpicFilterKey,
  pins: ReadonlySet<string>,
  search: string,
): PromptSession[] {
  const needle = search.trim().toLowerCase()
  return epics.filter((epic) => {
    const status = epicDisplayStatus(epic.id, snapshots)
    const passesFilter =
      filter === 'all'
        ? true
        : filter === 'pinned'
          ? pins.has(epic.id)
          : filter === 'open'
            ? status !== 'completed'
            : filter === status
    return passesFilter && matchesSearch(epic, needle)
  })
}

export function sortEpics(
  epics: readonly PromptSession[],
  sort: EpicSortKey,
  snapshots: EpicSnapshots,
  events: Record<string, PromptSessionEvent[]>,
): PromptSession[] {
  const copy = [...epics]
  if (sort === 'title') {
    copy.sort((a, b) => a.goalText.localeCompare(b.goalText))
    return copy
  }
  if (sort === 'prdCount') {
    // Precompute each epic's PRD count once (O(n)) rather than re-joining
    // prds/jobs inside the O(n log n) comparator.
    const counts = new Map(copy.map((e) => [e.id, epicPrds(e.id, snapshots).length]))
    copy.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
    return copy
  }
  if (sort === 'tokens') {
    const totals = new Map(
      copy.map((e) => {
        const usage = snapshots.usage?.[e.id]
        return [e.id, usage ? usage.inputTokens + usage.outputTokens : 0]
      }),
    )
    copy.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0))
    return copy
  }
  if (sort === 'turns') {
    const totals = new Map(copy.map((e) => [e.id, epicStats(e.id, snapshots)?.turns ?? 0]))
    copy.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0))
    return copy
  }
  copy.sort((a, b) => lastActivityMs(b, events) - lastActivityMs(a, events))
  return copy
}

export function recencyBucket(epic: PromptSession, events: Record<string, PromptSessionEvent[]>, now: number): string {
  const hours = (now - lastActivityMs(epic, events)) / 3_600_000
  if (hours < 24) return 'Today'
  if (hours < 24 * 7) return 'This week'
  if (hours < 24 * 30) return 'This month'
  return 'Older'
}

export interface GroupedSection {
  key: string
  items: PromptSession[]
}

function groupKeyOrder(groupBy: EpicGroupKey): ReadonlyArray<string> {
  if (groupBy === 'status') return STATUS_GROUP_ORDER
  if (groupBy === 'tag') return TAG_GROUP_ORDER
  return RECENCY_GROUP_ORDER
}

/** Buckets already-filtered/sorted epics by the chosen dimension, in a stable display order. */
export function groupEpics(
  epics: readonly PromptSession[],
  groupBy: EpicGroupKey,
  snapshots: EpicSnapshots,
  events: Record<string, PromptSessionEvent[]>,
  now: number,
): GroupedSection[] {
  const buckets = new Map<string, PromptSession[]>()
  for (const epic of epics) {
    const key =
      groupBy === 'status'
        ? epicDisplayStatus(epic.id, snapshots)
        : groupBy === 'tag'
          ? (epic.tag ?? 'discussion')
          : recencyBucket(epic, events, now)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(epic)
  }
  return groupKeyOrder(groupBy)
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, items: buckets.get(key)! }))
}

/**
 * Selection order for j/k navigation: pinned rows first, then each open
 * (non-collapsed) section's rows up to its current page limit — mirrors
 * exactly what's rendered on screen, so keyboard nav never lands on a
 * hidden row.
 */
export function visibleOrder(
  pinned: readonly PromptSession[],
  sections: readonly GroupedSection[],
  closedKeys: ReadonlySet<string>,
  limits: Readonly<Record<string, number>>,
): PromptSession[] {
  const out: PromptSession[] = [...pinned]
  for (const section of sections) {
    if (closedKeys.has(section.key)) continue
    const limit = limits[section.key] ?? PAGE
    out.push(...section.items.slice(0, limit))
  }
  return out
}
