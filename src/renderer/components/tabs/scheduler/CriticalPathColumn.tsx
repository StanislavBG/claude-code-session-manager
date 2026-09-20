import { useMemo } from 'react'
import { criticalPath, type Plan, type PlanRow } from '../../../lib/schedulerStages'
import { PrdRow } from './PrdRow'
import type { HeadChoice } from './DispositionControl'

const EMPTY_HEAD_CHOICES: HeadChoice[] = []
const isRunning = (s: string) => s === 'running' || s === 'investigating'

export interface CriticalEntry {
  row: PlanRow
  /** Sum of estimateMinutes (null = 0) from the chain's first PRD through this one. */
  totalMinutes: number
  /** PRDs in this row's stage that are NOT on the critical path. */
  othersInStage: number
}

/** The plan's longest dependsOn chain, with running totals and per-stage non-critical counts. O(V). */
export function criticalEntries(plan: Plan): CriticalEntry[] {
  const chain = criticalPath(plan)
  const bySlug = new Map<string, PlanRow>()
  const stageSize = new Map<number, number>()
  for (const s of plan.stages) {
    stageSize.set(s.n, s.rows.length)
    for (const r of s.rows) bySlug.set(r.slug, r)
  }
  const onChain = new Map<number, number>()
  let total = 0
  const out: CriticalEntry[] = []
  for (const slug of chain) {
    const row = bySlug.get(slug)!
    total += row.estimateMinutes ?? 0
    onChain.set(row.stage, (onChain.get(row.stage) ?? 0) + 1)
    out.push({ row, totalMinutes: total, othersInStage: 0 })
  }
  for (const e of out) e.othersInStage = (stageSize.get(e.row.stage) ?? 0) - (onChain.get(e.row.stage) ?? 0)
  return out
}

interface Props {
  plan: Plan
  now: number
  indexBySlug: ReadonlyMap<string, number>
  headChoicesBySlug: ReadonlyMap<string, HeadChoice[]>
  onRowFocused: (index: number) => void
}

/** Critical-path mode body: one column of the longest chain, dense PrdRow, est + running total on the right. */
export function CriticalPathColumn({ plan, now, indexBySlug, headChoicesBySlug, onRowFocused }: Props) {
  const entries = useMemo(() => criticalEntries(plan), [plan])
  return (
    <div data-testid="critical-path" className="border-t border-rule-structural max-w-[640px]">
      {entries.map(({ row, totalMinutes, othersInStage }) => (
        <div key={row.slug} data-testid="critical-entry" data-slug={row.slug}>
          <div className="flex items-start">
            <div className="flex-1 min-w-0">
              <PrdRow
                row={row}
                elapsedMs={isRunning(row.status) && row.job.startedAt ? now - Date.parse(row.job.startedAt) : null}
                listIndex={indexBySlug.get(row.slug) ?? 0}
                onFocused={onRowFocused}
                headChoices={headChoicesBySlug.get(row.slug) ?? EMPTY_HEAD_CHOICES}
              />
            </div>
            <span data-testid="critical-est" className="shrink-0 h-[31px] px-3 flex items-center gap-2 font-mono text-[11.5px] text-fg-faint border-t border-rule-inner">
              <span title="estimateMinutes">{row.estimateMinutes ? `${row.estimateMinutes}m` : '—'}</span>
              <span className="text-fg-dim" title="Running total along the chain">Σ {totalMinutes}m</span>
            </span>
          </div>
          {othersInStage > 0 && (
            <div data-testid="critical-others" className="h-[22px] px-3 flex items-center font-mono text-[11.5px] text-fg-faint border-t border-rule-inner">
              stage {row.stage} · +{othersInStage} not on the critical path
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
