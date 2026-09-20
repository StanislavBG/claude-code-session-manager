import { memo, useCallback, useMemo, useState } from 'react'
import { toast } from '../../../state/toast'
import { usePromptSessions } from '../../../state/promptSessions'
import { formatClock } from '../../../lib/formatTime'
import { resolveEpicRef } from '../../../lib/epicProvenance'
import { openPromptSession } from '../../../lib/epicNav'
import { runningTrailing, type PlanRow } from '../../../lib/schedulerStages'
import { RunLogViewer } from '../plans/RunLogViewer'
import { DispositionControl, type HeadChoice } from './DispositionControl'
import { verdictLabel } from './sched-primitives'

/** Stable default so an omitted `headChoices` keeps its identity across renders (memo). */
const EMPTY_HEAD_CHOICES: HeadChoice[] = []

const STUCK = new Set(['failed', 'needs_review', 'quarantined'])

/** Status dot: solid = settled/active, hollow ring = waiting its turn, faint fill = held/blocked. */
function dotClass(row: PlanRow): string {
  switch (row.status) {
    case 'completed': case 'skipped': return 'bg-sage'
    case 'running': case 'investigating': return 'bg-accent'
    case 'failed': return 'bg-accent'
    case 'needs_review': return 'bg-butter'
    case 'quarantined': return 'bg-butter/60'
    default:
      return row.rowKind === 'eta' || row.rowKind === 'next' || row.rowKind === 'retry'
        ? 'border border-fg-faint bg-transparent'
        : 'bg-fg-faint/40'
  }
}

function tintClass(row: PlanRow): string {
  switch (row.status) {
    case 'running': case 'investigating': return 'bg-butter/10'
    case 'failed': return 'bg-accent/10'
    case 'needs_review': return 'bg-butter/25'
    default: return ''
  }
}

function trailingClass(row: PlanRow): string {
  switch (row.rowKind) {
    case 'running': case 'dep': case 'failed': return 'text-accent'
    case 'review': return 'text-butter font-semibold'
    default: return 'text-fg-faint'
  }
}

function PrdRowComponent({ row, elapsedMs, listIndex, onFocused, headChoices = EMPTY_HEAD_CHOICES }: {
  row: PlanRow
  /** Live elapsed ms since startedAt, ticking once a second — `null` for every
   *  non-running row so its props stay value-stable across a tick and the
   *  React.memo wrapper below bails out (mirrors JobRow; see
   *  SchedulePanel.prdrow-render-count.test). */
  elapsedMs: number | null
  listIndex: number
  onFocused: (index: number) => void
  headChoices?: HeadChoice[]
}) {
  const [open, setOpen] = useState(false)
  const job = row.job
  const trailing = elapsedMs !== null && row.rowKind === 'running' ? runningTrailing(job, elapsedMs) : row.rowTrailing
  const done = row.status === 'completed' || row.status === 'skipped'
  const blocked = row.rowKind === 'dep' && row.blockers.some((b) => !b.missing && b.status !== null && STUCK.has(b.status))
  const dimTitle = done || blocked

  return (
    <div role="listitem" data-testid="prd-row" data-slug={row.slug} className="border-t border-rule-inner first:border-t-0">
      <button
        type="button"
        data-job-row
        data-job-status={job.status}
        data-job-index={listIndex}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => onFocused(listIndex)}
        aria-expanded={open}
        aria-label={`${row.prdNumber ? `PRD ${row.prdNumber}, ` : ''}${job.title}, ${job.status}${trailing ? `, ${trailing}` : ''}`}
        title={job.title}
        className={`w-full h-[31px] py-1 px-2 text-left flex items-center gap-1.5 hover:bg-bg/40 focus:outline-none focus:ring-1 focus:ring-accent focus:ring-inset ${tintClass(row)}`}
      >
        <span aria-hidden="true" className={`shrink-0 w-[7px] h-[7px] rounded-full ${dotClass(row)}`} />
        <span className="shrink-0 font-mono text-[10.5px] text-fg-faint w-[30px]">{row.prdNumber ? `#${row.prdNumber}` : ''}</span>
        <span className={`flex-1 min-w-0 truncate text-[12.5px] leading-tight ${dimTitle ? 'text-fg-faint' : 'text-fg font-medium'}`}>{job.title}</span>
        <span data-testid="prd-row-trailing" className={`shrink-0 font-mono text-[10.5px] ${trailingClass(row)}`}>{trailing}</span>
      </button>
      {open && <PrdDetail row={row} elapsedMs={elapsedMs} headChoices={headChoices} />}
    </div>
  )
}

