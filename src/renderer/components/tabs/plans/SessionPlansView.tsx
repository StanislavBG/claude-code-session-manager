// Legacy per-session plan viewer. Original Plans.tsx content moved verbatim
// into a sub-view as part of the Scheduler PRD viewer refactor.
import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../../ui/Panel'
import { ListDetail } from '../../ui/ListDetail'
import { EmptyState } from '../../ui/EmptyState'
import { Toggle } from '../../ui/Toggle'
import { useActiveTab } from '../../../lib/useActiveTab'
import { useLiveTab } from '../../../state/live'
import { computeLineDiff, type DiffLineType } from '../../../lib/lineDiff'

// '+'/'-'/' ' sign for a diff line, derived from lib/lineDiff's add/remove/
// context type — kept local since this view renders signs, not type names.
const DIFF_SIGN: Record<DiffLineType, ' ' | '+' | '-'> = { add: '+', remove: '-', context: ' ' }

export function SessionPlansView() {
  const activeTab = useActiveTab()
  const live = useLiveTab(activeTab)
  const [selectedAt, setSelectedAt] = useState<number | null>(null)
  const [showDiff, setShowDiff] = useState(false)

  const plans = live?.plans ?? []

  // Auto-select the newest plan whenever the selected one is gone (e.g. tab
  // switch, initial load). Newest-first ordering means index 0.
  const selectedIndex = useMemo(() => {
    const idx = plans.findIndex((p) => p.at === selectedAt)
    return idx >= 0 ? idx : plans.length > 0 ? 0 : -1
  }, [plans, selectedAt])

  useEffect(() => {
    if (selectedIndex >= 0 && plans[selectedIndex]?.at !== selectedAt) {
      setSelectedAt(plans[selectedIndex].at)
    }
  }, [selectedIndex, plans, selectedAt])

  if (!activeTab) {
    return (
      <Panel>
        <EmptyState title="no active session" />
      </Panel>
    )
  }

  const selected = selectedIndex >= 0 ? plans[selectedIndex] : null
  // Newest-first list: previous (older) revision is at index+1.
  const previous = selectedIndex >= 0 ? plans[selectedIndex + 1] ?? null : null

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">session {activeTab.sessionId.slice(0, 8)}</span>
          <span className="ml-3 text-fg-faint">{plans.length} plans</span>
          <div className="flex-1" />
          <Toggle
            checked={showDiff}
            onChange={setShowDiff}
            label="show diff vs previous"
            disabled={!previous}
          />
        </>
      }
    >
      {plans.length === 0 ? (
        <EmptyState title="no plans recorded for this session" />
      ) : (
        <ListDetail
          sidebar={
            <div className="py-2">
              {plans.map((p, i) => (
                <button
                  key={p.at}
                  onClick={() => setSelectedAt(p.at)}
                  className={`w-full text-left px-3 py-1.5 text-xs border-l-2 ${
                    p.at === selected?.at
                      ? 'bg-bg-hi text-fg border-accent'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi border-transparent'
                  }`}
                >
                  <div>{new Date(p.at).toLocaleTimeString()}</div>
                  <div className="text-fg-faint text-[10px] mt-0.5">
                    revision {plans.length - i}
                  </div>
                </button>
              ))}
            </div>
          }
          detail={
            !selected ? (
              <EmptyState title="select a plan" />
            ) : showDiff && previous ? (
              <PlanDiff prev={previous.content} curr={selected.content} />
            ) : (
              <div className="p-4 max-w-4xl">
                <div className="text-xs text-fg-faint mb-2">
                  {new Date(selected.at).toLocaleString()}
                </div>
                <pre className="text-xs text-fg-dim whitespace-pre-wrap font-mono">
                  {selected.content}
                </pre>
              </div>
            )
          }
        />
      )}
    </Panel>
  )
}

function PlanDiff({ prev, curr }: { prev: string; curr: string }) {
  const rows = useMemo(() => computeLineDiff(prev, curr).lines, [prev, curr])
  return (
    <div className="p-4">
      <pre className="text-xs font-mono whitespace-pre-wrap leading-5">
        {rows.map((r, i) => {
          const sign = DIFF_SIGN[r.type]
          return (
            <div
              key={i}
              className={
                r.type === 'add'
                  ? 'bg-green-900/30 text-green-300'
                  : r.type === 'remove'
                    ? 'bg-red-900/30 text-red-300'
                    : 'text-fg-dim'
              }
            >
              <span className="select-none text-fg-faint pr-2">{sign}</span>
              {r.text || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}
