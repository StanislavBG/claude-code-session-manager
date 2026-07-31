/**
 * Left pane of the redesigned Epics workspace — grouped, collapsible,
 * selectable Epic rows. Built from session-manager-operations/design-mocks/
 * epics/DESIGN_SPEC.md ("Left pane") + epics-mock.jsx's QueueRow/EpicQueue,
 * translated from inline styles to Tailwind Almanac tokens.
 *
 * Search/filter/sort/pin/keyboard controls are PRD 828's job — this
 * component only renders whatever (already-filtered, already-sorted) epics
 * list it's given, grouped by status.
 */
import { useMemo, useState } from 'react'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import { epicDisplayStatus, epicPrds, epicStats, type EpicDisplayStatus, type EpicSnapshots } from '../../lib/epicDerive'
import { EpicStatusChip, EpicKindTag, epicStatusDotClass, epicStatusLabel } from './epic-primitives'
import { EmptyState } from '../ui/EmptyState'
import { formatAgo } from '../../lib/formatTime'

const STATUS_ORDER: EpicDisplayStatus[] = ['running', 'needs', 'queued', 'draft', 'completed']

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={11}
      height={11}
      aria-hidden="true"
      className={`shrink-0 text-fg-faint transition-transform duration-100 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function activityAgeLabel(epicId: string, epic: PromptSession, events: Record<string, PromptSessionEvent[]>, now: number): string {
  const tail = events[epicId]?.slice(-1)[0] ?? null
  const at = tail?.at ?? epic.createdAt
  const ms = Date.parse(at)
  if (Number.isNaN(ms)) return ''
  return formatAgo(ms, now)
}

interface QueueRowProps {
  epic: PromptSession
  snapshots: EpicSnapshots
  events: Record<string, PromptSessionEvent[]>
  status: EpicDisplayStatus
  selected: boolean
  compact: boolean
  now: number
  onSelect: (id: string) => void
}

function QueueRow({ epic, snapshots, events, status, selected, compact, now, onSelect }: QueueRowProps) {
  const age = activityAgeLabel(epic.id, epic, events, now)

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onSelect(epic.id)}
        data-testid="epic-queue-row"
        data-epic-id={epic.id}
        className={`w-full grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 rounded-md py-1.5 px-2 text-left border-l-2 ${
          selected ? 'bg-bg-hi border-l-accent' : 'border-l-transparent hover:bg-bg-hi/60'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${epicStatusDotClass(status)} ${status === 'completed' ? 'opacity-45' : ''}`} aria-hidden="true" />
        <span className={`min-w-0 truncate text-[12.5px] ${selected ? 'font-semibold text-fg' : 'text-fg-dim'}`}>{epic.goalText}</span>
        <span className="font-mono text-[10px] text-fg-faint shrink-0">{age}</span>
      </button>
    )
  }

  const prds = epicPrds(epic.id, snapshots)
  const stats = epicStats(epic.id, snapshots)

  return (
    <button
      type="button"
      onClick={() => onSelect(epic.id)}
      data-testid="epic-queue-row"
      data-epic-id={epic.id}
      className={`relative w-full text-left rounded-lg p-2.5 grid gap-1.5 ${
        selected ? 'bg-bg-hi shadow-sm ring-1 ring-line' : 'hover:bg-bg-hi/50'
      }`}
    >
      {selected && (
        <span className={`absolute inset-y-0 left-0 w-[3px] rounded-l-lg ${epicStatusDotClass(status)}`} aria-hidden="true" />
      )}
      <span className="flex items-center gap-1.5">
        <EpicStatusChip status={status} small />
        <EpicKindTag kind={epic.tag} small />
        <span className="ml-auto font-mono text-[10.5px] text-fg-faint pr-1">{age}</span>
      </span>
      <span className="text-[13px] font-semibold text-fg leading-snug line-clamp-1">{epic.goalText}</span>
      <span className="flex items-center gap-3 font-mono text-[10.5px] text-fg-faint">
        {prds.length > 0 && (
          <span>
            {prds.length} {prds.length === 1 ? 'PRD' : 'PRDs'}
          </span>
        )}
        {stats !== null && <span>{stats.turns} turns</span>}
      </span>
    </button>
  )
}

export interface EpicQueueProps {
  /** Already-filtered, already-sorted epic list — PRD 828 owns search/sort/pin. */
  epics: PromptSession[]
  snapshots: EpicSnapshots
  events: Record<string, PromptSessionEvent[]>
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  compact?: boolean
  /** Injectable for tests; defaults to Date.now(). */
  now?: number
}

export function EpicQueue({ epics, snapshots, events, selectedId, onSelect, onNew, compact = false, now }: EpicQueueProps) {
  const [closedSections, setClosedSections] = useState<Set<EpicDisplayStatus>>(() => new Set(['completed']))
  const nowMs = now ?? Date.now()

  const sections = useMemo(() => {
    const buckets = new Map<EpicDisplayStatus, PromptSession[]>()
    for (const epic of epics) {
      const status = epicDisplayStatus(epic.id, snapshots)
      if (!buckets.has(status)) buckets.set(status, [])
      buckets.get(status)!.push(epic)
    }
    return STATUS_ORDER.filter((s) => buckets.has(s)).map((s) => ({ status: s, items: buckets.get(s)! }))
  }, [epics, snapshots])

  const toggleSection = (status: EpicDisplayStatus) => {
    setClosedSections((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  return (
    <aside className="w-[352px] shrink-0 border-r border-line bg-bg-elev flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3.5 py-3 border-b border-line">
        <span className="font-mono text-[10.5px] font-semibold tracking-[1.1px] uppercase text-fg-faint">Epic queue</span>
        <span className="font-mono text-[10.5px] text-fg-faint">{epics.length}</span>
        <button
          type="button"
          onClick={onNew}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 bg-accent text-white text-xs font-semibold shadow-sm"
        >
          + New Epic
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-1.5">
        {epics.length === 0 ? (
          <EmptyState
            title="No Epics yet"
            hint={
              <button type="button" onClick={onNew} className="mt-2 text-accent font-semibold text-xs">
                + New Epic
              </button>
            }
          />
        ) : (
          sections.map(({ status, items }) => {
            const closed = closedSections.has(status)
            return (
              <div key={status} className="mb-1.5">
                <button
                  type="button"
                  onClick={() => toggleSection(status)}
                  className="sticky top-0 z-10 w-full flex items-center gap-1.5 bg-bg-elev py-1.5 px-1.5 text-left"
                >
                  <ChevronIcon open={!closed} />
                  <span className={`w-1.5 h-1.5 rounded-full ${epicStatusDotClass(status)}`} aria-hidden="true" />
                  <span className="font-mono text-[10px] font-semibold tracking-[0.9px] uppercase text-fg-dim">
                    {epicStatusLabel(status)}
                  </span>
                  <span className="font-mono text-[10px] text-fg-faint">{items.length}</span>
                  <span className="ml-auto h-px flex-1 bg-rule opacity-70" />
                </button>
                {!closed && (
                  <div className={`grid ${compact ? 'gap-px' : 'gap-1.5'}`}>
                    {items.map((epic) => (
                      <QueueRow
                        key={epic.id}
                        epic={epic}
                        snapshots={snapshots}
                        events={events}
                        status={status}
                        selected={epic.id === selectedId}
                        compact={compact}
                        now={nowMs}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
