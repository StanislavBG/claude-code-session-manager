import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../../../state/toast'
import { formatEta, type Plan, type PlanStatus } from '../../../lib/schedulerStages'
import { RunLogViewer } from '../plans/RunLogViewer'
import { StageColumn, STAGE_COL_W } from './StageColumn'
import { PlanMinimap } from './PlanMinimap'
import { FurtherStagesTail } from './FurtherStagesTail'
import { CriticalPathColumn } from './CriticalPathColumn'
import type { PlanMode } from './SchedulerTopBands'
import { InfoDot, projectNameFromCwd } from './sched-primitives'
import type { HeadChoice } from './DispositionControl'

/** Columns rendered beyond the first visible one on each side of the window. */
const OVERSCAN = 1
/** Assumed viewport width until the strip has been measured (jsdom never measures). */
const FALLBACK_VIEW_W = 1350

const SPINE: Record<PlanStatus, string> = {
  active: 'border-l-accent',
  queued: 'border-l-rule-structural',
  done: 'border-l-sage',
  draft: 'border-l-fg-faint/40 border-dashed',
}

const CHIP: Record<PlanStatus, { label: string; cls: string }> = {
  active: { label: 'ACTIVE', cls: 'bg-accent text-white border border-accent' },
  queued: { label: 'QUEUED', cls: 'text-fg-dim border border-fg-faint' },
  done: { label: 'DONE', cls: 'text-sage-dark border border-sage' },
  draft: { label: 'DRAFT', cls: 'text-fg-faint border border-dashed border-fg-faint' },
}

const pad2 = (n: number) => String(n).padStart(2, '0')

interface PlanBandProps {
  plan: Plan
  /** 'critical' renders the plan as its single longest dependsOn chain instead of stage columns. */
  mode?: PlanMode
  now: number
  hidden: ReadonlySet<string>
  indexBySlug: ReadonlyMap<string, number>
  headChoicesBySlug: ReadonlyMap<string, HeadChoice[]>
  onRowFocused: (index: number) => void
  /** Draft plans: jump to the PRDs sub-view, opening this plan's first PRD. */
  onOpenPrds?: (slug: string | null) => void
}

/** Segmented done | running | rest bar. */
function PlanProgress({ plan }: { plan: Plan }) {
  const total = Math.max(1, plan.prdCount)
  const done = (plan.doneCount / total) * 100
  const running = (plan.runningCount / total) * 100
  return (
    <span
      data-testid="plan-progress"
      role="progressbar"
      aria-valuenow={plan.doneCount}
      aria-valuemin={0}
      aria-valuemax={plan.prdCount}
      className="flex w-[160px] h-[5px] rounded-sm overflow-hidden bg-rule-inner shrink-0"
    >
      <span className="h-full bg-sage" style={{ width: `${done}%` }} />
      <span className="h-full bg-accent" style={{ width: `${running}%` }} />
    </span>
  )
}

