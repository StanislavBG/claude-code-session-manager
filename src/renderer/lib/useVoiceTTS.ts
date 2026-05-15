import { useEffect } from 'react'
import { useVoice, BARGE_IN_TTL_MS } from '../state/voice'
import { speak, stopSpeaking } from './speechSynthesis'
import { log } from './logger'

/**
 * Subscribes to transcript events for the active tab and pipes assistant
 * text content through TTS when enabled.
 *
 * F4: each speak() is gated by `lastBargeInAt`. After the user barges in,
 * streamed assistant chunks arriving within BARGE_IN_TTL_MS are dropped so
 * the cancelled TTS doesn't immediately re-start mid-word.
 */
export function useVoiceTTS(activeTabId: string | null): void {
  const ttsEnabled = useVoice((s) => s.ttsEnabled)
  const isRecording = useVoice((s) => s.isRecording)

  useEffect(() => {
    if (!activeTabId || !ttsEnabled) return

    const trySpeak = (text: string) => {
      const last = useVoice.getState().lastBargeInAt
      if (last !== null && performance.now() - last < BARGE_IN_TTL_MS) {
        log.debug('voice', 'tts.suppressed.barge-in-ttl', { ageMs: Math.round(performance.now() - last) })
        return
      }
      speak(text)
    }

    const off = window.api.transcripts.onEvent(activeTabId, (ev) => {
      if (ev.kind !== 'message') return
      // Defense in depth: transcript events arrive from main as `unknown` data.
      // Validate the shape before destructuring so a malformed JSONL line
      // can't crash this listener (which would bubble to React's error boundary).
      const data = ev.data
      if (typeof data !== 'object' || data === null) return
      const d = data as { role?: unknown; content?: unknown }
      if (d.role !== 'assistant') return
      if (useVoice.getState().isRecording) return

      const content = d.content
      if (typeof content === 'string') {
        trySpeak(content)
      } else if (Array.isArray(content)) {
        const text = content
          .filter((b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
          )
          .map((b) => b.text)
          .join(' ')
        if (text) trySpeak(text)
      }
    })

    return off
  }, [activeTabId, ttsEnabled])

  useEffect(() => {
    // Click-stop fast path: when isRecording flips on, cut TTS immediately.
    // Set lastBargeInAt so streamed assistant chunks within the TTL window
    // are also dropped — same contract as a VAD-driven barge-in.
    if (isRecording) {
      stopSpeaking()
      useVoice.setState({ lastBargeInAt: performance.now() })
    }
  }, [isRecording])
}
