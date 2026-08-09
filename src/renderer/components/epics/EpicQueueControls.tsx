/**
 * Control layer on top of PRD 827's `EpicQueue` — search, the three filter
 * dropdowns, per-section paging, pin-to-top, row density, and j/k keyboard
 * navigation. Filtering/sorting/paging/grouping logic itself lives in
 * `lib/epicQueueControls.ts` (pure, unit-testable); this component is the thin
 * wiring layer + persistence (`state/epicsPrefs.ts`).
 *
 * What it renders is the sessions widget's **head bar**, handed to EpicQueue as
 * `filters` and drawn as the top row of the widget itself. The left pane is
 * deliberately two sections — Hot keys, then this widget — so filtering is
 * chrome belonging to the tiles, not a third band of pane furniture above them.
 *
 * Status/group/sort are three PEER dropdowns ("show / group / sort"). Status
 * used to be five counted pills that wrapped to two lines in a 352px pane for a
 * control that only ever holds one value; the counts moved into the option
 * labels so nothing was lost. Only search (input) and density (icon) stay
 * behind toggles.
 *
 * Built from session-manager-operations/design-mocks/epics/DESIGN_SPEC.md
 * ("Left pane") + epics-mock.jsx's EpicQueue state machine.
 */
import { useEffect, useMemo, useState } from 'react'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { EpicDisplayStatus, EpicSnapshots } from '../../lib/epicDerive'
import { epicKindDotClass, epicKindLabel, epicStatusDotClass, epicStatusLabel } from './epic-primitives'
import { EpicQueue, type EpicQueueSection } from './EpicQueue'
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
  const [searchOpen, setSearchOpen] = useState(false)
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

  // Distinguish "no sessions exist at all" (EpicQueue's own default empty
  // state — "No sessions yet" + New Epic CTA) from "the current search/filter
  // matched nothing" (this component's job — offer Clear filters).
  const searchNoMatch = epics.length > 0 && sections.length === 0 && pinnedRows.length === 0
  const emptyState = searchNoMatch
    ? {
        title: search ? `No sessions match "${search}".` : 'No sessions match these filters.',
        hint: (
          <button type="button" onClick={clearFilters} className="mt-1.5 text-accent font-semibold text-xs">
            Clear filters
          </button>
        ),
      }
    : undefined

  // The HEAD BAR of the sessions widget (EpicQueue renders it as the widget's
  // top row, above the tiles). The pane above it is Hot keys and nothing else.
  //
  // Status is ONE dropdown, defaulting to Open — it used to be five counted
  // pills that wrapped onto two lines inside a 352px pane and pushed the tiles
  // down by a whole row for a control that only ever holds one value at a
  // time. Counts ride in the option labels, so nothing is lost, and it now
  // matches group and sort instead of being a third kind of control: three
  // peer dropdowns reading "show / group / sort".
  //
  // `searchOpen` is forced open while a query is active so a filtered list can
  // never look unfiltered.
  const showSearch = searchOpen || !!search
  const filterOptionsWithCounts = FILTER_OPTIONS.map((o) => ({
    value: o.value,
    label: `${o.label} ${
      o.value === 'open' ? counts.open
      : o.value === 'needs' ? counts.needs
      : o.value === 'running' ? counts.running
      : o.value === 'pinned' ? counts.pinned
      : counts.all
    }`,
  }))
  const filters = (
    <div className="px-3 pb-2 pt-2 border-b border-line bg-bg-elev flex flex-col gap-1.5" data-testid="epic-queue-filters">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold tracking-[1.1px] uppercase text-fg-faint">Sessions</span>
        <span className="font-mono text-[10.5px] text-fg-faint">{epics.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          title="Search sessions"
          aria-label="Search sessions"
          aria-pressed={showSearch}
          data-testid="epic-queue-search-toggle"
          className={`shrink-0 w-6 h-6 grid place-items-center rounded border ${
            showSearch ? 'border-line bg-bg-hi text-accent' : 'border-transparent text-fg-faint hover:text-fg'
          }`}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          onClick={() => setCompact(!compact)}
          title={compact ? 'Comfortable rows' : 'Compact rows'}
          aria-label="Row density"
          aria-pressed={compact}
          data-testid="epic-queue-density-toggle"
          className={`shrink-0 w-6 h-6 grid place-items-center rounded border ${
            compact ? 'border-line bg-bg-hi text-accent' : 'border-transparent text-fg-faint hover:text-fg'
          }`}
        >
          <CompactToggleIcon />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <MiniSelect label="show" value={filter} onChange={setFilter} options={filterOptionsWithCounts} />
        <MiniSelect label="group" value={group} onChange={setGroup} options={GROUP_OPTIONS} />
        <MiniSelect label="sort" value={sort} onChange={setSort} options={SORT_OPTIONS} />
      </div>

      {showSearch && (
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none">
            <SearchIcon />
          </span>
          <input
            type="text"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${epics.length} sessions`}
            aria-label="Search sessions"
            className="w-full bg-bg border border-line rounded-md py-1 pl-8 pr-7 text-[12.5px] text-fg outline-none focus:border-fg-faint"
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
      )}

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
