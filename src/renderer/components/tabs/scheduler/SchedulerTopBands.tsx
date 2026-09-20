import { useEffect, useMemo, useState } from 'react'
import type { ScheduleFirePolicy, ScheduleQueueHealthResult, ScheduleQueueHealthVerdict } from '../../../../preload/api.d'
import { useScheduleState } from '../../../state/scheduleState'
import { usePromptSessions } from '../../../state/promptSessions'
import { toast } from '../../../state/toast'
import { formatAgo, formatRelative } from '../../../lib/formatTime'
import { withTimeout } from '../../../lib/withTimeout'
import { buildPlans, summarizeQueue } from '../../../lib/schedulerStages'
import { computeStatus } from './computeStatus'
import { LearningPanel } from '../../LearningPanel'
import { BandRow, InfoDot, KpiCell, MiniBar, SegmentPills, Stepper } from './sched-primitives'

/**
 * Design 2A's three full-bleed bands — title (40px), KPI (70px), PLANS toolbar
 * (30px) — replacing the four stacked cards (serif title block, QueueHealthHeader,
 * WindowStrip, SchedulePanel's FireStatus + PolicyBar). UI only: every control
 * keeps its existing window.api call.
 *
 * Where the old stats went (nothing shown before is lost):
 *   QueueHealthHeader  verdict headline → title-band ⓘ; slots → SLOTS cell;
 *                      pending/dispatchable → READY NOW cell + ⓘ; needs_review → NEEDS YOU
 *                      cell; oldest running / last batch / last dispatch attempt → title-band ⓘ + meta.
 *   WindowStrip        reset countdown + utilization (+ stale-poll note) → WINDOW USED cell;
 *                      pending/running/completed-today legend → title meta + READY NOW / DONE TODAY;
 *                      pause banner, Retry-now and degraded-mode banners → <SchedulerAlerts/> below.
 *   SchedulePanel      FireStatus line/`computeStatus` → title-band ⓘ; Pause/Resume/Fire/Refresh → title
 *   PolicyBar          buttons; fire-policy select + concurrency cap + utilization threshold → CONCURRENCY cell.
 */

export type SubView = 'queue' | 'prds' | 'history' | 'machine'
export type PlanMode = 'graph' | 'list' | 'critical'

const POLL_MS = 15_000
const ATTENTION = new Set(['failed', 'needs_review', 'quarantined'])

/** Shared with the plan list: first failed/needs_review/quarantined row scrolls into view. */
function scrollToNeedsYou(): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-job-row]'))
  const target = rows.find((r) => ATTENTION.has(r.dataset.jobStatus ?? ''))
  target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

function headline(v: ScheduleQueueHealthVerdict, oldestRunningAgeMs: number | null): string {
  switch (v.kind) {
    case 'paused':
      return `paused: scheduler is paused (${v.reason ?? 'manual'})`
    case 'launch-blocked':
      return `launch-blocked: ${v.agentType} jobs can't launch${v.block?.kind ? ` (${v.block.kind})` : ''}`
    case 'idle':
      return 'idle: 0 pending'
    case 'saturated': {
      const oldest = oldestRunningAgeMs != null ? `, oldest ${formatRelative(oldestRunningAgeMs)}` : ''
      return `saturated: ${v.totalSlots ?? '?'} slot(s) busy${oldest}`
    }
    case 'blocked': {
      const chains = v.blockedChains.length
      return `blocked: ${v.pending} pending, ${v.dispatchable} dispatchable — ${chains} chain${chains === 1 ? '' : 's'} stuck behind a failed/skipped dependency`
    }
    case 'stalled':
      return `stalled: no dispatch attempt in ${v.idleMs != null ? formatRelative(v.idleMs) : '?'} with ${v.dispatchable} dispatchable`
    case 'running':
    default:
      return `running: ${v.runningCount} in flight, ${v.pending} pending`
  }
}

