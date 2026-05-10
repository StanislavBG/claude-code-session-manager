import { useEffect, useState } from 'react'
import { useVoice } from '../state/voice'

/**
 * Thin 2px progress bar that visualizes the auto-submit countdown after a
 * voice transcript lands. Width animates from 100% → 0% over `submitDelayMs`.
 * Color is accent (calm) for the first 80% of the window, then amber (warn)
 * for the final 500ms so the user has visual notice that Enter is imminent.
 *
 * Renders nothing when no countdown is armed.
 */
export function SubmitCountdown() {
  const startAt = useVoice((s) => s.submitCountdownStartAt)
  const delayMs = useVoice((s) => s.submitDelayMs)
  const [now, setNow] = useState(() => performance.now())

  useEffect(() => {
    if (startAt === null) return
    let frame: number
    const tick = () => {
      setNow(performance.now())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [startAt])

  if (startAt === null) return null
  const elapsed = now - startAt
  const remaining = Math.max(0, delayMs - elapsed)
  const pct = Math.max(0, Math.min(100, (remaining / delayMs) * 100))
  const isWarning = remaining < 500
  const cancel = useVoice.getState().cancelSubmit

  return (
    <div
      className="px-3 pb-1"
      onClick={cancel}
      title={`Submitting in ${(remaining / 1000).toFixed(1)}s — click to cancel`}
    >
      <div className="h-0.5 w-full bg-bg rounded overflow-hidden cursor-pointer">
        <div
          className={`h-full transition-colors ${isWarning ? 'bg-amber-400' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
