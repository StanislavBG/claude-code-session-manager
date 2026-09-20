/**
 * Shared presentational primitives for the Almanac Scheduler design.
 * Single source of truth consumed by Queue / PRDs / History restyle PRDs (20-group).
 */
import type { ReactNode } from 'react'
import type { ScheduleJobStatus, LeakedDescendant, ScheduleJob } from '../../../../preload/api'
import { Badge } from '../../ui/Badge'
import { projectColorFor } from '../../../lib/projectColor'
import { shortEpicId } from '../../../lib/epicProvenance'

// ─── projectNameFromCwd — canonical "last path segment" extraction ──────────
// Single source for turning an absolute project cwd into a short display
// name. Consumed by ProjectTag below plus every filter/list/group surface in
// this family that needs to match or list projects by name (Queue filter
// text search, History's project dropdown + filter, PRDs card list).
export function projectNameFromCwd(cwd?: string | null): string | null {
  if (!cwd) return null
  const segs = cwd.replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || cwd
}

function projectDot(cwd?: string | null, name?: string): string {
  const base = cwd ? (projectNameFromCwd(cwd) ?? '') : (name ?? '')
  return projectColorFor(base)
}

// ─── SchBadge ────────────────────────────────────────────────────────────────
const BADGE_CLASSES: Record<ScheduleJobStatus, string> = {
  running:       'bg-accent text-white',
  investigating: 'bg-accent text-white',
  pending:       'bg-bg text-fg-dim border border-line',
  completed:     'bg-sage/20 text-sage',
  skipped:       'bg-fg-dim/10 text-fg-dim border border-line',
  needs_review:  'bg-butter/25 text-fg-dim',
  failed:        'bg-accent/15 text-accent',
  quarantined:   'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40',
}

const BADGE_MARKS: Partial<Record<ScheduleJobStatus, string>> = {
  pending:      '○',
  completed:    '✓',
  skipped:      '⊘',
  needs_review: '!',
  failed:       '✕',
  quarantined:  '⚑',
}

