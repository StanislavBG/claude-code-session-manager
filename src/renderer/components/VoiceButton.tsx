import { useVoice, selectCanRecord, type GateReason } from '../state/voice'
import { useSessions } from '../state/sessions'
import { copyFor } from '../lib/voiceCopy'
import { log } from '../lib/logger'
import { useShallow } from 'zustand/react/shallow'

// Throttle the click-rejected log so a frustrated double-click doesn't flood.
let lastRejectedLog = 0
const REJECTED_LOG_THROTTLE_MS = 1000

function logRejectedThrottled(reason: GateReason) {
  const now = performance.now()
  if (now - lastRejectedLog < REJECTED_LOG_THROTTLE_MS) return
  lastRejectedLog = now
  log.debug('voice', 'mic.gate.click_rejected', { reason })
}

/** Mic button — toggles local Whisper speech-to-text recording. */
export function VoiceButton() {
  // Subscribe to the slices used in the view hook below; the click handler
  // re-reads via getState() to avoid stale-closure races on rapid taps.
  const isRecording = useVoice((s) => s.isRecording)
  const errorMessage = useVoice((s) => s.error)
  const loadingPct = useVoice((s) => s.loadingProgress)
  // Wrap with useShallow: selectCanRecord returns a fresh object each call,
  // which fails React 18's useSyncExternalStore snapshot stability check and
  // triggers React #185 (Maximum update depth) under any concurrent setState.
  const gate = useVoice(useShallow(selectCanRecord))

  const onClick = () => {
    const s = useVoice.getState()
    const { canRecord, reason } = selectCanRecord(s)
    if (s.isRecording) return s.stopRecording()
    // F7: first-time mic click while the wizard is armed opens the wizard
    // INSTEAD of starting recording. The wizard's "Skip & record now" CTA
    // closes the modal and starts recording in one step.
    if (s.wizardArmed && !s.wizardOpen) {
      s.openWizard()
      return
    }
    if (reason === 'error' || reason === 'load-timeout') {
      s.resetAndRetryModel()
      return
    }
    if (!canRecord) return logRejectedThrottled(reason)
    const tabId = useSessions.getState().activeTabId
    if (tabId) s.startRecording(tabId)
  }

  const label = copyFor(gate.reason, {
    loadingPct,
    errorMessage,
    isRecording,
  })

  // Native `disabled` only for permanently-unactionable states (unsupported);
  // aria-disabled keeps the control focusable for transient reasons so the
  // user can tab to it and (for error/load-timeout) trigger a retry.
  const nativeDisabled = gate.reason === 'unsupported'
  const ariaDisabled = !gate.canRecord

  const visualClass = (() => {
    if (gate.reason === 'loading') return 'text-fg-faint animate-pulse cursor-wait'
    if (gate.reason === 'error' || gate.reason === 'load-timeout') return 'text-red-400 cursor-pointer'
    if (gate.reason === 'permission-denied') return 'text-amber-400 cursor-pointer'
    if (gate.reason === 'idle') return 'text-fg-faint cursor-pointer'
    if (gate.reason === 'unsupported') return 'text-fg-faint cursor-not-allowed'
    if (isRecording) return 'text-red-400 ring-2 ring-red-400 animate-pulse'
    return 'text-fg-dim hover:text-fg'
  })()

  return (
    <button
      onClick={onClick}
      disabled={nativeDisabled}
      aria-disabled={ariaDisabled}
      aria-label={label}
      title={label}
      data-testid="mic-button"
      data-state={gate.reason}
      className={`p-1.5 rounded transition-colors ${visualClass}`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="1" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <line x1="12" y1="17" x2="12" y2="21" />
        <line x1="8" y1="21" x2="16" y2="21" />
      </svg>
    </button>
  )
}

/** Speaker icon button — toggles TTS on/off. */
export function TTSToggle() {
  const ttsEnabled = useVoice((s) => s.ttsEnabled)
  const toggleTTS = useVoice((s) => s.toggleTTS)

  return (
    <button
      onClick={toggleTTS}
      title={ttsEnabled ? 'Read Claude replies aloud: ON' : 'Read Claude replies aloud: OFF'}
      className={`px-1.5 py-1 rounded transition-colors flex items-center gap-1 ${
        ttsEnabled ? 'text-accent' : 'text-fg-dim hover:text-fg'
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        {ttsEnabled ? (
          <>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </>
        ) : (
          <>
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </>
        )}
      </svg>
      <span className="text-[10px] font-medium tracking-wide">TTS</span>
    </button>
  )
}
