/**
 * Control layer on top of PRD 827's `EpicQueue` — search, counted filter
 * chips, group/sort selects, per-section paging, pin-to-top, compact
 * toggle, and j/k keyboard navigation. Filtering/sorting/paging/grouping
 * logic itself lives in `lib/epicQueueControls.ts` (pure, unit-testable);
 * this component is the thin wiring layer + persistence (`state/epicsPrefs.ts`).
 *
 * Built from session-manager-operations/design-mocks/epics/DESIGN_SPEC.md
 * ("Left pane") + epics-mock.jsx's EpicQueue state machine.
 */
import { useEffect, useMemo, useState } from 'react'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { EpicDisplayStatus, EpicSnapshots } from '../../lib/epicDerive'
import { epicKindDotClass, epicKindLabel, epicStatusDotClass, epicStatusLabel } from './epic-primitives'
import { EpicQueue, type EpicQueueSection } from './EpicQueue'
import { FilterPills } from '../ui/FilterPills'
import { useEpicsPrefs } from '../../state/epicsPrefs'
import {
  PAGE,
  PAGE_INCREMENT,
  epicCounts,
  filterEpics,
  groupEpics,
  sortEpics,
  visibleOrder,
  type EpicFilterKey,
  type EpicGroupKey,
  type EpicSortKey,
} from '../../lib/epicQueueControls'

const FILTER_OPTIONS: ReadonlyArray<{ value: EpicFilterKey; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'needs', label: 'Needs you' },
  { value: 'running', label: 'Running' },
  { value: 'pinned', label: 'Pinned' },
  { value: 'all', label: 'All' },
]

const GROUP_OPTIONS: ReadonlyArray<{ value: EpicGroupKey; label: string }> = [
  { value: 'status', label: 'status' },
  { value: 'tag', label: 'tag' },
  { value: 'recency', label: 'recency' },
]

const SORT_OPTIONS: ReadonlyArray<{ value: EpicSortKey; label: string }> = [
  { value: 'recent', label: 'last activity' },
  { value: 'title', label: 'title' },
  { value: 'prdCount', label: 'PRD count' },
  { value: 'tokens', label: 'tokens' },
  { value: 'turns', label: 'turns' },
]

function sectionPresentation(groupBy: EpicGroupKey, key: string): { label: string; dotClass: string } {
  if (groupBy === 'status') {
    const status = key as EpicDisplayStatus
    return { label: epicStatusLabel(status), dotClass: epicStatusDotClass(status) }
  }
  if (groupBy === 'tag') {
    const kind = key as NonNullable<PromptSession['tag']>
    return { label: epicKindLabel(kind), dotClass: epicKindDotClass(kind) }
  }
  return { label: key, dotClass: 'bg-fg-faint' }
}

function MiniSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
}) {
  return (
    <label className="inline-flex items-center gap-1.5 bg-bg-hi border border-line rounded-md pl-2 pr-1 py-1">
      <span className="font-mono text-[10px] uppercase tracking-wide text-fg-faint">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-transparent outline-none cursor-pointer text-[11.5px] font-semibold text-fg pr-0.5"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function CompactToggleIcon() {
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" fill="none" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth={1.4} fill="none" />
      <path d="M13 13l-2.3-2.3" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  )
}

