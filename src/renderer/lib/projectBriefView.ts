/**
 * Pure view-helpers for ProjectHome's synthesized Brief blocks (PRD 840).
 * No React, no IPC — translation of project-home-mock.jsx's `PhMd` splitter,
 * `PH_SCOPE_TINT` map, and source-chip shaping into testable functions the
 * component composes with ph-primitives.tsx block chrome.
 */
import { formatAgo } from './formatTime'

// ─── mini-markdown (PhMd) ────────────────────────────────────────────────
export type MdToken = { type: 'text' | 'bold' | 'code'; text: string }

/** Splits on `**bold**` / `` `code` `` spans — mirrors the mock's regex
 *  exactly. Unmatched `*`/`` ` `` characters pass through as plain text. */
export function tokenizeMd(text: string): MdToken[] {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  const tokens: MdToken[] = []
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      tokens.push({ type: 'bold', text: part.slice(2, -2) })
    } else if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      tokens.push({ type: 'code', text: part.slice(1, -1) })
    } else {
      tokens.push({ type: 'text', text: part })
    }
  }
  return tokens
}

// ─── scope kind → tone ───────────────────────────────────────────────────
export type ScopeKind = 'added' | 'narrowed' | 'decided'

export interface ScopeTone {
  label: string
  textClass: string
  borderClass: string
}

const SCOPE_TONE: Record<ScopeKind, ScopeTone> = {
  added: { label: 'added', textClass: 'text-delta-good', borderClass: 'border-delta-good/40' },
  narrowed: { label: 'narrowed', textClass: 'text-delta-bad', borderClass: 'border-delta-bad/40' },
  decided: { label: 'decided', textClass: 'text-honey-dark', borderClass: 'border-honey-dark/40' },
}

const FALLBACK_SCOPE_TONE: ScopeTone = { label: '', textClass: 'text-fg-faint', borderClass: 'border-line' }

/** Defensive default for scope entries whose `kind` isn't one of the three
 *  known values — renders as a neutral pill labeled with the raw string
 *  rather than crashing or silently relabeling it as something else. */
export function scopeTone(kind: string): ScopeTone {
  const known = SCOPE_TONE[kind as ScopeKind]
  if (known) return known
  return { ...FALLBACK_SCOPE_TONE, label: kind }
}

// ─── source chips ────────────────────────────────────────────────────────
export interface SourceChipInput {
  label: string
  detail: string
  drift: boolean
}

export interface SourceChipView {
  label: string
  detail: string
  drift: boolean
  driftMark: string | null
}

export function formatSourceChip(source: SourceChipInput): SourceChipView {
  return {
    label: source.label,
    detail: source.detail,
    drift: !!source.drift,
    driftMark: source.drift ? 'newer than brief' : null,
  }
}

// ─── header provenance line ──────────────────────────────────────────────
/** "synthesized 12m ago" — falls back when the timestamp can't be parsed. */
export function synthesizedAgoLabel(synthesizedAt: string | null | undefined, now: number): string {
  if (!synthesizedAt) return 'not synthesized yet'
  const ms = Date.parse(synthesizedAt)
  if (Number.isNaN(ms)) return 'not synthesized yet'
  return `synthesized ${formatAgo(ms, now)}`
}

// ─── areas heat bar ───────────────────────────────────────────────────────
/** Clamps a 0-1 heat value to an integer 0-100 percentage for the bar width
 *  and the numeric label — defends against out-of-range/NaN synthesis output. */
export function heatPercent(heat: number): number {
  if (typeof heat !== 'number' || !Number.isFinite(heat)) return 0
  return Math.max(0, Math.min(100, Math.round(heat * 100)))
}

// ─── defensive list defaults ──────────────────────────────────────────────
/** Any non-array (missing field on a malformed brief) becomes []  so callers
 *  can `.map()` unconditionally instead of repeating `?? []` at every call
 *  site — the "one place" for that defensive default. */
export function safeList<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}
