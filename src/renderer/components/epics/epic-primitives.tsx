/**
 * Shared presentational primitives for the Epics workspace redesign.
 * Follows the sched-primitives.tsx pattern (components/tabs/scheduler/
 * sched-primitives.tsx) — single source of truth for status/kind styling,
 * consumed by EpicQueue (left pane) and the detail pane PRDs sibling.
 */
import type { PromptSession } from '../../state/promptSessions'
import type { EpicDisplayStatus } from '../../lib/epicDerive'
import type { InboundFeedbackOrigin } from '../../lib/epicOrigin'

// ─── EpicStatusChip ──────────────────────────────────────────────────────────
const STATUS_TONE: Record<EpicDisplayStatus, { bg: string; text: string; dot: string; ring?: boolean; label: string }> = {
  running:   { bg: 'bg-accent/15',      text: 'text-accent',      dot: 'bg-accent',      label: 'running' },
  needs:     { bg: 'bg-delta-bad/15',   text: 'text-delta-bad',   dot: 'bg-delta-bad',   label: 'needs you' },
  // PRD 987 — a PRD in this Epic claimed success and this Epic's OWN
  // validation pass caught it not delivering. Ranked above 'failed' in
  // epicDerive.ts's epicDisplayStatus precedence (see that function's doc
  // comment for the rationale) — reuses 'failed'-style red since it's the
  // same "broken, must act" severity, with its own dot/label so it's never
  // confused with an honestly-failed job.
  refuted:   { bg: 'bg-accent/15',      text: 'text-accent',      dot: 'bg-accent',      label: 'refuted — claimed done, not delivered' },
  // A PRD in this Epic came back broken — must be re-scoped or re-queued.
  failed:    { bg: 'bg-accent/15',      text: 'text-accent',      dot: 'bg-accent',      label: 'failed' },
  // A PRD in this Epic parked itself asking a question — the primary
  // "Architect must act" state. Distinct from 'needs', which is a stalled
  // CHAT run, not a PRD.
  attention: { bg: 'bg-butter/25',      text: 'text-fg-dim',      dot: 'bg-butter',      label: 'needs review' },
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
  'project-home-builder': { text: 'text-honey-dark', ring: 'ring-honey/40', label: 'PROJECT HOME BUILDER' },
  'bilko-host-publisher': { text: 'text-sage-dark', ring: 'ring-sage/40', label: 'BILKO HOST PUBLISHER' },
}

const KIND_DOT: Record<NonNullable<PromptSession['tag']>, string> = {
  feature: 'bg-sage',
  bug: 'bg-accent-dark',
  discussion: 'bg-fg-faint',
  build: 'bg-hive-teal',
  'project-home-builder': 'bg-honey',
  'bilko-host-publisher': 'bg-sage',
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

/**
 * "Proposed by another project" chip. Rendered next to EpicKindTag on any
 * Epic that arrived through the cross-project feedback conduit
 * (src/main/lib/crossProjectFeedback.cjs), so the human deciding whether to
 * press Approve & start can see the claim came from an agent that has never
 * read this codebase. Returns null for every locally-created Epic, so callers
 * render it unconditionally on `inboundFeedbackOrigin(epic)`.
 */
export function EpicInboundTag({ origin, small }: { origin: InboundFeedbackOrigin | null; small?: boolean }) {
  if (!origin) return null
  return (
    <span
      title={origin.title}
      data-testid="epic-inbound-tag"
      className={`inline-flex items-center gap-1 font-mono font-semibold uppercase tracking-wide rounded ring-1 ring-inset whitespace-nowrap max-w-[10rem] ${
        small ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-[7px] py-[3px] text-[10.5px]'
      } text-amber-300 ring-amber-400/40`}
    >
      <span aria-hidden="true">↘</span>
      <span className="truncate">{origin.label}</span>
    </span>
  )
}

// ─── EpicWorktreeChip ────────────────────────────────────────────────────────
/**
 * Isolation-state readout for the per-Epic `git worktree` checkpoint (PRDs
 * 1032-1034) — mirrors EpicStatusChip's dot+pill shape rather than
 * inventing new CSS. Reads only the Epic's real `worktree` field: no
 * "N ahead of main" count is shown, since that would need a new IPC call
 * (`worktree` only carries dir/branch/baseCwd/status/conflictReason) and
 * this app's own convention is real data only, never a fabricated number.
 */
const WORKTREE_TONE: Record<
  NonNullable<PromptSession['worktree']>['status'],
  { bg: string; text: string; dot: string; label: string }
> = {
  active: { bg: 'transparent', text: 'text-fg-faint', dot: 'bg-fg-faint', label: 'isolated' },
  needs_merge_resolution: { bg: 'bg-delta-bad/15', text: 'text-delta-bad', dot: 'bg-delta-bad', label: 'merge conflict' },
  merged: { bg: 'bg-sage/20', text: 'text-sage', dot: 'bg-sage', label: 'merged' },
  disabled: { bg: 'bg-muteband/60', text: 'text-fg-dim', dot: 'bg-muteband', label: 'isolation disabled' },
}

export function EpicWorktreeChip({ worktree, small }: { worktree: PromptSession['worktree']; small?: boolean }) {
  const sizeClass = small ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-xs'
  if (!worktree) {
    return (
      <span
        title="This session runs directly in the project's shared working tree — no isolated git worktree."
        data-testid="epic-worktree-chip"
        className={`inline-flex items-center gap-1.5 shrink-0 rounded-full font-semibold tracking-wide whitespace-nowrap ring-1 ring-inset ring-line text-fg-faint ${sizeClass}`}
      >
        shared tree
      </span>
    )
  }
  const tone = WORKTREE_TONE[worktree.status]
  const label = worktree.status === 'active' ? `isolated · ${worktree.branch}` : tone.label
  return (
    <span
      title={worktree.status === 'needs_merge_resolution' && worktree.conflictReason ? worktree.conflictReason : `${worktree.branch} · ${worktree.dir}`}
      data-testid="epic-worktree-chip"
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-full font-semibold tracking-wide whitespace-nowrap ${sizeClass} ${tone.bg} ${tone.text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

// ─── EpicAgentTag ────────────────────────────────────────────────────────────
/**
 * Read-only readout of "which Agent (and, when resolved, which model) is
 * this Epic actually running as" — the session-specific counterpart to
 * EpicKindTag, so this fact lives inside the Epic (EPICS is Session Home)
 * rather than only in Agent Library. Purely presentational: `model` is
 * expected to already be pretty-formatted (lib/prettyModel.ts) by the
 * caller, and `onClick` is the caller's read-only jump-to-definition into
 * Agent Library — this component never edits anything itself.
 */
export function EpicAgentTag({
  agentType,
  model,
  onClick,
  small,
}: {
  agentType: string
  /** Already pretty-formatted (lib/prettyModel.ts), or null when the
   *  persona has no explicit model override (absent / 'inherit'). */
  model?: string | null
  onClick?: () => void
  small?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Agent: ${agentType}${model ? ` — ${model}` : ''} — click to open in Agent Library`}
      data-testid="epic-agent-tag"
      className={`inline-flex items-center gap-1 rounded font-mono font-semibold uppercase tracking-wide ring-1 ring-inset ring-hive-teal/40 text-hive-teal whitespace-nowrap hover:bg-hive-teal/10 ${
        small ? 'px-1.5 py-0.5 text-[9.5px]' : 'px-[7px] py-[3px] text-[10.5px]'
      }`}
    >
      {agentType}
      {model && <span className="normal-case tracking-normal text-fg-faint">· {model}</span>}
    </button>
  )
}