export function PlanBand({ plan, mode = 'graph', now, hidden, indexBySlug, headChoicesBySlug, onRowFocused, onOpenPrds }: PlanBandProps) {
  const [expanded, setExpanded] = useState(plan.status === 'active' || plan.status === 'queued')
  const [showLog, setShowLog] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const [first, setFirst] = useState(0)
  const [viewW, setViewW] = useState(FALLBACK_VIEW_W)

  useEffect(() => {
    if (expanded && stripRef.current?.clientWidth) setViewW(stripRef.current.clientWidth)
  }, [expanded])

  // The plan's most recent run (DONE → 'View run'): latest finishedAt among rows that have a runId.
  const lastRun = useMemo(() => {
    let best: { runId: string; slug: string; title: string; at: number } | null = null
    for (const s of plan.stages) {
      for (const r of s.rows) {
        if (!r.job.runId) continue
        const at = r.job.finishedAt ? Date.parse(r.job.finishedAt) : 0
        if (!best || at > best.at) best = { runId: r.job.runId, slug: r.slug, title: r.title, at }
      }
    }
    return best
  }, [plan.stages])

  const project = projectNameFromCwd(plan.stages[0]?.rows[0]?.job.cwd) ?? '—'
  const chip = CHIP[plan.status]

  // Window of stages: [start, end) — only these mount; spacers keep the scroll extent honest.
  const perView = Math.max(1, Math.ceil(viewW / STAGE_COL_W))
  const start = Math.max(0, Math.min(first - OVERSCAN, plan.stageCount))
  const end = Math.min(plan.stageCount, first + perView + OVERSCAN)

  // Local scroll only (no API). The brush, range label and tail are all derived from `first`; the
  // strip's scroll event feeds `first` back, so the minimap brush and the columns stay in sync both ways.
  const seekStage = (i: number) => {
    const f = Math.max(0, Math.min(plan.stageCount - 1, i))
    if (stripRef.current) stripRef.current.scrollLeft = f * STAGE_COL_W
    setFirst(f)
  }
  const tailStart = Math.min(plan.stageCount, first + perView)

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const f = Math.floor(el.scrollLeft / STAGE_COL_W)
    if (f !== first) setFirst(f)
    if (el.clientWidth && el.clientWidth !== viewW) setViewW(el.clientWidth)
  }

  const actionBtn = 'h-[24px] px-3 text-[12px] font-medium text-fg border border-rule-structural rounded-sm bg-transparent hover:bg-bg-hi cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0'
  const action = (() => {
    switch (plan.status) {
      case 'active':
        return (
          <button
            type="button"
            data-testid="plan-action"
            title="Pauses the WHOLE scheduler (machine-wide) — there is no per-plan pause."
            onClick={() => { window.api.schedule.pause().catch(() => toast.error('Failed to pause the scheduler')) }}
            className={actionBtn}
          >
            Pause plan
          </button>
        )
      case 'queued':
        return (
          <button
            type="button"
            data-testid="plan-action"
            title="Fires the next scheduler batch machine-wide (force tick) — it does not target this plan."
            onClick={() => { window.api.schedule.forceTick().then(toast.fromOutcome).catch(() => toast.error('Failed to fire the next batch')) }}
            className={actionBtn}
          >
            Run now
          </button>
        )
      case 'done':
        return (
          <button
            type="button"
            data-testid="plan-action"
            disabled={!lastRun}
            title={lastRun ? `Open the run log of ${lastRun.slug}, the plan's last run` : 'No run log recorded for this plan'}
            onClick={() => setShowLog(true)}
            className={actionBtn}
          >
            View run
          </button>
        )
      case 'draft':
        return (
          <button
            type="button"
            data-testid="plan-action"
            title="Open the PRDs sub-view on this plan's first PRD (the PRDs view has no per-Epic filter)."
            onClick={() => onOpenPrds?.(plan.stages[0]?.rows[0]?.slug ?? null)}
            className={actionBtn}
          >
            Schedule…
          </button>
        )
    }
  })()

  const remaining = plan.etaMs > 0 ? ` · ${formatEta(plan.etaMs)} left` : ''

  return (
    <section
      data-testid="plan-band"
      data-epic-id={plan.epicId ?? ''}
      data-plan-status={plan.status}
      className={`border-l-[3px] ${SPINE[plan.status]} border-b border-rule-structural`}
    >
      <div className="h-[32px] flex items-center gap-2.5 px-3" data-testid="plan-header">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse plan' : 'Expand plan'}
          data-testid="plan-toggle"
          onClick={() => { setExpanded((v) => !v); setFirst(0) }} // a re-mounted strip starts scrolled to 0
          className="shrink-0 w-[14px] text-[11px] text-fg-faint hover:text-fg bg-transparent border-0 cursor-pointer p-0"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="font-mono text-[11.5px] text-fg-faint shrink-0">{pad2(plan.index)}</span>
        <span className="font-serif text-[15px] font-bold text-fg truncate shrink-0 max-w-[320px]" title={plan.label} data-testid="plan-label">{plan.label}</span>
        <span data-testid="plan-chip" className={`shrink-0 rounded-sm px-1.5 py-[1px] text-[10px] font-bold tracking-wide ${chip.cls}`}>{chip.label}</span>
        <span aria-hidden="true" className="shrink-0 w-px h-[16px] bg-rule-structural" />
        <span className="font-mono text-[11.5px] text-fg-faint truncate min-w-0" data-testid="plan-meta">
          {project} · {plan.prdCount} PRD{plan.prdCount === 1 ? '' : 's'} · {plan.stageCount} stage{plan.stageCount === 1 ? '' : 's'}
        </span>
        <InfoDot title={`${plan.doneCount} done · ${plan.runningCount} running · ${plan.heldCount} held · ${plan.blockedCount} blocked`} />
        <span className="ml-auto font-mono text-[11.5px] text-fg-dim shrink-0" data-testid="plan-progress-label">
          {plan.doneCount}/{plan.prdCount}{remaining}
        </span>
        <PlanProgress plan={plan} />
        {action}
      </div>

      {expanded && mode === 'critical' && (
        <CriticalPathColumn plan={plan} now={now} indexBySlug={indexBySlug} headChoicesBySlug={headChoicesBySlug} onRowFocused={onRowFocused} />
      )}

      {expanded && mode !== 'critical' && plan.status === 'active' && (
        <PlanMinimap stages={plan.stages} first={first} perView={perView} onSeek={seekStage} />
      )}

      {expanded && mode !== 'critical' && (
        <div className="flex border-t border-rule-structural">
          <div
            ref={stripRef}
            data-testid="plan-stages"
            onScroll={onScroll}
            className="flex flex-1 min-w-0 overflow-x-auto"
          >
            {start > 0 && <div aria-hidden="true" className="shrink-0" style={{ width: start * STAGE_COL_W }} />}
            {plan.stages.slice(start, end).map((stage) => (
              <StageColumn
                key={stage.n}
                stage={stage}
                epicId={plan.epicId}
                now={now}
                hidden={hidden}
                indexBySlug={indexBySlug}
                headChoicesBySlug={headChoicesBySlug}
                onRowFocused={onRowFocused}
              />
            ))}
            {end < plan.stageCount && <div aria-hidden="true" className="shrink-0" style={{ width: (plan.stageCount - end) * STAGE_COL_W }} />}
          </div>
          <FurtherStagesTail stages={plan.stages.slice(tailStart)} onSeek={seekStage} />
        </div>
      )}

      {showLog && lastRun && (
        <RunLogViewer runId={lastRun.runId} slug={lastRun.slug} title={lastRun.title || lastRun.slug} onClose={() => setShowLog(false)} />
      )}
    </section>
  )
}
