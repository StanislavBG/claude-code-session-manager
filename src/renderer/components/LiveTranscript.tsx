// F9 — Live Transcript Render. Display-only overlay for voice partials.
// F6 invariant: this component NEVER calls pty.write. Partials are advisory;
// only onFinal in voice.ts is authoritative. Fade-out is 300ms to allow CSS
// transition after isRecording flips false.
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useVoice, selectLiveTranscript } from '../state/voice'
import { SubmitCountdown } from './SubmitCountdown'

const DOT: Record<string, string> = {
  listening: 'bg-red-400',
  transcribing: 'bg-amber-400',
  restarting: 'bg-blue-400',
}

const LABEL: Record<string, string> = {
  listening: 'Listening',
  transcribing: 'Transcribing…',
  restarting: 'Restarting…',
  idle: 'Idle',
  truncated: 'Truncated',
}

export function LiveTranscript() {
  const { isRecording, statusPill, lastPartial, lastTranscript, submitCountdownStartAt } =
    useVoice(useShallow(selectLiveTranscript))

  const visible = isRecording || !!lastPartial || !!lastTranscript

  // Keep mounted for 300ms after visibility drops so the fade-out can play.
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) {
      setMounted(true)
    } else {
      const t = setTimeout(() => setMounted(false), 300)
      return () => clearTimeout(t)
    }
  }, [visible])

  if (!mounted) return null

  let displayText = lastPartial
  if (displayText.length > 200) {
    displayText = '…' + displayText.slice(-200)
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Dictation preview"
      data-testid="live-transcript"
      className={`absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[70%] min-w-[280px] pointer-events-none transition-opacity duration-300 z-30 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="bg-bg-elev/85 backdrop-blur border border-line rounded-lg px-4 py-2 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="shrink-0 flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[statusPill] ?? 'bg-fg-faint'}`}
            />
            <span className="text-[11px] uppercase tracking-wide text-fg-dim">
              {LABEL[statusPill] ?? statusPill}
            </span>
          </div>
          {displayText && (
            <p className="flex-1 min-w-0 italic text-fg/85 font-mono text-sm line-clamp-2">
              {displayText}
            </p>
          )}
          {submitCountdownStartAt !== null && (
            <div className="shrink-0">
              <SubmitCountdown />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
