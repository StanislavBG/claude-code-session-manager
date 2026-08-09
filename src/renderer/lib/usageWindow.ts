/**
 * Shared formatting for a billing UsageWindow (`five_hour`, `seven_day`, …).
 *
 * Both the Home usage meters and the footer's usage pills state the same two
 * things about a window — how full it is and when it resets — so the formatting
 * lives here once rather than being re-derived per surface. Times are rendered
 * in the user's zone (America/Los_Angeles) with an explicit "PT" suffix.
 */
import type { UsageWindow } from '../../preload/api'

/** Reset as { rel: "2h 14m" / "4d 3h", abs: "3:00 PM PT" / "Tue 3:00 PM PT" }. */
export function formatReset(iso: string | null): { rel: string; abs: string } | null {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  const diff = t.getTime() - Date.now()
  if (diff <= 0) return { rel: 'now', abs: '' }
  const days = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  const rel = days > 0 ? `${days}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  const abs =
    days >= 1
      ? t.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : t.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
  return { rel, abs: `${abs} PT` }
}

/** Rounded utilization percent, or null when the window is unavailable. */
export function utilPercent(w: UsageWindow | null | undefined): number | null {
  if (!w) return null
  if (typeof w.utilization !== 'number' || Number.isNaN(w.utilization)) return null
  return Math.round(w.utilization)
}

/** Tooltip line for a usage pill: "Weekly window · 34% used · resets in 4d 3h (Tue 3:00 PM PT)". */
export function usageTitle(label: string, w: UsageWindow | null | undefined): string {
  const pct = utilPercent(w)
  if (pct == null) return `${label} — usage unavailable`
  const reset = formatReset(w?.resets_at ?? null)
  const tail = reset ? ` · resets in ${reset.rel}${reset.abs ? ` (${reset.abs})` : ''}` : ''
  return `${label} · ${pct}% used${tail} — click to open Home`
}
