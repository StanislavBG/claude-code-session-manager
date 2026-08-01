/**
 * Shared presentational primitives for the Almanac Scheduler design.
 * Single source of truth consumed by Queue / PRDs / History restyle PRDs (20-group).
 */
import type { ReactNode } from 'react'
import type { ScheduleJobStatus } from '../../../../preload/api'
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
  running:      'bg-accent text-white',
  pending:      'bg-bg text-fg-dim border border-line',
  completed:    'bg-sage/20 text-sage',
  needs_review: 'bg-butter/25 text-fg-dim',
  failed:       'bg-accent/15 text-accent',
}

const BADGE_MARKS: Partial<Record<ScheduleJobStatus, string>> = {
  pending:      '○',
  completed:    '✓',
  needs_review: '!',
  failed:       '✕',
}

export function SchBadge({ status }: { status: ScheduleJobStatus }) {
  const mark = BADGE_MARKS[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-lg min-w-[104px] justify-center text-xs font-semibold tracking-wide ${BADGE_CLASSES[status]}`}
      role="status"
      aria-label={`Status: ${status.replace('_', ' ')}`}
    >
      {status === 'running' ? (
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" aria-hidden="true" />
      ) : (
        mark && <span aria-hidden="true">{mark}</span>
      )}
      {status.replace('_', ' ')}
    </span>
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
  const title = known ? `Epic · ${label}` : `Epic ${epicId} is not currently loaded`
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

// ─── LegendItem — dot + count + label chip used in window strip ──────────────
export function LegendItem({ dotClass, n, label }: { dotClass: string; n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-dim">
      <span className={`w-2 h-2 rounded-full ${dotClass}`} aria-hidden="true" />
      <strong className="text-fg font-mono text-[13.5px]">{n}</strong>
      {' '}{label}
    </span>
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
  pass_no_commit: 'PASS sentinel but no commit landed',
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
  running:      { bg: 'bg-butter/30', text: 'text-fg-dim',   border: false, label: 'running' },
  queued:       { bg: 'bg-sage/25',   text: 'text-sage',     border: false, label: 'queued' },
  ready:        { bg: 'bg-bg',        text: 'text-fg-dim',   border: true,  label: 'ready to run' },
  draft:        { bg: 'bg-bg',        text: 'text-fg-faint', border: true,  label: 'draft' },
  completed:    { bg: 'bg-sage/20',   text: 'text-sage',     border: false, label: 'completed' },
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
}

export type PrdDisplayStatus = keyof typeof STATUS_TONE

/**
 * Derive a PRD's display status from its (possibly absent) queue.json job
 * entry — the single source consumed by both the PRDs card list and the PRD
 * editor toolbar, so a PRD's status word is never computed two different
 * ways in the same view family.
 */
export function prdStatusFor(job: { status: ScheduleJobStatus } | null | undefined): PrdDisplayStatus {
  if (!job) return 'ready'
  return job.status === 'pending' ? 'queued' : job.status
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
