/**
 * VAD threshold ducking for F4 barge-in. While TTS plays, raise the VAD's
 * positive/negative speech thresholds so self-talk leaking into the mic
 * doesn't retrigger barge-in. AEC is best-effort upstream (and a no-op when
 * MicVAD owns its own AudioContext separate from speechSynthesis output);
 * ducking carries the real load.
 *
 * Restored thresholds on TTS end. Designed to attach to one recognition
 * handle for its lifetime; returns an unsubscribe to detach on stop().
 */

import {
  type RecognitionHandle,
  VAD_DUCKED_POSITIVE,
  VAD_DUCKED_NEGATIVE,
} from './speechRecognition'
import { onSpeakStart, onSpeakEnd, isSpeaking } from './speechSynthesis'
import { log } from './logger'

const VAD_RESTORED_POSITIVE = 0.5
const VAD_RESTORED_NEGATIVE = 0.35

/**
 * Bind ducking to a live recognition handle. Call the returned function
 * when stopping recording so we don't leak listeners.
 */
export function attachVadDucking(handle: RecognitionHandle): () => void {
  // Catch up on already-speaking state at the moment we attach.
  if (isSpeaking()) {
    handle.setVadThresholds(VAD_DUCKED_POSITIVE, VAD_DUCKED_NEGATIVE)
    log.info('voice', 'tts.duck.on', { reason: 'already-speaking-on-attach' })
  }
  const offStart = onSpeakStart(() => {
    handle.setVadThresholds(VAD_DUCKED_POSITIVE, VAD_DUCKED_NEGATIVE)
    log.info('voice', 'tts.duck.on')
  })
  const offEnd = onSpeakEnd(() => {
    handle.setVadThresholds(VAD_RESTORED_POSITIVE, VAD_RESTORED_NEGATIVE)
    log.info('voice', 'tts.duck.off')
  })
  return () => { offStart(); offEnd() }
}