/**
 * Queue-health poll (15s) — the source for slots / verdict / dispatchable /
 * lastDispatchAttemptAt. schedule:state broadcasts on every mutation, but the
 * verdict depends on machine-wide slot occupancy + wall-clock idle time.
 */
function useQueueHealth(scopeCwd: string | null): ScheduleQueueHealthResult | null {
  const [result, setResult] = useState<ScheduleQueueHealthResult | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.api.schedule.queueHealth(scopeCwd).then((r) => { if (alive) setResult(r) }).catch(() => {})
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [scopeCwd])
  return result
}

type StateWord = 'running' | 'paused' | 'idle'
const WORD_TONE: Record<StateWord, { dot: string; text: string }> = {
  running: { dot: 'bg-sage', text: 'text-sage-dark' },
  paused: { dot: 'bg-amber-500', text: 'text-amber-600' },
  idle: { dot: 'bg-fg-faint', text: 'text-fg-faint' },
}

function wordFor(kind: ScheduleQueueHealthVerdict['kind'] | null, paused: boolean, inFlight: number): StateWord {
  if (kind === 'paused' || kind === 'launch-blocked') return 'paused'
  if (kind === 'running' || kind === 'saturated') return 'running'
  if (kind) return 'idle'
  return paused ? 'paused' : inFlight > 0 ? 'running' : 'idle'
}

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

const BTN = 'px-2.5 py-1.5 rounded border border-line text-[12.5px] font-medium text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'

// ─── Alerts — pause reason + circuit-breaker banners (full-bleed strips) ────

function pauseMessage(reason: string, resumeAt: string | null, now: number): string {
  if (reason === 'auth') return 'Scheduler paused: Claude sign-in expired or invalid. Restart the app or re-run `claude login`, then Resume.'
  if (reason === 'rate_limit') {
    if (resumeAt) {
      const remaining = new Date(resumeAt).getTime() - now
      return remaining > 0 ? `Paused for rate limit — resumes in ${formatRelative(remaining)}` : 'Paused for rate limit — resume pending'
    }
    return 'Paused for rate limit'
  }
  if (reason === 'network') return 'Paused: billing endpoint unreachable for 30+ min.'
  if (reason === 'manual') return 'Scheduler paused manually — no new jobs start; running jobs continue. Click Resume to restart.'
  return `Scheduler paused (${reason})`
}

function SchedulerAlerts({ now }: { now: number }) {
  const snapshot = useScheduleState((s) => s.snapshot)
  if (!snapshot) return null
  const paused = snapshot.paused
  const launchBlocks = Object.entries(snapshot.launchBlocks ?? {})
  const launchMitigations = Object.entries(snapshot.launchMitigations ?? {})
  const isErrorPause = paused?.reason === 'auth' || paused?.reason === 'network'
  const strip = 'flex items-start gap-3 border-b px-0 py-1.5 text-[12.5px]'
  const red = 'bg-red-950/10 border-red-700/30 text-red-800'
  const amber = 'bg-amber-400/10 border-amber-600/30 text-amber-700'
  const btn = 'shrink-0 px-2 py-0.5 rounded border border-current/40 hover:bg-white/20 text-[12px] font-medium'
  return (
    <>
      {paused && (
        <div data-testid="pause-banner" className={`${strip} ${isErrorPause ? red : amber}`}>
          <span className="flex-1 leading-snug">{pauseMessage(paused.reason, paused.resumeAt, now)}</span>
          <button type="button" onClick={() => window.api.schedule.resume()} className={btn}>Resume</button>
        </div>
      )}
      {launchBlocks.map(([key, block]) => (
        <div key={`launch-block-${key}`} data-testid="launch-block-banner" className={`${strip} ${red}`}>
          <div className="flex-1 leading-snug min-w-0">
            <div className="font-medium">
              Launches for <span className="font-mono">{key}</span> jobs are failing before any work starts
              {block.httpStatus ? ` (HTTP ${block.httpStatus}, ${block.kind})` : ` (${block.kind})`}
              {block.exhausted
                ? ' — held until the Claude CLI version changes or you press Retry now.'
                : block.until
                  ? ` — next automatic probe ${new Date(block.until).getTime() > now ? `in ${formatRelative(new Date(block.until).getTime() - now)}` : 'on the next tick'}.`
                  : '.'}
            </div>
            <div className="opacity-80">{block.hint}</div>
            <div className="font-mono text-[11.5px] opacity-70 truncate" title={block.message}>
              {block.attempts} failed probe{block.attempts === 1 ? '' : 's'}
              {block.claudeVersion ? ` · CLI ${block.claudeVersion}` : ''}
              {block.lastSlug ? ` · last: ${block.lastSlug}` : ''}
              {' · '}{block.message}
            </div>
          </div>
          <button type="button" onClick={() => window.api.schedule.resume()} className={btn}>Retry now</button>
        </div>
      ))}
      {launchMitigations.map(([key, m]) => (
        <div key={`launch-mitigation-${key}`} data-testid="launch-mitigation-banner" className={`${strip} ${amber}`}>
          <div className="flex-1 leading-snug min-w-0">
            <div className="font-medium">
              <span className="font-mono">{key}</span> jobs are running in degraded mode
              {' '}(<span className="font-mono">{Object.entries(m.env).map(([k, v]) => `${k}=${v}`).join(' ')}</span>)
              {m.claudeVersion ? ` since CLI ${m.claudeVersion}` : ''}.
            </div>
            <div className="opacity-80">{m.hint}</div>
          </div>
        </div>
      ))}
    </>
  )
}

