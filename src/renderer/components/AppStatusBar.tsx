import type { BillingFetchResult } from '../../preload/api'
import { useVoice } from '../state/voice'
import { useBilling } from '../state/billing'
import { StatusDot } from './ui/StatusDot'

/**
 * App-level 28px status bar mounted between RecordingStatus and TabBar.
 * Shows voice activity + 5h-usage chip. Model / effort / team moved to the
 * Overview cockpit; restart/broadcast/watchers moved to LeftNav Session.
 *
 * Privacy invariant: this bar is mounted BELOW RecordingStatus in App.tsx, so
 * the recording banner remains the topmost element while isRecording === true.
 */
export function AppStatusBar() {
  const isRecording = useVoice((s) => s.isRecording)
  const statusPill = useVoice((s) => s.statusPill)
  const billing = useBilling((s) => s.data)

  const fivePct = readFiveHourPct(billing)
  const voiceDotKind = isRecording
    ? 'live'
    : statusPill === 'listening'
      ? 'live'
      : 'idle'

  const voiceLabel = `voice ${isRecording ? 'live' : statusPill}`
  return (
    <div
      data-testid="app-status-bar"
      role="toolbar"
      aria-label="Session manager status"
      className="h-7 shrink-0 border-b border-line bg-bg-elev flex items-center gap-2 px-3 text-xs text-fg-dim"
    >
      <div className="flex-1" />

      <div
        className="flex items-center gap-1.5"
        title={`voice: ${statusPill}`}
        aria-live="polite"
        aria-label={voiceLabel}
      >
        <StatusDot kind={voiceDotKind} aria-label={voiceLabel} />
        <span className="text-fg-faint" aria-hidden="true">voice {isRecording ? 'live' : statusPill}</span>
      </div>

      {fivePct !== null && (
        <div
          className="flex items-center gap-1.5 font-mono tabular-nums"
          title={`5h window: ${fivePct.toFixed(0)}% utilized`}
          aria-label={`5-hour usage ${fivePct.toFixed(0)} percent`}
          role="status"
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${fiveHourDotColor(fivePct)}`}
            aria-hidden="true"
          />
          <span className={fiveHourTextColor(fivePct)} aria-hidden="true">5h: {fivePct.toFixed(0)}%</span>
        </div>
      )}
    </div>
  )
}

/** Extract the five-hour utilization percent from a billing result, or null. */
function readFiveHourPct(b: BillingFetchResult | null): number | null {
  if (!b) return null
  if (b.kind === 'ok' || b.kind === 'ok-stale') {
    const u = b.data.usage.five_hour?.utilization
    return typeof u === 'number' ? u : null
  }
  if (b.kind === 'auth' && b.cached) {
    const u = b.cached.usage.five_hour?.utilization
    return typeof u === 'number' ? u : null
  }
  return null
}

/** Matches barColor() thresholds in BillingStatusBanner.tsx (50/70/90). */
function fiveHourDotColor(pct: number): string {
  if (pct >= 90) return 'bg-red-400'
  if (pct >= 70) return 'bg-yellow-400'
  if (pct >= 50) return 'bg-emerald-400'
  return 'bg-fg-faint/50'
}

function fiveHourTextColor(pct: number): string {
  if (pct >= 90) return 'text-red-400'
  if (pct >= 70) return 'text-yellow-400'
  return 'text-fg-dim'
}
