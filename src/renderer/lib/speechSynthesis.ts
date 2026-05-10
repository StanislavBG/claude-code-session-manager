/**
 * Wrapper around the Web Speech API's SpeechSynthesis.
 * Strips markdown before speaking. Tracks utterance lifecycle so callers
 * can anchor barge-in latency from `utterance.onstart` (real playback start),
 * not from `speak()` call time, and so VAD ducking can react to TTS state.
 */

let speakStartedAt: number | null = null
const startListeners = new Set<() => void>()
const endListeners = new Set<() => void>()

function notifyStart(): void { for (const fn of startListeners) try { fn() } catch { /* */ } }
function notifyEnd(): void { for (const fn of endListeners) try { fn() } catch { /* */ } }

/** Strip markdown formatting so TTS reads clean prose. */
function stripMarkdown(text: string): string {
  return (
    text
      // code blocks
      .replace(/```[\s\S]*?```/g, '')
      // inline code
      .replace(/`([^`]+)`/g, '$1')
      // headings
      .replace(/^#{1,6}\s+/gm, '')
      // bold/italic
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
      // links
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // blockquotes
      .replace(/^>\s?/gm, '')
      // list markers
      .replace(/^[\s]*[-*+]\s/gm, '')
      .replace(/^[\s]*\d+\.\s/gm, '')
      .trim()
  )
}

export function speak(text: string): void {
  if (!window.speechSynthesis) return
  const clean = stripMarkdown(text)
  if (!clean) return
  const utterance = new SpeechSynthesisUtterance(clean)
  utterance.rate = 1.0
  utterance.pitch = 1.0
  utterance.onstart = () => {
    speakStartedAt = performance.now()
    notifyStart()
  }
  // 'end' fires for natural completion. Between one utterance's onend and
  // the next utterance's actual playback Chrome can briefly read
  // `speaking === false` while a queued one is `pending` — checking both
  // suppresses a false notifyEnd flap that would un-duck the VAD for a frame.
  utterance.onend = () => {
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      speakStartedAt = null
      notifyEnd()
    }
  }
  // 'canceled' is fired by stopSpeaking() and is already handled there;
  // double-firing notifyEnd would log duck-off twice and lift the VAD
  // ducking briefly while the cancellation tail (~20-80ms) is still audible.
  utterance.onerror = (e: SpeechSynthesisErrorEvent) => {
    if (e.error === 'canceled') return
    if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
      speakStartedAt = null
      notifyEnd()
    }
  }
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel()
  speakStartedAt = null
  notifyEnd()
}

export function isSpeaking(): boolean {
  return window.speechSynthesis?.speaking ?? false
}

/** Returns when current playback started, or null if not speaking. */
export function getSpeakStartedAt(): number | null {
  return speakStartedAt
}

/** Subscribe to playback start (utterance.onstart, not speak() call). */
export function onSpeakStart(fn: () => void): () => void {
  startListeners.add(fn)
  return () => { startListeners.delete(fn) }
}

/** Subscribe to playback end (natural or via stopSpeaking()). */
export function onSpeakEnd(fn: () => void): () => void {
  endListeners.add(fn)
  return () => { endListeners.delete(fn) }
}
