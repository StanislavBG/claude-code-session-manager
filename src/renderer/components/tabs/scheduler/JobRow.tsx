import { memo, useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleJob, ScheduleJobHold } from '../../../../preload/api.d'
import { formatTimingLabel, formatDuration, formatClock } from '../../../lib/formatTime'
import { usePromptSessions } from '../../../state/promptSessions'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { resolveEpicRef } from '../../../lib/epicProvenance'
import type { BacklogEpicSection, BacklogBlocker } from '../../../lib/backlogTree'
import { RunLogViewer } from '../plans/RunLogViewer'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { toast } from '../../../state/toast'
import { SchBadge, LeakBadge, LeftoverBadge, OverrunBadge, formatLeakedDescendants, ProjectTag, EpicTag, DetailBlock, DetailLine, prdNumber, PrdNumberBadge, verdictLabel } from './sched-primitives'
import { DispositionControl, truncateLabel, type HeadChoice } from './DispositionControl'

/**
 * EpicSectionBlock — one collapsible block per Epic in the job table, headed
 * by the Epic's title, PRD count, and a status rollup. Collapse state is
 * local (uncontrolled) since it's a pure display affordance, same pattern as
 * JobRow's own `open` state below.
 */
export function EpicSectionBlock({ section, children }: { section: BacklogEpicSection<ScheduleJob>; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true)
  const rollup = Object.entries(section.counts)
    .map(([status, n]) => `${n} ${status.replace(/_/g, ' ')}`)
    .join(' · ')
  return (
    <div className="border-t border-line" data-testid="backlog-epic-section" data-epic-id={section.epicId ?? ''}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-[18px] py-2.5 bg-bg-elev/60 hover:bg-bg-elev text-left"
        aria-expanded={expanded}
        title={section.label}
      >
        <span
          className={`text-fg-faint inline-flex shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <AlmanacIcon name="chevron" size={12} />
        </span>
        <span className="font-serif text-[14.5px] font-semibold text-fg truncate" data-testid="backlog-epic-label">
          {section.label}
        </span>
        <span className="font-mono text-[11px] text-fg-faint shrink-0">
          {section.total} PRD{section.total === 1 ? '' : 's'}
        </span>
        <span className="font-mono text-[11px] text-fg-faint truncate">{rollup}</span>
      </button>
      {expanded && children}
    </div>
  )
}

/** JobRow's Epic/dependency-chain presentation info. A module-level default
 *  (not an inline literal) so an omitted `backlog` prop keeps the same
 *  identity across renders — an inline `{}` default would be a freshly-built
 *  object every render and defeat JobRow's React.memo (see
 *  SchedulePanel.jobrow-render-count.test.tsx). */
interface JobRowBacklogInfo {
  depth: number
  blockers: BacklogBlocker[]
  blocked: boolean
  hasNeedsReviewBlocker: boolean
  hasMissingDep: boolean
  cycle: boolean
  parallelEligible: boolean
}
const EMPTY_BLOCKERS: BacklogBlocker[] = []
const EMPTY_HEAD_CHOICES: HeadChoice[] = []
const DEFAULT_BACKLOG_INFO: JobRowBacklogInfo = {
  depth: 0,
  blockers: EMPTY_BLOCKERS,
  blocked: false,
  hasNeedsReviewBlocker: false,
  hasMissingDep: false,
  cycle: false,
  parallelEligible: false,
}

function blockerLabel(b: BacklogBlocker): string {
  if (b.missing) return `${b.slug} (missing)`
  if (b.needsReview) return `${b.slug} (needs review)`
  return `${b.slug} (${(b.status ?? 'unknown').replace(/_/g, ' ')})`
}

function blockerToneClass(b: BacklogBlocker): string {
  if (b.missing) return 'text-accent'
  if (b.needsReview) return 'text-butter font-semibold'
  if (b.status === 'completed') return 'text-sage'
  return 'text-amber-400/90'
}

function JobRowComponent({ job, eta, elapsedMs, avgDurationMs, listIndex, onFocused, hold, backlog = DEFAULT_BACKLOG_INFO, headChoices = EMPTY_HEAD_CHOICES }: {
  job: ScheduleJob
  eta: string | null
  /** Live elapsed ms since `job.startedAt`, ticking once a second — `null`
   *  for every non-running row so its props stay reference/value-stable
   *  across ticks and the React.memo wrapper below can bail out. */
  elapsedMs: number | null
  avgDurationMs: number
  listIndex: number
  onFocused: (index: number) => void
  /** Set when the last tick held this pending row behind an unsatisfied dep. */
  hold?: ScheduleJobHold
  /** This row's position + blockers in the Epic/dependency tree — see
   *  lib/backlogTree. Defaults to a top-level, unblocked row so every
   *  existing call site (tests included) that doesn't pass it keeps working. */
  backlog?: JobRowBacklogInfo
  /** Other heads (root chains) in this row's Epic section, available as
   *  "attach behind" targets for the disposition-change control below —
   *  only rendered when `job.disposition` is set. Defaults to an empty,
   *  reference-stable array for the same memo reason as `backlog` above. */
  headChoices?: HeadChoice[]
}) {
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)

  // Traceability link back to the Epic this job's PRD belongs to. Resolution
  // order (epicId → sourcePromptId → sourceTabId) lives in
  // lib/epicProvenance so the PRDs and History views resolve identically —
  // this row used to key on sourceTabId alone, which silently mis-resolved
  // rows where the two fields disagree.
  const sessions = usePromptSessions((s) => s.sessions)
  const epicRef = useMemo(() => resolveEpicRef(job, sessions), [job, sessions])
  const linkedPromptSession = epicRef.known && epicRef.epicId ? sessions[epicRef.epicId] : null

  const navigateToPromptSession = useCallback((id: string) => {
    setPendingPromptSessionId(id)
    window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
  }, [])

  const isRunning = job.status === 'running'
  const isFailed = job.status === 'failed'

  let trailingLabel: string | null = null
  if (isRunning && elapsedMs !== null) {
    trailingLabel = `${formatDuration(elapsedMs)} elapsed`
  } else if (job.status === 'completed' && job.startedAt && job.finishedAt) {
    trailingLabel = `took ${formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`
  } else if (eta) {
    trailingLabel = eta
  }

  // Note shown in collapsed row below the title
  const errorText = job.error ?? null
  const note = isFailed && errorText
    ? errorText.split('\n')[0]
    : job.status === 'needs_review' && job.verifierVerdict
      ? verdictLabel(job.verifierVerdict)
      : null

  // Progress fraction for running jobs (capped at 0.99 so it never "completes")
  const progressPct = isRunning && elapsedMs !== null
    ? Math.min(0.99, elapsedMs / avgDurationMs)
    : 0

  return (
    <div
      role="listitem"
      className="border-t border-line"
    >
      <button
        type="button"
        data-job-row
        data-job-status={job.status}
        data-job-index={listIndex}
        data-depth={backlog.depth}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => onFocused(listIndex)}
        style={backlog.depth > 0 ? { paddingLeft: 18 + backlog.depth * 20 } : undefined}
        className={`w-full text-left grid grid-cols-[116px_1fr_auto_auto] items-center gap-4 px-[18px] py-3.5 hover:bg-bg/40 focus:outline-none focus:ring-1 focus:ring-accent focus:ring-inset ${open ? 'bg-bg-elev/40' : ''}`}
        aria-expanded={open}
        aria-label={`${prdNumber(job.slug) ? `PRD ${prdNumber(job.slug)}, ` : ''}${job.title}, ${job.status}${trailingLabel ? `, ${trailingLabel}` : ''}`}
        title={job.title}
      >
        <SchBadge status={job.status} />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 text-[14.5px] font-medium text-fg leading-snug">
            {prdNumber(job.slug) && <PrdNumberBadge n={prdNumber(job.slug)!} />}
            {job.title}
            <LeakBadge leaked={job.leakedDescendants} />
            <LeftoverBadge count={job.leftoverCount} truncated={job.leftoverPathsTruncated} salvagePatch={job.salvagePatch} />
            {backlog.parallelEligible && (
              <span
                data-testid="job-row-parallel-eligible"
                title="No dependsOn, and nothing in this Epic depends on it — can run any time a slot is free"
                className="text-[10px] font-semibold uppercase tracking-wide text-sage/90 bg-sage/10 border border-sage/30 rounded px-1.5 py-0.5"
              >
                parallel
              </span>
            )}
          </div>
          {backlog.cycle && (
            <div className="text-[12.5px] mt-0.5 text-accent font-mono" data-testid="job-row-cycle-warning">
              ⚠ dependsOn cycle — {backlog.blockers.map((b) => b.slug).join(' ↔ ') || 'self-referencing'}
            </div>
          )}
          {!backlog.cycle && backlog.blockers.length > 0 && (
            <div className="text-[12.5px] mt-0.5 font-mono" data-testid="job-row-blockers">
              <span className={backlog.blocked || backlog.hasMissingDep ? 'text-amber-400/90' : 'text-fg-faint'}>
                {backlog.blocked || backlog.hasMissingDep ? 'blocked by ' : 'depends on '}
              </span>
              {backlog.blockers.map((b, i) => (
                <span key={b.slug} className={blockerToneClass(b)}>
                  {i > 0 && ', '}
                  {blockerLabel(b)}
                </span>
              ))}
            </div>
          )}
          {note && (
            <div className={`text-[12.5px] mt-0.5 ${isFailed ? 'text-accent/80' : 'text-fg-faint'}`}>
              {note}
            </div>
          )}
          {hold && (
            <div className="text-[12.5px] mt-0.5 text-amber-400/90 font-mono" data-testid="job-row-hold">
              {hold.dep
                ? <>held · waiting on {hold.dep} ({hold.depStatus})</>
                : <>held · {hold.reason ?? 'launch blocked'}</>}
            </div>
          )}
          {!hold && job.status === 'pending' && job.heldReason && (
            <div className="text-[12.5px] mt-0.5 text-amber-400/90 font-mono" data-testid="job-row-held-reason">
              held · {job.heldReason}
            </div>
          )}
          <EpicTag
            epicId={epicRef.epicId}
            label={epicRef.label ? truncateLabel(epicRef.label) : null}
            onOpen={navigateToPromptSession}
            testId="job-row-prompt-session-chip"
            className="mt-0.5"
          />
        </div>
        <ProjectTag cwd={job.cwd} />
        <span className="inline-flex items-center gap-2.5 font-mono text-xs text-fg-faint shrink-0">
          <OverrunBadge status={job.status} overrun={job.overrun} />
          {trailingLabel}
          <span
            className={`text-fg-faint inline-flex transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            <AlmanacIcon name="chevron" size={14} />
          </span>
        </span>
      </button>

      {/* Thin progress bar for running jobs (only when collapsed) */}
      {isRunning && !open && (
        <div className="h-1 bg-line mx-[18px] mb-3 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-1000"
            style={{ width: `${Math.max(4, progressPct * 100)}%` }}
          />
        </div>
      )}

      {/* Expanded detail panel */}
      {open && (
        <div className="px-[18px] py-5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-5 bg-bg-elev/50 border-t border-line">
          <DetailBlock label="Status">
            <DetailLine k="result" v={job.exitCode !== null ? `exit ${job.exitCode}` : '—'} />
            <DetailLine k="state" v={job.status.replace(/_/g, ' ')} />
            {job.verifierVerdict && (
              <DetailLine k="verdict" v={verdictLabel(job.verifierVerdict)} />
            )}
            {job.leakedDescendants && job.leakedDescendants.length > 0 && (
              <DetailLine k="leaked" v={formatLeakedDescendants(job.leakedDescendants)} wrap />
            )}
            {job.leftoverCount != null && job.leftoverCount > 0 && (
              <DetailLine
                k="uncommitted"
                v={`${job.leftoverCount} file${job.leftoverCount === 1 ? '' : 's'}${job.leftoverPathsTruncated ? '+' : ''}: ${(job.leftoverPaths ?? []).join(', ')}${job.salvagePatch ? ` — salvaged to ${job.salvagePatch}` : ''}`}
                wrap
              />
            )}
            {errorText && (
              <DetailLine k="error" v={errorText.split('\n')[0]} wrap />
            )}
          </DetailBlock>

          {job.statusHistory && job.statusHistory.length > 0 && (
            <DetailBlock label="History">
              <div className="grid gap-1">
                {job.statusHistory.map((entry, i) => (
                  <div key={i} className="font-mono text-xs leading-relaxed">
                    <div className="text-fg">
                      {entry.from ?? '(new)'} → {entry.to}
                      <span className="text-fg-faint"> · {formatClock(Date.parse(entry.at))}</span>
                    </div>
                    {entry.reason && (
                      <div className="text-fg-faint break-words">{entry.reason}</div>
                    )}
                  </div>
                ))}
              </div>
            </DetailBlock>
          )}

          <DetailBlock label="Timing">
            <DetailLine
              k="started"
              v={job.startedAt ? formatClock(Date.parse(job.startedAt)) : '—'}
            />
            <DetailLine
              k="finished"
              v={job.finishedAt ? formatClock(Date.parse(job.finishedAt)) : '—'}
            />
            <DetailLine
              k="duration"
              v={
                job.startedAt && job.finishedAt
                  ? formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))
                  : isRunning && elapsedMs !== null
                    ? formatDuration(elapsedMs)
                    : '—'
              }
            />
          </DetailBlock>

          <DetailBlock label="Location">
            <DetailLine k="group" v={`${job.parallelGroup} · ${job.slug}`} />
            <DetailLine k="cwd" v={job.cwd ?? '—'} wrap />
            <DetailLine k="session" v={epicRef.label ?? epicRef.epicId ?? '—'} wrap />
            <DetailLine k="session id" v={epicRef.epicId ?? '—'} wrap />
            <DetailLine k="prompt id" v={job.sourcePromptId ?? '—'} wrap />
            <DetailLine k="source tab" v={job.sourceTabId ?? '—'} wrap />
          </DetailBlock>

          <DetailBlock label="Actions">
            <div className="flex flex-col gap-1.5 items-start">
              {linkedPromptSession && (
                <button
                  type="button"
                  data-testid="job-row-prompt-session-link"
                  title={linkedPromptSession.goalText}
                  onClick={() => navigateToPromptSession(linkedPromptSession.id)}
                  className="text-[13px] font-semibold text-accent hover:text-accent/80 bg-transparent border-0 cursor-pointer p-0"
                >
                  view epic →
                </button>
              )}
              {job.runId && (
                <button
                  type="button"
                  onClick={() => setShowLog(true)}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 cursor-pointer p-0"
                >
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
                  className="text-[13px] font-semibold text-accent hover:text-accent/80 bg-transparent border-0 cursor-pointer p-0"
                >
                  adopt PRD →
                </button>
              )}
              {job.status !== 'pending' && job.status !== 'running' && job.status !== 'quarantined' && (
                <button
                  type="button"
                  onClick={() => window.api.schedule.resetJob(job.slug)}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 cursor-pointer p-0"
                >
                  reset to pending →
                </button>
              )}
              {job.disposition && (job.status === 'pending' || job.status === 'quarantined') && (
                <DispositionControl job={job} headChoices={headChoices} />
              )}
            </div>
          </DetailBlock>
        </div>
      )}

      {showLog && job.runId && (
        <RunLogViewer
          runId={job.runId}
          slug={job.slug}
          title={job.title || job.slug}
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  )
}

export const JobRow = memo(JobRowComponent)