export const PrdRow = memo(PrdRowComponent)

/**
 * Inline detail under a clicked row. Only mounted while open, so the per-row
 * promptSessions subscription cost is paid by the one open row. Every action
 * here is the same call JobRow's "Actions" block makes — see CONTROL_MAP.md.
 */
function PrdDetail({ row, elapsedMs, headChoices }: { row: PlanRow; elapsedMs: number | null; headChoices: HeadChoice[] }) {
  const job = row.job
  const [showLog, setShowLog] = useState(false)
  const sessions = usePromptSessions((s) => s.sessions)
  const epicRef = useMemo(() => resolveEpicRef(job, sessions), [job, sessions])
  const linkedPromptSession = epicRef.known && epicRef.epicId ? sessions[epicRef.epicId] : null
  const navigateToPromptSession = useCallback((id: string) => openPromptSession(id), [])

  const line = 'font-mono text-[11.5px] text-fg-dim leading-snug break-words'
  const btn = 'text-[12px] font-semibold bg-transparent border-0 cursor-pointer p-0'
  const errorText = job.error ? job.error.split('\n')[0] : null

  return (
    <div data-testid="prd-row-detail" className="px-3 py-2 bg-bg-elev/50 border-t border-rule-inner flex flex-col gap-1">
      <div className={line}>
        {job.status.replace(/_/g, ' ')}
        {job.exitCode !== null && ` · exit ${job.exitCode}`}
        {job.verifierVerdict && ` · ${verdictLabel(job.verifierVerdict)}`}
        {job.startedAt && ` · started ${formatClock(Date.parse(job.startedAt))}`}
        {job.finishedAt && ` · finished ${formatClock(Date.parse(job.finishedAt))}`}
        {elapsedMs === null && row.rowTrailing && row.rowKind === 'done' ? ` · took ${row.rowTrailing}` : ''}
      </div>
      {row.cycle && (
        <div className={`${line} text-accent`} data-testid="job-row-cycle-warning">
          ⚠ dependsOn cycle — {row.blockers.map((b) => b.slug).join(' ↔ ') || 'self-referencing'}
        </div>
      )}
      {!row.cycle && row.blockers.length > 0 && (
        <div className={line} data-testid="job-row-blockers">
          depends on {row.blockers.map((b) => `${b.slug} (${b.missing ? 'missing' : (b.status ?? 'unknown').replace(/_/g, ' ')})`).join(', ')}
        </div>
      )}
      {job.status === 'pending' && job.heldReason && (
        <div className={`${line} text-amber-400/90`} data-testid="job-row-held-reason">held · {job.heldReason}</div>
      )}
      {errorText && <div className={`${line} text-accent/80`}>{errorText}</div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
        {linkedPromptSession && (
          <button
            type="button"
            data-testid="job-row-prompt-session-link"
            title={linkedPromptSession.goalText}
            onClick={() => navigateToPromptSession(linkedPromptSession.id)}
            className={`${btn} text-accent hover:text-accent/80`}
          >
            view epic →
          </button>
        )}
        {job.runId && (
          <button type="button" onClick={() => setShowLog(true)} className={`${btn} text-fg-dim hover:text-fg`}>
            view log →
          </button>
        )}
        {job.status === 'quarantined' && (
          <button
            type="button"
            data-testid="job-row-adopt-prd"
            title="Stamp this PRD's provenance so the scheduler will run it — no unstamped PRD runs automatically."
            onClick={() => {
              window.api.schedule.adoptPrd(job.slug).then(toast.fromOutcome).catch(() => toast.error('Failed to adopt PRD'))
            }}
            className={`${btn} text-accent hover:text-accent/80`}
          >
            adopt PRD →
          </button>
        )}
        {job.status !== 'pending' && job.status !== 'running' && job.status !== 'quarantined' && (
          <button
            type="button"
            onClick={() => window.api.schedule.resetJob(job.slug)}
            className={`${btn} text-fg-dim hover:text-fg`}
          >
            reset to pending →
          </button>
        )}
        {job.disposition && (job.status === 'pending' || job.status === 'quarantined') && (
          <DispositionControl job={job} headChoices={headChoices} />
        )}
      </div>
      {showLog && job.runId && (
        <RunLogViewer runId={job.runId} slug={job.slug} title={job.title || job.slug} onClose={() => setShowLog(false)} />
      )}
    </div>
  )
}
