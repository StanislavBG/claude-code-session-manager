import { useMemo, useState } from 'react'
import { toast } from '../../../state/toast'
import { openPromptSession } from '../../../lib/epicNav'
import type { PlanRow, Stage, StageState } from '../../../lib/schedulerStages'
import { PrdRow } from './PrdRow'
import { InfoDot } from './sched-primitives'
import type { HeadChoice } from './DispositionControl'

/**
 * Fixed column width. At a 1350px viewport the LeftNav takes 252px, leaving a ~1095px plan band; minus the
 * 3px spine and FURTHER_STAGES_W that is ~947px of strip = 5 × 190 (the 5th clips ≤3px). Reference mock-up: 289px columns at
 * 1308px, but it is drawn without the LeftNav, so the frame-relative width is what matters here.
 */
export const STAGE_COL_W = 190

const ROW_CAP = 7
const DONE_ROW_CAP = 5
const EMPTY_HEAD_CHOICES: HeadChoice[] = []

const isDone = (s: string) => s === 'completed' || s === 'skipped'
const isRunning = (s: string) => s === 'running' || s === 'investigating'
const isAttention = (s: string) => s === 'failed' || s === 'needs_review' || s === 'quarantined'

/** 0 = running, 1 = needs attention, 2 = everything else in priority order, 3 = done. */
function rank(r: PlanRow): number {
  if (isRunning(r.status)) return 0
  if (isAttention(r.status)) return 1
  if (isDone(r.status)) return 3
  return 2
}

const STATE_TEXT: Record<StageState, string> = {
  done: 'text-sage',
  running: 'text-accent',
  held: 'text-fg-faint',
  pending: 'text-fg-faint',
  blocked: 'text-butter',
}
const STATE_DOT: Record<StageState, string> = {
  done: 'bg-sage',
  running: 'bg-accent',
  held: 'bg-fg-faint/50',
  pending: 'bg-fg-faint/50',
  blocked: 'bg-butter',
}

/** Disclosure label for the rows hidden behind the footer: '+4 done', '+14 blocked', '+7 in stage 4'. */
function footerLabel(hidden: PlanRow[], stageN: number): string {
  if (hidden.every((r) => isDone(r.status))) return `+${hidden.length} done`
  if (hidden.every((r) => r.rowKind === 'dep' && r.blockers.some((b) => !b.missing && b.status !== null && isAttention(b.status)))) {
    return `+${hidden.length} blocked`
  }
  return `+${hidden.length} in stage ${stageN}`
}

interface StageColumnProps {
  stage: Stage
  /** The plan's Epic — target of the Review action (a parked needs_review is a question routed back to its authoring Epic). */
  epicId: string | null
  /** Clock tick (ms). Only running rows derive a prop from it. */
  now: number
  /** Completed/failed slugs hidden by 'Clear completed'. */
  hidden: ReadonlySet<string>
  indexBySlug: ReadonlyMap<string, number>
  headChoicesBySlug: ReadonlyMap<string, HeadChoice[]>
  onRowFocused: (index: number) => void
}

export function StageColumn({ stage, epicId, now, hidden, indexBySlug, headChoicesBySlug, onRowFocused }: StageColumnProps) {
  // Disclosure is local state only — no API call.
  const [expanded, setExpanded] = useState(false)

  // O(r log r) per stage: stable sort by rank keeps the PRD-number priority order inside each rank.
  const ordered = useMemo(
    () => stage.rows
      .filter((r) => !(hidden.has(r.slug) && (r.status === 'completed' || r.status === 'failed')))
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map((x) => x.r),
    [stage.rows, hidden],
  )
  const flagged = useMemo(() => ordered.filter((r) => rank(r) <= 1).length, [ordered])
  // Flagged rows are never truncated: the Retry/Review pair must sit under them.
  const cap = Math.max(stage.state === 'done' ? DONE_ROW_CAP : ROW_CAP, flagged)
  const shown = expanded ? ordered : ordered.slice(0, cap)
  const hiddenRows = expanded ? [] : ordered.slice(cap)

  const failed = ordered.find((r) => r.status === 'failed')
  const review = ordered.find((r) => r.status === 'needs_review')
  const showPair = flagged > 0 && (failed !== undefined || review !== undefined)
  // The pair goes right after the last flagged row (flagged rows are contiguous after the running ones).
  const pairAfter = shown.reduce((last, r, i) => (rank(r) <= 1 ? i : last), -1)

  const renderRow = (r: PlanRow) => (
    <PrdRow
      key={r.slug}
      row={r}
      elapsedMs={isRunning(r.status) && r.job.startedAt ? now - Date.parse(r.job.startedAt) : null}
      listIndex={indexBySlug.get(r.slug) ?? 0}
      onFocused={onRowFocused}
      headChoices={headChoicesBySlug.get(r.slug) ?? EMPTY_HEAD_CHOICES}
    />
  )

  const outlineBtn = 'flex-1 min-w-0 truncate h-[24px] text-[11.5px] font-medium text-fg-dim hover:text-fg border border-rule-structural rounded-sm bg-transparent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div
      data-testid="stage-column"
      data-stage={stage.n}
      style={{ width: STAGE_COL_W }}
      className="shrink-0 border-l border-rule-structural first:border-l-0 flex flex-col self-stretch"
    >
      <div className="h-[30px] shrink-0 flex items-center gap-1.5 px-2 border-b border-rule-inner" data-testid="stage-header">
        <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full shrink-0 ${STATE_DOT[stage.state]}`} />
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${STATE_TEXT[stage.state]}`}>Stage {stage.n}</span>
        {stage.state === 'blocked' && (
          <InfoDot title="Rows in this stage are failed / need review / are quarantined, or wait on one that is." />
        )}
        <span data-testid="stage-summary" className="ml-auto font-mono text-[10.5px] text-fg-dim truncate">{stage.summary}</span>
      </div>

      <div role="presentation">
        {shown.map((r, i) => (
          <div key={r.slug}>
            {renderRow(r)}
            {showPair && i === pairAfter && (
              <div data-testid="stage-attention-actions" className="flex gap-1.5 px-2 py-1.5 border-t border-rule-inner">
                {failed && (
                  <button
                    type="button"
                    data-testid="stage-retry"
                    title={`Reset ${failed.slug} to pending`}
                    onClick={() => {
                      window.api.schedule.resetJob(failed.slug)
                        .then((res) => { if (!res.ok) toast.error(res.error ?? `Failed to reset ${failed.slug}`) })
                        .catch(() => toast.error(`Failed to reset ${failed.slug}`))
                    }}
                    className={outlineBtn}
                  >
                    Retry {failed.prdNumber ? `#${failed.prdNumber}` : failed.slug}
                  </button>
                )}
                {review && (
                  <button
                    type="button"
                    data-testid="stage-review"
                    disabled={!epicId}
                    title={epicId ? "Open the authoring Epic — a needs_review PRD is a question routed back to it" : 'No authoring Epic recorded for this plan'}
                    onClick={() => { if (epicId) openPromptSession(epicId) }}
                    className={outlineBtn}
                  >
                    Review {review.prdNumber ? `#${review.prdNumber}` : review.slug}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {(hiddenRows.length > 0 || (expanded && ordered.length > cap)) && (
        <button
          type="button"
          data-testid="stage-footer"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-auto h-[26px] border-t border-rule-inner font-mono text-[11px] text-fg-faint hover:text-fg-dim bg-transparent cursor-pointer"
        >
          {expanded ? 'show less ▴' : `${footerLabel(hiddenRows, stage.n)} ▾`}
        </button>
      )}
    </div>
  )
}
