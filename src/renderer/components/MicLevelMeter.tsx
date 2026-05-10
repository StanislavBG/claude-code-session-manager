import { useEffect, useRef, useState } from 'react'
import { useVoice, getActiveAnalyser } from '../state/voice'

/**
 * F3 mic-level meter (v1 cut).
 *
 * Renders a 4 px horizontal RMS bar while `useVoice.isRecording === true`.
 * Subscribes to the active RecognitionHandle's AnalyserNode (via
 * `getActiveAnalyser()` from voice.ts) and runs a single requestAnimationFrame
 * loop that:
 *   1. Pulls 2048 bytes of time-domain data from the analyser.
 *   2. Computes RMS over them — O(n) where n = fftSize = 2048; ~10 µs/frame
 *      on commodity hardware. Amortised O(1) per render.
 *   3. Updates the bar width (cosmetic curve `pow(rms, 0.4) * 1.2`, clamped).
 *
 * Performance budget: ≤ 2 % main-thread CPU at 60 Hz target
 * (F3 PRD v2 §Performance budget). No measurement step in v1.
 *
 * Privacy: the analyser is wired sink-only off the same MediaStream the VAD
 * consumes; nothing is connected to AudioContext.destination, so this never
 * monitors mic audio back to the speakers.
 *
 * The analyser may be null on the first frame after the user starts recording
 * because `createRecognition().start()` is async — we re-poll each rAF until
 * it appears, then latch.
 *
 * TODO(F3-followup): visual regression tooling
 *   (Playwright `toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`),
 *   Settings UI toggle for `levelMeterEnabled`,
 *   permission-revoked detection via `track.onended`,
 *   benchmark step measuring CPU under fixture playback.
 */
export function MicLevelMeter() {
  const isRecording = useVoice((s) => s.isRecording)
  const enabled = useVoice((s) => s.levelMeterEnabled)
  // displayLevel is the cosmetic-curve width [0, 1]; rawLevel is the raw RMS
  // [0, 1] used for colour thresholds and aria-valuenow. We intentionally keep
  // both off the global voice store (per PRD v2 §Stores) so we don't wake
  // useVoice subscribers 60×/s. Local component state is enough for v1.
  const [displayLevel, setDisplayLevel] = useState(0)
  const [rawLevel, setRawLevel] = useState(0)
  // Mirror rawLevel in a ref so the aria 4 Hz throttle can read it without
  // putting `rawLevel` in the rAF effect's deps — that would re-run the
  // effect on every setRawLevel and trigger React #185 (max update depth).
  const rawLevelRef = useRef(0)
  rawLevelRef.current = rawLevel
  // aria-valuenow is sampled separately at 4 Hz so screen readers don't
  // announce every frame (60 Hz × the value-change rate is unusable).
  const [ariaValue, setAriaValue] = useState(0)
  const [clipFlash, setClipFlash] = useState(false)
  const clipFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isRecording || !enabled) {
      setDisplayLevel(0)
      setRawLevel(0)
      return
    }

    let raf = 0
    let cancelled = false
    // Allocated lazily once we see a non-null analyser, then reused — avoids
    // a 2 KB alloc/GC every frame.
    // Backed by an explicit ArrayBuffer (not ArrayBufferLike) so the type
    // matches AnalyserNode.getByteTimeDomainData's signature in lib.dom.d.ts.
    let buf: Uint8Array<ArrayBuffer> | null = null
    let latchedAnalyser: AnalyserNode | null = null

    const tick = () => {
      if (cancelled) return
      const analyser = latchedAnalyser ?? getActiveAnalyser()
      if (!analyser) {
        // Pre-start: handle created async. Poll next frame.
        raf = requestAnimationFrame(tick)
        return
      }
      if (latchedAnalyser !== analyser) {
        latchedAnalyser = analyser
        buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      }
      const sampleBuf = buf!
      // Time-domain bytes are centred at 128; RMS over (v - 128) / 128 gives
      // a unit-scale [0, 1] level. O(n) over fftSize=2048 per frame.
      analyser.getByteTimeDomainData(sampleBuf)
      let sumSq = 0
      for (let i = 0; i < sampleBuf.length; i++) {
        const v = sampleBuf[i] - 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / sampleBuf.length) / 128
      // dBFS mapping: raw RMS → 20*log10(rms) clamped to [-60, 0] dBFS, then
      // normalized to [0, 1]. Replaces the old `pow(rms, 0.4)*1.2` curve
      // which saturated at raw ≈ 0.58 (F3 impl critique). Result is a
      // perceptually-linear bar across normal speech levels.
      const dbfs = rms > 0 ? 20 * Math.log10(rms) : -60
      const display = Math.max(0, Math.min(1, (dbfs + 60) / 60))
      setRawLevel(rms)
      setDisplayLevel(display)
      if (rms >= 0.95) {
        setClipFlash(true)
        if (clipFlashTimer.current) clearTimeout(clipFlashTimer.current)
        clipFlashTimer.current = setTimeout(() => setClipFlash(false), 150)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    // 4 Hz aria-valuenow throttle — screen readers re-announce on every value
    // change, so a 60 Hz update floods the accessibility tree. Reads via the
    // ref so the effect doesn't need rawLevel in its deps.
    const ariaInterval = setInterval(() => {
      if (cancelled) return
      setAriaValue(Math.round(rawLevelRef.current * 100))
    }, 250)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearInterval(ariaInterval)
      if (clipFlashTimer.current) {
        clearTimeout(clipFlashTimer.current)
        clipFlashTimer.current = null
      }
    }
  }, [isRecording, enabled])

  if (!isRecording || !enabled) return null

  // Colour thresholds operate on raw RMS (PRD v2 §Threshold space): the
  // cosmetic curve is render-only and must never feed back into level logic.
  const barColor = clipFlash
    ? 'bg-red-500'
    : rawLevel >= 0.7
      ? 'bg-amber-400'
      : 'bg-green-500'

  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      aria-valuenow={ariaValue}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid="mic-level-meter"
      className={`mx-3 mb-2 h-1 rounded bg-bg overflow-hidden ${
        clipFlash ? 'ring-1 ring-red-500' : ''
      }`}
    >
      <div
        className={`h-full ${barColor} transition-[width] duration-75 ease-out`}
        style={{ width: `${displayLevel * 100}%` }}
      />
    </div>
  )
}