export function SchBadge({ status }: { status: ScheduleJobStatus }) {
  const mark = BADGE_MARKS[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-lg min-w-[104px] justify-center text-xs font-semibold tracking-wide ${BADGE_CLASSES[status]}`}
      role="status"
      aria-label={`Status: ${status.replace('_', ' ')}`}
    >
      {status === 'running' || status === 'investigating' ? (
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" aria-hidden="true" />
      ) : (
        mark && <span aria-hidden="true">{mark}</span>
      )}
      {status.replace('_', ' ')}
    </span>
  )
}

// ─── LeakBadge ───────────────────────────────────────────────────────────────
// A job's `completed` status is never changed by a leak (PRD 1110) — this is
// purely an annotation that childWithLog.cjs's sweepChildProcessGroup had to
// reap process-group survivors the job left running past its own exit.

/** Single source for "pid + comm, comma-joined" — the tooltip and the
 *  expanded-detail row must never drift into two different formats. */
export function formatLeakedDescendants(leaked: LeakedDescendant[]): string {
  return leaked.map((p) => `${p.comm} (pid ${p.pid})`).join(', ')
}

export function LeakBadge({ leaked }: { leaked?: LeakedDescendant[] }) {
  if (!leaked || leaked.length === 0) return null
  return (
    <Badge
      tone="warn"
      className="shrink-0 normal-case"
      title={`Leaked ${leaked.length} descendant process${leaked.length === 1 ? '' : 'es'} — swept after exit: ${formatLeakedDescendants(leaked)}`}
    >
      <span data-testid="leak-badge">⚠ {leaked.length}</span>
    </Badge>
  )
}

// ─── LeftoverBadge ───────────────────────────────────────────────────────────
// A `failed` row that left uncommitted work is a very different triage case
// from one that left nothing — this badge makes that visually distinct
// regardless of status (completed/failed/needs_review can all carry
// leftovers; see the commit-guard's own consequence, which this never
// changes — only what's displayed).

export function LeftoverBadge({ count, truncated, salvagePatch }: {
  count?: number
  truncated?: boolean
  salvagePatch?: string | null
}) {
  if (!count || count <= 0) return null
  const label = `left ${count}${truncated ? '+' : ''} file${count === 1 ? '' : 's'} uncommitted`
  const salvageHint = salvagePatch ? ` — recoverable from salvage patch ${salvagePatch}` : ''
  return (
    <Badge
      tone="warn"
      className="shrink-0 normal-case"
      title={`${label}${salvageHint}`}
    >
      <span data-testid="leftover-badge">{label}</span>
    </Badge>
  )
}

// ─── OverrunBadge ────────────────────────────────────────────────────────────
// job.overrun is stamped by scheduler.cjs's findOverrunningJobs escalation
// while status stays 'running', and cleared on finish/reap/reset — read the
// decision straight off the row, never recompute JOB_OVERRUN_FACTOR here
// (that threshold is main-process-only; the renderer never mirrors it).

export function OverrunBadge({ status, overrun }: {
  status: ScheduleJobStatus
  overrun?: ScheduleJob['overrun']
}) {
  if (status !== 'running' || !overrun) return null
  const label = `${overrun.ratio.toFixed(1)}x over ${overrun.estimateMinutes}m est`
  return (
    <Badge
      tone="warn"
      className="shrink-0 normal-case"
      title={`Running ${Math.round(overrun.ranMs / 60_000)}m against a ${overrun.estimateMinutes}m estimate — check the run log, then let it finish or cancel it via scheduler_cancel_job`}
    >
      <span data-testid="overrun-badge">{label}</span>
    </Badge>
  )
}

// ─── ProjectTag ──────────────────────────────────────────────────────────────
export function ProjectTag({ cwd, name }: { cwd?: string | null; name?: string }) {
  const label = name ?? (cwd ? projectNameFromCwd(cwd) ?? cwd : '—')
  const dot = projectDot(cwd, name)
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-faint">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

// ─── EpicTag ─────────────────────────────────────────────────────────────────
// "Which Epic did this come from" — the one chip every Scheduler surface uses
// (Queue rows, PRD cards, History rows) so they can't drift apart. Purely
// presentational, like ProjectTag: the caller resolves the ref via
// lib/epicProvenance.resolveEpicRef and passes the result in. `onOpen` makes
// it a deep-link into the Epic; omit it for a static label.
export function EpicTag({
  epicId,
  label,
  onOpen,
  testId = 'epic-tag',
  className = '',
}: {
  epicId: string | null
  label: string | null
  onOpen?: (epicId: string) => void
  /** Overridable so a host row can keep its own established test hook. */
  testId?: string
  className?: string
}) {
  if (!epicId) return null
  const known = label != null
  const text = known ? label : shortEpicId(epicId)
  const title = known ? `Session · ${label}` : `Session ${epicId} is not currently loaded`
  const body = (
    <>
      <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70 shrink-0">epic</span>
      <span className="truncate">{text}</span>
    </>
  )
  const base = `inline-flex items-center gap-1.5 font-mono text-[11.5px] max-w-full min-w-0 ${className}`
  if (!onOpen || !known) {
    return (
      <span data-testid={testId} data-epic-id={epicId} title={title} className={`${base} text-fg-faint`}>
        {body}
      </span>
    )
  }
  return (
    <span
      role="button"
      tabIndex={0}
      data-testid={testId}
      data-epic-id={epicId}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onOpen(epicId)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          e.preventDefault()
          onOpen(epicId)
        }
      }}
      className={`${base} text-accent hover:text-accent/80 cursor-pointer`}
    >
      {body}
    </span>
  )
}

// ─── DetailBlock / DetailLine ────────────────────────────────────────────────
export function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-bold tracking-[0.7px] uppercase text-fg-faint mb-2">
        {label}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  )
}

export function DetailLine({ k, v, wrap }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div className="flex gap-2 font-mono text-xs leading-relaxed">
      <span className="text-fg-faint shrink-0 w-14">{k}</span>
      <span className={`text-fg ${wrap ? 'break-all' : ''}`}>{v}</span>
    </div>
  )
}

// ─── VERDICT_LABELS — verifier verdict → human-readable label ───────────────
// Single source consumed by the Queue job detail panel, PRDs needs_review
// card, and History job detail panel — all three surfaces display a job's
// verifierVerdict and must show the same human-readable text, not the raw
// machine slug (e.g. "no_verdict_sentinel").
export const VERDICT_LABELS: Record<string, string> = {
  halt: 'verifier halted',
  deps_unmet: 'dependencies unmet',
  transcript_errors: 'transcript had errors',
  verify_unavailable: 'verify unavailable',
  uncommitted_changes: 'uncommitted changes',
  no_verdict_sentinel: 'no commit or verdict sentinel',
  abandoned_background_task: 'abandoned auto-backgrounded task',
  pass_no_commit: 'PASS sentinel but no commit landed',
  silent_no_op: 'no commit, clean tree — no evidence of work',
  blocked_by_foreign_wip_streak: "blocked by a sibling job's foreign WIP 3x in a row",
}

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict
}

// ─── prdNumber — extract leading numeric group from a slug ──────────────────
export function prdNumber(slug: string): string | null {
  const m = slug.match(/^(\d+)-/)
  return m ? m[1] : null
}

// ─── PrdNumberBadge — monospaced #NN chip (Almanac design) ──────────────────
export function PrdNumberBadge({ n }: { n: string }) {
  return (
    <span
      className="font-mono text-[12px] font-semibold text-fg-faint shrink-0 tracking-tight select-none"
      aria-hidden="true"
    >
      #{n}
    </span>
  )
}

// ─── STATUS_TONE — PRD status pill styling ───────────────────────────────────
// Consumed by SchedulerPrdsView restyle (PRD 20-scheduler-prds).
export const STATUS_TONE: Record<string, { bg: string; text: string; border: boolean; label: string }> = {
  // running/queued deliberately mirror SchBadge's colors for the same two
  // states (accent-filled running, neutral bordered queued/pending) — these
  // two pill systems represent the same underlying job status, and used to
  // diverge here: "queued" rendered in the same sage/green as "completed",
  // making a not-yet-run PRD look done at a glance.
  running:       { bg: 'bg-accent',    text: 'text-white',    border: false, label: 'running' },
  investigating: { bg: 'bg-accent',    text: 'text-white',    border: false, label: 'investigating' },
  queued:       { bg: 'bg-bg',        text: 'text-fg-dim',   border: true,  label: 'queued' },
  ready:        { bg: 'bg-bg',        text: 'text-fg-dim',   border: true,  label: 'ready to run' },
  draft:        { bg: 'bg-bg',        text: 'text-fg-faint', border: true,  label: 'draft' },
  completed:    { bg: 'bg-sage/20',   text: 'text-sage',     border: false, label: 'completed' },
  // Never-ran: the PRD source vanished before dispatch, so no executor
  // spawned — deliberately neutral, never the green 'completed' tone, so an
  // unrun row can't masquerade as shipped work (see JOB_STATUSES header).
  skipped:      { bg: 'bg-fg-dim/10', text: 'text-fg-dim',   border: true,  label: 'skipped' },
  failed:       { bg: 'bg-accent/15', text: 'text-accent',   border: false, label: 'failed' },
  needs_review: { bg: 'bg-butter/25', text: 'text-fg-dim',   border: false, label: 'needs review' },
  // A chat PromptTicket (PRD 750) that classified 'develop' and handed off to
  // /develop's PRD-authoring flow — distinct from 'queued'/'running' so the
  // chat queue panel can tell "still in this run's queue" apart from
  // "became scheduler work".
  dispatched:   { bg: 'bg-accent/15', text: 'text-accent',   border: true,  label: 'dispatched to PRD' },
  // A chat PromptTicket (PRD 766) whose run stopped on the
  // <<<SM_NEEDS_INPUT>>> sentinel and is stalled waiting on the user's reply
  // — amber to match the inline "❓ Needs your answer" question card in
  // TerminalChat.tsx (AMBER_TEXT/AMBER_TINT there use the same retuned hex).
  needs_input:  { bg: 'bg-[#8e641a]/10', text: 'text-[#7a5416]', border: true, label: 'needs your answer' },
  // PRD 987 — the traffic light reads the authoring Epic's own validation
  // verdict, not just the job's self-reported outcome. Four states total
  // (green/red/claimed/in-flight); 'verified'/'refuted'/'validating' reuse
  // the existing completed/failed/running colors (same palette, distinct
  // label so the accessible name still states the real state) — only
  // 'claimed' is a genuinely new tone, deliberately neutral: neither green
  // (nothing has confirmed the work) nor red (nothing has refuted it
  // either). A job reporting outcome:'completed' with no validation pass yet
  // must render here, never in the 'completed' (green) tone above — see
  // resolveValidatedStatus.
  claimed:      { bg: 'bg-muteband/60', text: 'text-fg-dim',   border: true,  label: 'claimed — not yet verified' },
  verified:     { bg: 'bg-sage/20',     text: 'text-sage',     border: false, label: 'verified' },
  refuted:      { bg: 'bg-accent/15',   text: 'text-accent',   border: false, label: 'refuted' },
  validating:   { bg: 'bg-accent',      text: 'text-white',    border: false, label: 'validating' },
}

export type PrdDisplayStatus = keyof typeof STATUS_TONE

/**
 * PRD 987 — folds an event/job's validation verdict (PRD 986's
 * `PromptSessionEvent.validation`) into the status word a tone is looked up
 * by. `outcome` is a `ScheduleJobStatus`-shaped status ('completed' /
 * 'failed' / 'needs_review' / anything else e.g. 'running'/'pending'/etc).
 *
 * Precedence: an honest job-level 'failed'/'needs_review' always wins — "a
 * job that admits it failed needs no validation to be believed" — then the
 * validation verdict ('verified' → green, 'refuted' → red, 'validating' →
 * in-flight), then 'unvalidated' collapses a self-reported 'completed' into
 * the neutral 'claimed' tone so a PRD that merely claims success can never
 * render green on its own say-so. Any other combination (no validation
 * stamp at all — pre-PRD-986 events, or a non-terminal status like
 * 'running'/'queued') passes `outcome` through unchanged, preserving every
 * caller's existing behavior when validation data isn't present.
 */
export function resolveValidatedStatus(
  outcome: PrdDisplayStatus,
  validation?: 'unvalidated' | 'validating' | 'verified' | 'refuted',
): PrdDisplayStatus {
  if (outcome === 'failed' || outcome === 'needs_review') return outcome
  if (validation === 'verified') return 'verified'
  if (validation === 'refuted') return 'refuted'
  if (validation === 'validating') return 'validating'
  if (validation === 'unvalidated' && outcome === 'completed') return 'claimed'
  return outcome
}

/**
 * Derive a PRD's display status from its (possibly absent) queue.json job
 * entry — the single source consumed by both the PRDs card list and the PRD
 * editor toolbar, so a PRD's status word is never computed two different
 * ways in the same view family. `validation` (PRD 986/987) is optional so
 * existing callers that don't yet have an Epic's validation verdict handy
 * keep their prior behavior unchanged (resolveValidatedStatus passes
 * `outcome` through as-is when `validation` is absent).
 */
export function prdStatusFor(
  job: { status: ScheduleJobStatus } | null | undefined,
  validation?: 'unvalidated' | 'validating' | 'verified' | 'refuted',
): PrdDisplayStatus {
  if (!job) return 'ready'
  const baseStatus = job.status === 'pending' ? 'queued' : job.status
  return resolveValidatedStatus(baseStatus, validation)
}

// ─── PrdStatusPill — STATUS_TONE-backed status pill for PRD cards/editor ────
export function PrdStatusPill({ status }: { status: PrdDisplayStatus }) {
  const tone = STATUS_TONE[status]
  return (
    <span
      role="status"
      aria-label={`Status: ${tone.label}`}
      className={`text-[11.5px] font-semibold px-[9px] py-0.5 rounded-full ${tone.bg} ${tone.text}${tone.border ? ' ring-1 ring-inset ring-line' : ''}`}
    >
      {tone.label}
    </span>
  )
}

// ─── 2A band primitives — full-bleed rows separated by 1px rules, no card ────
// Title band / KPI band / PLANS toolbar are all built from these. No rounded
// corner, no border box: the only chrome is the 1px rule-structural underline.

export function BandRow({ children, height, className = '', testId }: {
  children: ReactNode; height?: number; className?: string; testId?: string
}) {
  return (
    <div
      data-testid={testId}
      style={height ? { height } : undefined}
      className={`flex items-center border-b border-rule-structural ${className}`}
    >
      {children}
    </div>
  )
}

/** ⓘ affordance — the native title carries the detail (no popover state to leak). */
export function InfoDot({ title, testId }: { title: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center w-[13px] h-[13px] rounded-full border border-fg-faint text-[9px] leading-none text-fg-faint cursor-help normal-case tracking-normal"
    >
      i
    </span>
  )
}

/** One KPI cell: SMALL-CAPS label row, big value + inline sub, third line. */
export function KpiCell({ label, info, labelExtra, value, sub, third, testId }: {
  label: string
  info?: string
  labelExtra?: ReactNode
  value: ReactNode
  sub?: ReactNode
  third?: ReactNode
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      className="flex-1 basis-0 min-w-0 px-3 py-1 border-l border-rule-structural first:border-l-0 flex flex-col justify-center gap-0.5"
    >
      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint leading-none">
        <span>{label}</span>
        {info && <InfoDot title={info} />}
        {labelExtra && <span className="ml-auto normal-case tracking-normal">{labelExtra}</span>}
      </div>
      <div className="flex items-baseline gap-1.5 min-w-0 leading-tight">
        <span className="text-[21px] font-semibold text-fg leading-none">{value}</span>
        {sub && <span className="text-[12px] text-fg-dim truncate">{sub}</span>}
      </div>
      <div className="font-mono text-[11.5px] text-fg-faint leading-none truncate h-[13px] flex items-center">{third}</div>
    </div>
  )
}

/** Thin horizontal progress bar. `pct` is 0–100 and is clamped. */
export function MiniBar({ pct, tone = 'bg-accent' }: { pct: number; tone?: string }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <span className="block w-full h-[5px] bg-rule-inner rounded-sm overflow-hidden" role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}>
      <span className={`block h-full ${tone}`} style={{ width: `${w}%` }} />
    </span>
  )
}

/** `total` pills, first `filled` lit. */
export function SegmentPills({ filled, total }: { filled: number; total: number }) {
  const n = Math.max(0, Math.min(total, 10))
  return (
    <span className="flex gap-[3px] w-full" data-testid="kpi-slot-pills">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`flex-1 h-[5px] rounded-sm ${i < filled ? 'bg-accent' : 'bg-rule-inner'}`} />
      ))}
    </span>
  )
}

/** −/N/+ stepper, clamped to [min, max]. */
export function Stepper({ value, min, max, disabled, onChange, title }: {
  value: number; min: number; max: number; disabled?: boolean; onChange: (next: number) => void; title?: string
}) {
  const btn = 'w-[20px] h-[20px] leading-none rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed text-[13px]'
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <button type="button" aria-label="Decrease concurrency" data-testid="kpi-concurrency-dec" disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - 1))} className={btn}>−</button>
      <span data-testid="kpi-concurrency-value" className="w-[20px] text-center text-[18px] font-semibold text-fg font-mono">{value}</span>
      <button type="button" aria-label="Increase concurrency" data-testid="kpi-concurrency-inc" disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + 1))} className={btn}>+</button>
    </span>
  )
}
