/**
 * Time-formatting helpers shared by SchedulePanel, Overview, and any other
 * surface that displays "Xm ago" / "Xh Ym" / clock-time strings. Three near-
 * identical copies lived in SchedulePanel.tsx (811-842) and Overview.tsx
 * (502-509) before; unified here so a rounding fix in one place reaches all.
 */

/** Compact "Xs / Xm00s / XhYYm" — for elapsed durations. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${(s % 60).toString().padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`
}

/** Short "Xs / Xm / XhYm / Xd" — for "X ago" or "in X" displays. */
export function formatRelative(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/** Wall-clock time with timezone abbreviation. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

/** "Xs ago" / "Xm ago" — coarser than formatRelative, used by Overview's
 *  freshness widgets where we always want the trailing " ago" suffix. */
export function formatAgoSec(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

/** "never" / "just now" / "Xm ago" relative to a clock time. */
export function formatAgo(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const diff = now - ms
  if (diff < 0) return 'soon'
  if (diff < 5_000) return 'just now'
  return `${formatRelative(diff)} ago`
}

/** "saved Xs ago" / "saved Xm ago" / "saved Xh ago" — used by SaveBar. */
export function formatTimeSince(ts: number | null | undefined): string {
  if (!ts) return ''
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 60_000) return `saved ${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `saved ${Math.round(delta / 60_000)}m ago`
  return `saved ${Math.round(delta / 3_600_000)}h ago`
}

/**
 * Relative "X ago" label for a file mtime (milliseconds since epoch).
 * Returns '' when ms is falsy (0 / null / undefined) — callers treat that
 * as "never shown yet". Replaces the deleted formatMtime.ts duplicate.
 */
export function formatMtimeMs(ms: number | null | undefined): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 5_000) return 'just now'
  return `${formatRelative(diff)} ago`
}

/** "M:SS" elapsed clock — used by live status bars (SuperAgentStatusBar)
 *  ticking a running job's elapsed time once a second. */
export function formatElapsedClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toString().padStart(2, '0')}`
}

/** Human-readable label for job durations: "2h 15m", "45m", "30s".
 *  Unlike formatDuration (compact "XhYYm") this uses spaces and drops
 *  sub-minute precision for large values, making it easier to scan. */
export function formatTimingLabel(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`
}
