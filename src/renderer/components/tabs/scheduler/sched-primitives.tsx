/**
 * Shared presentational primitives for the Almanac Scheduler design.
 * Single source of truth consumed by Queue / PRDs / History restyle PRDs (20-group).
 */
import type { ReactNode } from 'react'
import type { ScheduleJobStatus } from '../../../../preload/api'

// ─── Project dot palette ────────────────────────────────────────────────────
// Values are exact Tailwind theme token colors (sage, accent, fg-faint, butter,
// hive-slate, hive-teal, hive-plum) kept inline so the dot <span> can use
// style={{ backgroundColor }} without a runtime class-lookup.
const PROJ_DOTS = ['#6f7d52', '#b85c34', '#8a7a60', '#e4b85a', '#5f6f86', '#4f7d72', '#8a5a6e']

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0
  return h
}

function projectDot(cwd?: string | null, name?: string): string {
  const base = cwd ? (cwd.split('/').filter(Boolean).pop() ?? '') : (name ?? '')
  return PROJ_DOTS[hashStr(base) % PROJ_DOTS.length]
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
  const label = name ?? (cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : '—')
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

// ─── STATUS_TONE — PRD status pill styling ───────────────────────────────────
// Consumed by SchedulerPrdsView restyle (PRD 20-scheduler-prds).
export const STATUS_TONE: Record<string, { bg: string; text: string; border: boolean; label: string }> = {
  running: { bg: 'bg-butter/30', text: 'text-fg-dim',   border: false, label: 'running' },
  queued:  { bg: 'bg-sage/25',   text: 'text-sage',     border: false, label: 'queued' },
  ready:   { bg: 'bg-bg',        text: 'text-fg-dim',   border: true,  label: 'ready to run' },
  draft:   { bg: 'bg-bg',        text: 'text-fg-faint', border: true,  label: 'draft' },
}
