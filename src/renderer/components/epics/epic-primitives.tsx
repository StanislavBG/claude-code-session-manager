/**
 * Shared presentational primitives for the Epics workspace redesign.
 * Follows the sched-primitives.tsx pattern (components/tabs/scheduler/
 * sched-primitives.tsx) — single source of truth for status/kind styling,
 * consumed by EpicQueue (left pane) and the detail pane PRDs sibling.
 */
import type { PromptSession } from '../../state/promptSessions'
import type { EpicDisplayStatus } from '../../lib/epicDerive'

// ─── EpicStatusChip ──────────────────────────────────────────────────────────
const STATUS_TONE: Record<EpicDisplayStatus, { bg: string; text: string; dot: string; ring?: boolean; label: string }> = {
  running:   { bg: 'bg-accent/15',      text: 'text-accent',      dot: 'bg-accent',      label: 'running' },
  needs:     { bg: 'bg-delta-bad/15',   text: 'text-delta-bad',   dot: 'bg-delta-bad',   label: 'needs you' },
  // Mock (epics-mock.jsx E_STATUS): queued is a FILLED tan pill (#ece0c6) —
  // only active (resting) is the outline variant. Dot is solid muteband (tan),
  // distinct from active's fg-faint grey — in compact rows (dot only, no label text)
  // those two states would otherwise render as the identical dot color,
  // making a run genuinely queued behind the session-slot pool look
  // indistinguishable from an Epic that never started anything.
  queued:    { bg: 'bg-muteband/60',    text: 'text-fg-dim',      dot: 'bg-muteband',    label: 'queued' },
  // Started and alive, with nothing in flight this instant. The Epic's real
  // persisted status — not a placeholder for "never started" (that is
  // 'proposed'). Outline variant, muted, since it is the resting state.
  active:    { bg: 'transparent',       text: 'text-fg-faint',    dot: 'bg-fg-faint',    label: 'active', ring: true },
  // Filed by automation, waiting on a human to approve before it spends
  // anything — the state that replaced the feedback-folder inbox.
  proposed:  { bg: 'bg-butter/25',      text: 'text-fg-dim',      dot: 'bg-butter',      label: 'proposed', ring: true },
  completed: { bg: 'bg-sage/20',        text: 'text-sage',        dot: 'bg-sage',        label: 'completed' },
}

export function epicStatusDotClass(status: EpicDisplayStatus): string {
  return STATUS_TONE[status].dot
}

export function epicStatusLabel(status: EpicDisplayStatus): string {
  return STATUS_TONE[status].label
}

export function EpicStatusChip({
  status,
  small,
  detail,
}: {
  status: EpicDisplayStatus
  small?: boolean
  /** Optional longer explanation (e.g. "waiting on a session slot") — shown as
   *  a hover tooltip and appended to the aria-label so a queued-but-not-yet-
   *  running Epic reads as more than just "queued". */
  detail?: string
}) {
  const tone = STATUS_TONE[status]
  return (
    <span
      role="status"
      title={detail}
      aria-label={detail ? `Status: ${tone.label} — ${detail}` : `Status: ${tone.label}`}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-full font-semibold tracking-wide whitespace-nowrap ${
        small ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-xs'
      } ${tone.bg} ${tone.text}${tone.ring ? ' ring-1 ring-inset ring-line' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden="true" />
      {tone.label}
    </span>
  )
}

// ─── EpicKindTag ─────────────────────────────────────────────────────────────
const KIND_TONE: Record<NonNullable<PromptSession['tag']>, { text: string; ring: string; label: string }> = {
  feature:    { text: 'text-sage',       ring: 'ring-sage/40',       label: 'FEATURE' },
  bug:        { text: 'text-accent-dark', ring: 'ring-accent-dark/40', label: 'BUG' },
  discussion: { text: 'text-fg-faint',   ring: 'ring-fg-faint/40',   label: 'DISCUSSION' },
  build:      { text: 'text-hive-teal',  ring: 'ring-hive-teal/40',  label: 'BUILD' },
}

const KIND_DOT: Record<NonNullable<PromptSession['tag']>, string> = {
  feature: 'bg-sage',
  bug: 'bg-accent-dark',
  discussion: 'bg-fg-faint',
  build: 'bg-hive-teal',
}

/** Solid dot color for a kind, e.g. the tag-grouped Epic queue section header. */
export function epicKindDotClass(kind: NonNullable<PromptSession['tag']>): string {
  return KIND_DOT[kind]
}

/** Title-case kind label, e.g. the tag-grouped Epic queue section header. */
export function epicKindLabel(kind: NonNullable<PromptSession['tag']>): string {
  return KIND_TONE[kind].label.charAt(0) + KIND_TONE[kind].label.slice(1).toLowerCase()
}

export function EpicKindTag({ kind, small }: { kind: PromptSession['tag']; small?: boolean }) {
  if (!kind) return null
  const tone = KIND_TONE[kind]
  return (
    <span
      className={`inline-flex items-center font-mono font-semibold uppercase tracking-wide rounded ring-1 ring-inset whitespace-nowrap ${
        small ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-[7px] py-[3px] text-[10.5px]'
      } ${tone.text} ${tone.ring}`}
    >
      {tone.label}
    </span>
  )
}