/** Is focus currently in something that should absorb j/k/arrow keys instead of driving selection? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true
  return target.isContentEditable
}

function isCommandPaletteOpen(): boolean {
  return document.querySelector('[data-testid="command-palette-backdrop"]') !== null
}

export interface EpicQueueControlsProps {
  epics: PromptSession[]
  snapshots: EpicSnapshots
  events: Record<string, PromptSessionEvent[]>
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
}

export function EpicQueueControls({ epics, snapshots, events, selectedId, onSelect, onNew, now }: EpicQueueControlsProps) {
  // A per-render Date.now() in the grouping memo's deps would defeat every
  // memo below on every render (PRD 833 I6) — recency buckets only need
  // ~30s resolution, so tick a stable timestamp instead.
  const [autoNow, setAutoNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setAutoNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const nowMs = now ?? autoNow
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<EpicFilterKey>('open')
  const [closedKeys, setClosedKeys] = useState<Set<string>>(() => new Set(['completed']))
  const [limits, setLimits] = useState<Record<string, number>>({})

  const hydrated = useEpicsPrefs((s) => s.hydrated)
  const hydrate = useEpicsPrefs((s) => s.hydrate)
  const pins = useEpicsPrefs((s) => s.pins)
  const togglePin = useEpicsPrefs((s) => s.togglePin)
  const group = useEpicsPrefs((s) => s.group)
  const setGroup = useEpicsPrefs((s) => s.setGroup)
  const sort = useEpicsPrefs((s) => s.sort)
  const setSort = useEpicsPrefs((s) => s.setSort)
  const compact = useEpicsPrefs((s) => s.compact)
  const setCompact = useEpicsPrefs((s) => s.setCompact)

  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  const pinSet = useMemo(() => new Set(Object.keys(pins).filter((id) => pins[id])), [pins])

  const counts = useMemo(() => epicCounts(epics, snapshots, pinSet), [epics, snapshots, pinSet])

  const matches = useMemo(
    () => filterEpics(epics, snapshots, filter, pinSet, search),
    [epics, snapshots, filter, pinSet, search],
  )
  const sorted = useMemo(() => sortEpics(matches, sort, snapshots, events), [matches, sort, snapshots, events])

  const pinnedRows = useMemo(() => sorted.filter((e) => pinSet.has(e.id)), [sorted, pinSet])
  const unpinnedRows = useMemo(() => sorted.filter((e) => !pinSet.has(e.id)), [sorted, pinSet])

  const groups = useMemo(
    () => groupEpics(unpinnedRows, group, snapshots, events, nowMs),
    [unpinnedRows, group, snapshots, events, nowMs],
  )

  const sections = useMemo<EpicQueueSection[]>(
    () =>
      groups.map((g) => {
        const limit = limits[g.key] ?? PAGE
        const { label, dotClass } = sectionPresentation(group, g.key)
        return { key: g.key, label, dotClass, items: g.items.slice(0, limit), total: g.items.length }
      }),
    [groups, limits, group],
  )

  const onShowMore = (key: string) => {
    setLimits((prev) => ({ ...prev, [key]: (prev[key] ?? PAGE) + PAGE_INCREMENT }))
  }

  const flatOrder = useMemo(
    () => visibleOrder(pinnedRows, sections, closedKeys, limits),
    [pinnedRows, sections, closedKeys, limits],
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isCommandPaletteOpen()) return
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (flatOrder.length === 0) return
      e.preventDefault()
      const delta = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
      const i = flatOrder.findIndex((ep) => ep.id === selectedId)
      const nextIndex = Math.min(flatOrder.length - 1, Math.max(0, i < 0 ? 0 : i + delta))
      const next = flatOrder[nextIndex]
      if (next) onSelect(next.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [flatOrder, selectedId, onSelect])

  const clearFilters = () => {
    setSearch('')
    setFilter('all')
  }

  // Distinguish "no Epics exist at all" (EpicQueue's own default empty
  // state — "No Epics yet" + New Epic CTA) from "the current search/filter
  // matched nothing" (this component's job — offer Clear filters).
  const searchNoMatch = epics.length > 0 && sections.length === 0 && pinnedRows.length === 0
  const emptyState = searchNoMatch
    ? {
        title: search ? `No Epics match "${search}".` : 'No Epics match these filters.',
        hint: (
          <button type="button" onClick={clearFilters} className="mt-1.5 text-accent font-semibold text-xs">
            Clear filters
          </button>
        ),
      }
    : undefined

  const filters = (
    <div className="px-3.5 pb-2.5 border-b border-line flex flex-col gap-2.5">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none">
          <SearchIcon />
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${epics.length} Epics`}
          aria-label="Search Epics"
          className="w-full bg-bg border border-line rounded-md py-1.5 pl-8 pr-7 text-[12.5px] text-fg outline-none focus:border-fg-faint"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint hover:text-fg"
          >
            <XIcon />
          </button>
        )}
      </div>

      <FilterPills
        value={filter}
        onChange={setFilter}
        pillPadding="px-2 py-1"
        options={FILTER_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          count: o.value === 'open' ? counts.open : o.value === 'needs' ? counts.needs : o.value === 'running' ? counts.running : o.value === 'pinned' ? counts.pinned : counts.all,
        }))}
      />

      <div className="flex items-center gap-1.5">
        <MiniSelect label="group" value={group} onChange={setGroup} options={GROUP_OPTIONS} />
        <MiniSelect label="sort" value={sort} onChange={setSort} options={SORT_OPTIONS} />
        <button
          type="button"
          onClick={() => setCompact(!compact)}
          title={compact ? 'Comfortable rows' : 'Compact rows'}
          aria-pressed={compact}
          className={`ml-auto w-7 h-[26px] grid place-items-center rounded-md border ${
            compact ? 'border-line bg-bg-hi text-accent' : 'border-line text-fg-faint'
          }`}
        >
          <CompactToggleIcon />
        </button>
      </div>
    </div>
  )

  const footer = (
    <div className="border-t border-line px-3 py-1.5 flex items-center gap-2.5 bg-bg-elev">
      <span className="font-mono text-[10.5px] text-fg-faint">
        {sorted.length} shown · {counts.needs} need you
      </span>
      <span className="ml-auto font-mono text-[10px] text-fg-faint">j / k to move</span>
    </div>
  )

  return (
    <EpicQueue
      epics={epics}
      snapshots={snapshots}
      events={events}
      selectedId={selectedId}
      onSelect={onSelect}
      onNew={onNew}
      compact={compact}
      now={nowMs}
      sections={sections}
      pinnedEpics={pinnedRows}
      onPin={togglePin}
      onShowMore={onShowMore}
      emptyState={emptyState}
      closedKeys={closedKeys}
      onToggleSection={(key) =>
        setClosedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
      filters={filters}
      footer={footer}
    />
  )
}