// ─── The three bands ────────────────────────────────────────────────────────

export interface SchedulerTopBandsProps {
  scopeCwd: string | null
  subView: SubView
  onSubView: (v: SubView) => void
  filterText: string
  onFilterText: (t: string) => void
  planMode: PlanMode
  onPlanMode: (m: PlanMode) => void
}

export function SchedulerTopBands({ scopeCwd, subView, onSubView, filterText, onFilterText, planMode, onPlanMode }: SchedulerTopBandsProps) {
  const snapshot = useScheduleState((s) => s.snapshot)
  const sessions = usePromptSessions((s) => s.sessions)
  const health = useQueueHealth(scopeCwd)
  const [now, setNow] = useState(() => Date.now())
  // DONE TODAY cost/tokens: best-effort, one call on mount, never blocks paint.
  const [spend, setSpend] = useState<string>('—')

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let alive = true
    // Promise.resolve().then: a synchronous throw (api not ready) is swallowed too.
    withTimeout(Promise.resolve().then(() => window.api.history.dashboard({ rangeDays: 30 })), 5_000, 'history.dashboard')
      .then((r) => {
        if (!alive) return
        const t = r.totals
        const tok = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens
        setSpend(`$${t.estimatedCostUsd.toFixed(2)} · ${fmtTok(tok)} tok`)
      })
      .catch(() => { /* best-effort by design — stays '—' */ })
    return () => { alive = false }
  }, [])

  const jobs = useMemo(
    () => (snapshot?.jobs ?? []).filter((j) => !scopeCwd || j.cwd === scopeCwd),
    [snapshot, scopeCwd],
  )
  const summary = useMemo(() => summarizeQueue(jobs, now), [jobs, now])
  const planCounts = useMemo(() => {
    const plans = buildPlans(jobs, { sessions, now })
    const n = (s: string) => plans.filter((p) => p.status === s).length
    return { active: n('active'), queued: n('queued'), draft: n('draft') }
  }, [jobs, sessions, now])
  const avgToday = useMemo(() => {
    const today = new Date(now).toDateString()
    const durs: number[] = []
    for (const j of jobs) {
      if (j.status === 'completed' && j.startedAt && j.finishedAt && new Date(Date.parse(j.finishedAt)).toDateString() === today) {
        const d = Date.parse(j.finishedAt) - Date.parse(j.startedAt)
        if (d > 0) durs.push(d)
      }
    }
    return durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length / 60_000) : null
  }, [jobs, now])

  if (!snapshot) return null

  const verdict = health && !health.unknown ? health.verdict ?? null : null
  const slots = health && !health.unknown ? health.slots ?? null : null
  const paused = snapshot.paused
  const word = wordFor(verdict?.kind ?? null, !!paused, summary.inFlight)
  const tone = WORD_TONE[word]
  const pending = jobs.filter((j) => j.status === 'pending').length
  const running = jobs.filter((j) => j.status === 'running').length
  const status = computeStatus({ snap: { ...snapshot, jobs }, now, avgDurationMs: 0, runningJobs: jobs.filter((j) => j.status === 'running') })
  const verdictHeadline = health?.unknown
    ? `Queue health: unknown — ${health.reason ?? 'state unavailable'}`
    : verdict ? headline(verdict, health?.oldestRunningAgeMs ?? null) : 'queue health loading…'
  const lastBatch = formatAgo(snapshot.lastRunAt ? Date.parse(snapshot.lastRunAt) : null, now)
  const lastAttempt = health?.lastDispatchAttemptAt ? formatAgo(Date.parse(health.lastDispatchAttemptAt), now) : 'never'
  const infoTitle = [
    verdictHeadline,
    status.line1,
    verdict ? `dispatchable ${verdict.dispatchable} · needs_review ${verdict.needsReviewCount}` : null,
    health?.oldestRunningAgeMs != null ? `oldest running ${formatRelative(health.oldestRunningAgeMs)} (any project)` : null,
    `last batch fired ${lastBatch} (lastRunAt — advances only when a job launches)`,
    `last dispatch attempt ${lastAttempt} (advances on every driver evaluation)`,
  ].filter(Boolean).join('\n')

  // Window used
  const util = snapshot.utilization
  const pollHealth = snapshot.pollHealth
  const pollStale = pollHealth != null && !pollHealth.lastPollOk
  const resetMs = snapshot.nextReset ? Date.parse(snapshot.nextReset) : null
  const resetsIn = resetMs ? (resetMs > now ? formatRelative(resetMs - now) : 'soon') : '—'

  // Concurrency
  const ec = snapshot.effectiveConcurrency
  const cap = ec?.cap ?? 5
  const envPinned = ec?.source === 'env'
  const policy = snapshot.config.firePolicy ?? 'when-available'
  const fireDisabled = pending === 0 && running === 0

  return (
    <div data-testid="scheduler-top-bands" className="shrink-0 px-[18px]">
      {/* ── Title band — 40px ─────────────────────────────────────── */}
      <BandRow height={40} testId="queue-health-header" className="gap-3">
        <h1 className="m-0 font-serif text-[21px] font-semibold leading-none tracking-tight text-fg">Scheduler</h1>
        <span className="w-px h-[20px] bg-rule-structural" aria-hidden="true" />
        <span className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${tone.text}`} data-testid="scheduler-state-word" data-state={word}>
          <span className={`w-2 h-2 rounded-full ${tone.dot}`} aria-hidden="true" />
          {word}
        </span>
        <span className="font-mono text-[12px] text-fg-faint whitespace-nowrap" data-testid="scheduler-meta">
          {summary.inFlight} in flight · {summary.heldByDeps} held · last batch {lastBatch}
        </span>
        <InfoDot title={infoTitle} testId="scheduler-verdict-info" />
        <span className="ml-auto flex items-center gap-2">
          <LearningPanel active="scheduler" />
          <button
            type="button"
            onClick={() => window.api.schedule.rescan().then(toast.fromOutcome).catch(() => toast.error('Failed to rescan'))}
            title="Re-scan the prds/ folder. Use when you've added or edited PRDs on disk and want the queue to reflect them immediately."
            className={BTN}
          >
            Refresh
          </button>
          {paused ? (
            <button type="button" onClick={() => window.api.schedule.resume()} title="Clear the pause and resume queue immediately" className={BTN}>Resume</button>
          ) : (
            <button type="button" onClick={() => window.api.schedule.pause()} title="Stop NEW dispatch. Running jobs are not killed." className={BTN}>Pause</button>
          )}
          <button
            type="button"
            onClick={() => window.api.schedule.forceTick().then(toast.fromOutcome).catch(() => toast.error('Failed to fire batch'))}
            disabled={fireDisabled}
            title="Bypasses the billing-usage poll. Use when the meter is rate-limited or you want immediate progress."
            className="px-3 py-1.5 rounded bg-accent text-white text-[12.5px] font-semibold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
          >
            Fire next batch
          </button>
        </span>
      </BandRow>

      <SchedulerAlerts now={now} />

      {/* ── KPI band — 70px, six equal cells ──────────────────────── */}
      <BandRow height={70} testId="scheduler-kpi-band">
        <KpiCell
          testId="kpi-window"
          label="Window used"
          info={pollStale ? `Billing poll failing — this reading may be outdated (last good reading ${formatAgo(pollHealth!.lastPollAt, now)}). Machine-wide 5h window.` : 'Share of the machine-wide 5h billing window consumed.'}
          value={util === null || util === undefined ? '—' : `${Math.round(util)}%`}
          sub={`resets in ${resetsIn}`}
          third={<MiniBar pct={util ?? 0} tone={pollStale ? 'bg-amber-500' : 'bg-accent'} />}
        />
        <KpiCell
          testId="kpi-slots"
          label="Slots"
          info={`Machine-wide session pool (${slots?.source === 'env' ? 'SM_SESSION_SLOTS override' : 'Home tab cap'}), not scoped to this project`}
          value={slots ? `${slots.inUse}/${slots.total}` : '—'}
          sub="in use"
          third={slots ? <SegmentPills filled={slots.inUse} total={slots.total} /> : null}
        />
        <KpiCell
          testId="kpi-ready"
          label="Ready now"
          info="Pending rows whose dependsOn chain is fully satisfied right now"
          value={summary.readyNow}
          sub={`of ${summary.totalQueued} queued`}
          third={`${summary.heldByDeps} held by deps`}
        />
        {summary.needsYou > 0 ? (
          <KpiCell
            testId="kpi-needs-you"
            label="Needs you"
            value={
              <button type="button" data-testid="kpi-needs-you-jump" onClick={scrollToNeedsYou} className="font-semibold text-accent hover:underline" title="Scroll to the first failed / needs-review / quarantined row">
                {summary.needsYou}
              </button>
            }
            sub={
              <button type="button" onClick={scrollToNeedsYou} className="hover:underline">
                {summary.needsYouStage != null ? `blocking stage ${summary.needsYouStage}` : 'need attention'}
              </button>
            }
            third={[
              summary.failedCount > 0 && `${summary.failedCount} failed`,
              summary.needsReviewCount > 0 && `${summary.needsReviewCount} needs review`,
              (summary.needsYou - summary.failedCount - summary.needsReviewCount) > 0 && `${summary.needsYou - summary.failedCount - summary.needsReviewCount} quarantined`,
            ].filter(Boolean).join(' · ')}
          />
        ) : (
          <KpiCell
            testId="kpi-needs-you"
            label="Needs you"
            value={<span className="inline-flex items-center gap-1.5 text-[15px]"><span className="w-2.5 h-2.5 rounded-full bg-sage" aria-hidden="true" />all clear</span>}
            third="0 failed · 0 needs review"
          />
        )}
        <KpiCell
          testId="kpi-done"
          label="Done today"
          value={summary.doneToday}
          sub={avgToday != null ? `avg ${avgToday}m` : 'avg —'}
          third={<span data-testid="kpi-done-spend">{spend}</span>}
        />
        <KpiCell
          testId="kpi-concurrency"
          label="Concurrency"
          labelExtra={
            <select
              data-testid="kpi-fire-policy"
              value={policy}
              onChange={(e) => window.api.schedule.setConfig({ firePolicy: e.target.value as ScheduleFirePolicy })}
              className="appearance-none border border-line bg-bg-hi rounded px-1 py-0 text-[10.5px] text-fg-dim"
              title="when-available: poll usage and fire when tokens are below threshold. on-reset: fire after each 5h reset. manual: only on Run now."
              aria-label="Start jobs policy"
            >
              <option value="when-available">when available</option>
              <option value="on-reset">only on reset</option>
              <option value="manual">manually</option>
            </select>
          }
          value={
            <span className="inline-flex items-center gap-1">
              <Stepper
                value={cap}
                min={0}
                max={10}
                disabled={envPinned}
                onChange={(next) => { void window.api.schedule.setSessionSlots(Math.max(0, Math.min(10, next))) }}
                title={envPinned ? 'pinned by SM_SESSION_SLOTS — unset the env var to edit' : 'Machine-wide claude -p session slots, shared with chat runs'}
              />
              {envPinned && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-400/10 border border-amber-400/30 rounded px-1 py-0" title="Pinned by SM_SESSION_SLOTS — unset the env var to edit">env</span>
              )}
            </span>
          }
          sub="at once"
          third={
            policy === 'when-available' ? (
              <span className="inline-flex items-center gap-1">
                pause above
                <input
                  type="number"
                  min={0}
                  max={100}
                  data-testid="kpi-threshold"
                  value={snapshot.config.utilizationThreshold ?? 90}
                  onChange={(e) => window.api.schedule.setConfig({ utilizationThreshold: Math.max(0, Math.min(100, Number(e.target.value))) })}
                  className="w-9 text-center border border-line bg-bg-hi rounded py-0 font-mono text-[11.5px] text-fg"
                  title="Fire only when 5h utilization is below this percent"
                />
                %
              </span>
            ) : null
          }
        />
      </BandRow>

      {/* ── PLANS toolbar — 30px ──────────────────────────────────── */}
      <BandRow height={30} testId="scheduler-plans-toolbar" className="gap-3">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">Plans</span>
        <span className="font-mono text-[12px] text-fg-faint whitespace-nowrap" data-testid="scheduler-plans-meta">
          {planCounts.active} active · {planCounts.queued} queued · {planCounts.draft} draft · {jobs.length} PRDs
        </span>
        <span className="ml-auto flex items-center gap-3">
          <input
            type="text"
            value={filterText}
            onChange={(e) => onFilterText(e.target.value)}
            placeholder="filter PRDs…"
            aria-label="Filter PRDs by title, slug, or project"
            data-testid="scheduler-filter-input"
            className="w-[180px] bg-bg-hi border border-line rounded px-2 py-0.5 text-[12px] text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint"
          />
          <span className="inline-flex border border-line rounded overflow-hidden" role="group" aria-label="Plan view mode">
            {([['graph', 'Graph'], ['list', 'List'], ['critical', 'Critical path']] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                data-testid={`plan-mode-${m}`}
                aria-pressed={planMode === m && subView === 'queue'}
                onClick={() => { onPlanMode(m); onSubView('queue') }}
                className={`px-2 py-0.5 text-[12px] ${planMode === m && subView === 'queue' ? 'bg-bg-elev font-semibold text-fg' : 'text-fg-dim hover:text-fg'}`}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="w-px h-[16px] bg-rule-structural" aria-hidden="true" />
          {([['prds', 'PRDs', 'Authored PRD source files on disk — edit, lint, archive, or queue them.'],
            ['history', 'History', 'The last 50 completed and failed jobs.'],
            ['machine', 'Machine', 'Machine-wide config that applies to every project — not this project’s live queue.']] as const).map(([v, label, title]) => (
            <button
              key={v}
              type="button"
              onClick={() => onSubView(v)}
              aria-pressed={subView === v}
              title={title}
              className={`text-[12.5px] ${subView === v ? 'font-semibold text-fg' : 'text-fg-faint hover:text-fg-dim'}`}
            >
              {label}
            </button>
          ))}
        </span>
      </BandRow>
    </div>
  )
}
