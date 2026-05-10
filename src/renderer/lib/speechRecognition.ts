/**
 * Local speech-to-text using Silero VAD + Moonshine (via Transformers.js).
 * No data leaves the machine — model runs offline after initial download.
 *
 * Flow: @ricky0123/vad-web owns the mic stream via an AudioWorklet, runs
 * Silero VAD on every frame, and fires onSpeechEnd with exactly the speech
 * segment as 16kHz mono Float32. We forward that to the Whisper/Moonshine
 * worker. No MediaRecorder, no decode/resample, no fixed chunk timer, no
 * silence ever reaches the model.
 */

import { MicVAD } from '@ricky0123/vad-web'
import { log } from './logger'

/**
 * F6 P0-2: status enum that the recognition emits to the host. Replaces the
 * v1 `onInterim(string)` channel that put status copy into `lastTranscript`.
 *   - 'transcribing': onSpeechEnd has fired; final encode is running
 *   - 'restarting':   F6 worker-death recovery in progress (kill+respawn)
 *   - 'idle':         segment ended (misfire or final delivered)
 * The 'listening' state is owned by the store via `onSpeechStart` and not
 * mirrored here, so the recognition layer never overwrites listening status.
 */
export type RecognitionStatus = 'transcribing' | 'restarting' | 'idle'

interface RecognitionCallbacks {
  /** F6 P0-2: replaces onInterim. Host maps to statusPill, not lastTranscript. */
  onStatusChange?: (status: RecognitionStatus) => void
  onFinal: (text: string) => void
  onError: (err: string) => void
  onSpeechStart?: () => void
  onMisfire?: () => void
  onModelStatus?: (status: string, message: string) => void
  onProgress?: (pct: number) => void
  /**
   * F6: provisional partial transcript text from a tail-window encode during
   * an active speech segment. Display-only — host MUST NOT call pty.write
   * from this callback. Cleared by the host on speechEnd / misfire.
   */
  onPartial?: (text: string) => void
  /**
   * F6 P1-7: live kill-switch read. The host returns the current
   * `partialsEnabled` boolean each tick so we can short-circuit scheduling
   * (no partial encodes when the user has disabled them). Lazy callback
   * because the store value can change while a segment is in flight.
   */
  partialsEnabled?: () => boolean
  /**
   * F5: pin the input device. `undefined`/`null` ⇒ OS default (no `deviceId`
   * constraint). When set, the constructed getUserMedia uses
   * `deviceId: { exact }`. Hard match (per F5 PRD v2 §Stream ownership);
   * the renderer is responsible for falling back to default when the device
   * is gone (uniqueness-checked label fallback in MicDevicePicker).
   */
  inputDeviceId?: string | null
}

// F8 — Semantic turn-detection constants. See docs/voice/prd/F8-turn-detection.v2.md.
//
// MVP NOTE: these are wired but not enforced; the actual smart-turn-v3 model
// is not loaded in v1. The pure-VAD endpointing path below remains
// unchanged. The decision rule is stubbed at the call-site marked
// `TODO(F8-followup): decideEndpoint()` further down in this file.
//
// TURN_DETECTOR_MIN_AUDIO_MS — cold-start floor. Below this much accumulated
// speech, the model is bypassed and pure-VAD wins. Rationale: short audio
// zero-pads to the encoder, which yields arbitrary `eot` values. Short
// commands ("stop", "yes") finalize correctly under VAD alone today.
//
// TURN_DETECTOR_TIMEOUT_MS — backpressure cap. If inference exceeds this,
// the call is abandoned, VAD's commit stands, telemetry emits
// `voice-turn.inference_timeout`. 250 ms matches the PRD §Backpressure rule.
export const TURN_DETECTOR_MIN_AUDIO_MS = 1500
export const TURN_DETECTOR_TIMEOUT_MS = 250

// F6 — Streaming partials constants. See docs/voice/prd/F6-streaming-partials.v2.md.
//
// Tail-window cap: partial encodes only ever see the last WINDOW_SECONDS of
// audio. Past t=WINDOW_SECONDS, encode cost is O(1) regardless of utterance
// length. Final still encodes the full vad-collected segment.
const SAMPLE_RATE = 16000
const WINDOW_SECONDS = 6
const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS // 96000
// First-partial gate: skip the first 400ms to dodge silence-prefix
// hallucinations on too-short audio.
const MIN_PARTIAL_AUDIO_MS = 400
const MIN_PARTIAL_AUDIO_SAMPLES = (SAMPLE_RATE * MIN_PARTIAL_AUDIO_MS) / 1000
// Self-paced cadence: target ~300ms between partial submissions, but only
// schedule when no partial is in flight (MAX_PARTIAL_BACKLOG = 1, structural).
const PARTIAL_INTERVAL_MS_DEFAULT = 300
const PARTIAL_INTERVAL_MS_CAP = 2000
// Hard wallclock caps: >1500ms doubles cadence; >3000ms disables for segment.
const PARTIAL_SLOWDOWN_MS = 1500
const PARTIAL_DISABLE_MS = 3000
// If the first partial encode exceeds this, the host is slow; bump interval.
const FIRST_PARTIAL_PROBE_THRESHOLD_MS = 600

export interface RecognitionHandle {
  start: () => Promise<void>
  stop: () => Promise<void>
  destroy: () => void
  /**
   * Live-mutate VAD speech thresholds. Used by F4 barge-in to "duck" the VAD
   * (raise positive threshold) while TTS is speaking, so self-talk into the
   * mic doesn't retrigger barge-in.
   */
  setVadThresholds: (positive: number, negative: number) => void
  /**
   * F3: read-only access to the AnalyserNode wired off the owned mic stream.
   * Returns null before start() resolves, after stop()/destroy(), or if the
   * level meter is disabled. The analyser is a sink-only branch — never
   * connected to AudioContext.destination, so no monitoring/playback occurs.
   */
  getAnalyser: () => AnalyserNode | null
}

const VAD_DEFAULT_POSITIVE = 0.5
const VAD_DEFAULT_NEGATIVE = 0.35
/** Raised thresholds while TTS is speaking; F4 barge-in uses these. */
export const VAD_DUCKED_POSITIVE = 0.85
export const VAD_DUCKED_NEGATIVE = 0.7

let sharedWorker: Worker | null = null
let modelReady = false
let modelLoading = false

// F6 P0-1 worker-death recovery: subscribers that want to be notified when the
// shared worker dies and is respawned (so they can re-attach `message`
// listeners to the new instance). Set-based so multiple in-flight handles can
// each re-bind. The worker reference returned by `getWorker()` after a
// respawn is the new instance; old listeners on the dead worker are gone.
type WorkerDeathListener = (info: { reason: string; respawned: boolean; finalOnly: boolean }) => void
const workerDeathListeners = new Set<WorkerDeathListener>()
function notifyWorkerDeath(info: { reason: string; respawned: boolean; finalOnly: boolean }) {
  for (const fn of Array.from(workerDeathListeners)) {
    try { fn(info) } catch (e: unknown) {
      log.warn('speech', 'workerDeath listener threw', { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

// F6 PRD §Worker death recovery: bounded respawn attempts; on twice-failed,
// disable speech recognition entirely. Reset on each successful load.
let workerRespawnCount = 0
const WORKER_RESPAWN_LIMIT = 2
let speechDisabled = false
// `finalOnlyMode` flips after a successful respawn; existing handles see this
// and stop scheduling partials for the rest of the session. Reset only on
// process restart — once we've had a fatal worker error, partials are
// considered untrustworthy until the user reloads.
let finalOnlyMode = false

function attachWorkerListeners(w: Worker) {
  // Permanent log forwarder.
  w.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'log') return
    const lvl = (e.data.level as 'debug' | 'info' | 'warn' | 'error') || 'info'
    log[lvl]('whisperWorker', e.data.message ?? '', e.data.meta)
  })
  // F6 P0-1: fatal worker errors trigger kill+respawn. ErrorEvent (uncaught
  // throw inside the worker) and `{type:'fatal'}` messages from the worker
  // both route through respawnWorker. Posted-back `{type:'error'}` for a
  // single transcribe failure is NOT fatal — it's handled per-message by
  // host-side onWorkerMessage (those reject the in-flight resolver).
  w.addEventListener('error', (e: ErrorEvent) => {
    log.error('whisperWorker', 'worker error event (fatal)', {
      message: e.message, filename: e.filename, lineno: e.lineno,
    })
    respawnWorker(`error:${e.message || 'unknown'}`)
  })
}

/** Lazy-init the worker + model. Reused across recording sessions. */
function getWorker(): Worker {
  if (sharedWorker) return sharedWorker
  sharedWorker = new Worker(
    new URL('./whisperWorker.ts', import.meta.url),
    { type: 'module' },
  )
  attachWorkerListeners(sharedWorker)
  log.info('speech', 'worker spawned')
  return sharedWorker
}

/**
 * F6 P0-1 worker-death recovery: tear down the dead worker, spawn a new one,
 * re-issue the load. On twice-failed respawn, set speechDisabled and stop.
 *
 * Side effects:
 *   - notifies all WorkerDeathListeners synchronously so handles can flip
 *     statusPill='restarting' and rebind their message listener
 *   - posts `{type:'load'}` on the new worker; the in-progress handle's
 *     onWorkerMessage will receive {status:'ready'} and resume
 *   - flips `finalOnlyMode = true` so partial scheduling halts session-wide
 *
 * Idempotent against concurrent fatal events: a second call while we're
 * still mid-respawn no-ops.
 */
let respawnInFlight = false
function respawnWorker(reason: string): void {
  if (speechDisabled) return
  if (respawnInFlight) {
    log.warn('speech', 'respawnWorker: already in flight, ignoring', { reason })
    return
  }
  respawnInFlight = true
  workerRespawnCount += 1
  finalOnlyMode = true
  log.warn('speech', 'respawnWorker: starting', { reason, attempt: workerRespawnCount })

  // Notify subscribers so they can flip statusPill and stop scheduling partials.
  notifyWorkerDeath({ reason, respawned: false, finalOnly: true })

  if (workerRespawnCount > WORKER_RESPAWN_LIMIT) {
    speechDisabled = true
    log.error('speech', 'respawnWorker: limit exceeded, disabling speech', { limit: WORKER_RESPAWN_LIMIT })
    if (sharedWorker) {
      try { sharedWorker.terminate() } catch { /* */ }
    }
    sharedWorker = null
    modelReady = false
    modelLoading = false
    notifyWorkerDeath({ reason: 'respawn-limit-exceeded', respawned: false, finalOnly: true })
    respawnInFlight = false
    return
  }

  // Terminate the dead worker, spin up a new one, re-load.
  if (sharedWorker) {
    try { sharedWorker.terminate() } catch { /* */ }
  }
  sharedWorker = null
  modelReady = false
  modelLoading = false

  try {
    sharedWorker = new Worker(
      new URL('./whisperWorker.ts', import.meta.url),
      { type: 'module' },
    )
    attachWorkerListeners(sharedWorker)
    modelLoading = true
    sharedWorker.postMessage({ type: 'load' })
    log.info('speech', 'respawnWorker: new worker spawned, load posted')
    // Fire post-respawn notification so handles can re-attach listeners.
    notifyWorkerDeath({ reason, respawned: true, finalOnly: true })
  } catch (e: unknown) {
    speechDisabled = true
    log.error('speech', 'respawnWorker: spawn failed, disabling speech', {
      error: e instanceof Error ? e.message : String(e),
    })
    notifyWorkerDeath({ reason: 'spawn-failed', respawned: false, finalOnly: true })
  } finally {
    respawnInFlight = false
  }
}

/** Test-only: reset the F6 respawn counters. Wired for unit tests. */
export function __resetWorkerDeathStateForTests(): void {
  workerRespawnCount = 0
  finalOnlyMode = false
  speechDisabled = false
  respawnInFlight = false
}

export function preloadModel(
  onStatus?: (status: string, msg: string) => void,
  onProgress?: (pct: number) => void,
): void {
  if (modelReady || modelLoading) return
  modelLoading = true
  const w = getWorker()
  log.info('speech', 'preloadModel: posting load')
  // The handler must self-detach on terminal status (ready/error). Without
  // this, every retry stacks another listener on the shared worker — the
  // user's callbacks fire N times and the closure leaks forever.
  const handler = (e: MessageEvent) => {
    if (e.data.type === 'status') {
      onStatus?.(e.data.status, e.data.message)
      if (e.data.status === 'ready') {
        modelReady = true
        modelLoading = false
        log.info('speech', 'preloadModel: ready')
        w.removeEventListener('message', handler)
      }
    } else if (e.data.type === 'progress') {
      onProgress?.(e.data.pct)
    } else if (e.data.type === 'error') {
      modelLoading = false
      log.error('speech', 'preloadModel: worker reported error', { error: e.data.error })
      onStatus?.('error', e.data.error)
      w.removeEventListener('message', handler)
    }
  }
  w.addEventListener('message', handler)
  w.postMessage({ type: 'load' })
}

/**
 * Clear the load-state flags so a subsequent preloadModel() re-posts {type:'load'}
 * to the existing worker. Used by the retry path on the gate's `error` /
 * `load-timeout` reasons. The worker itself is preserved; if the previous load
 * threw, the worker's transcriber is still null and load() runs from scratch.
 */
export function resetModel(): void {
  log.info('speech', 'resetModel: clearing load flags')
  modelReady = false
  modelLoading = false
}

export function isRecognitionSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioWorkletNode !== 'undefined'
  )
}

/**
 * F7: one-shot transcribe of an in-memory Float32 PCM buffer (16 kHz mono),
 * for the wizard's verify step. Bypasses VAD and the full RecognitionHandle
 * stack — we only need a single round-trip to the existing whisper worker.
 *
 * Resolves with the trimmed transcript, or rejects on worker error.
 *
 * Complexity: dominated by the worker's encoder (Moonshine ~150ms for short
 * utterances). Listener attached/removed per call so multiple in-flight
 * one-shot requests would race; the wizard only ever issues one at a time.
 */
export function transcribeOnce(audio: Float32Array): Promise<string> {
  const worker = getWorker()
  // Trigger lazy load if the model never warmed (e.g. unsupported env that
  // somehow reached the wizard, or a hard reload mid-flow).
  if (!modelReady && !modelLoading) {
    modelLoading = true
    worker.postMessage({ type: 'load' })
  }
  return new Promise<string>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'result') {
        worker.removeEventListener('message', handler)
        resolve(((e.data.text as string | undefined) ?? '').trim())
      } else if (e.data?.type === 'error') {
        worker.removeEventListener('message', handler)
        reject(new Error(String(e.data.error ?? 'Transcription failed')))
      } else if (e.data?.type === 'status' && e.data.status === 'ready') {
        modelReady = true
        modelLoading = false
      }
    }
    worker.addEventListener('message', handler)
    // Transfer the underlying buffer to avoid a copy. Caller must not reuse
    // `audio` after this call — same contract as the live VAD path.
    worker.postMessage({ type: 'transcribe', audio }, [audio.buffer])
  })
}

export function createRecognition(opts: RecognitionCallbacks): RecognitionHandle {
  // F6 P0-1: cache the worker by-ref locally so message-listener bookkeeping
  // is correct, but allow respawnWorker to swap the underlying instance via
  // the death listener below. `currentWorker` always points at the active
  // worker; postMessage targets it directly.
  let currentWorker = getWorker()
  let destroyed = false
  let vad: MicVAD | null = null
  // F5: we own the stream + AudioContext so the deviceId stays pinned
  // across MicVAD's pause/resume cycles. Stream is created once in start()
  // and torn down in stop()/destroy(). pauseStream/resumeStream return the
  // same instance so MicVAD never re-issues getUserMedia.
  let ownedStream: MediaStream | null = null
  let ownedAudioCtx: AudioContext | null = null
  // F3: AnalyserNode + its source node, both attached to ownedAudioCtx.
  // The source connects to the analyser only (no destination wiring) so the
  // mic is never monitored back to the speakers. Both refs cleared on stop.
  let analyserNode: AnalyserNode | null = null
  let analyserSource: MediaStreamAudioSourceNode | null = null

  // FIFO of resolvers for in-flight worker transcribe requests. The worker
  // processes messages serially and posts back in order, so shift() matches
  // results to requests. stop() awaits draining so the final utterance isn't
  // lost when destroy() removes the listener.
  const pendingResolvers: Array<() => void> = []
  const inFlight = new Set<Promise<void>>()

  // F6 — Streaming partials state. Per-handle, reset on each speech segment.
  //
  // Rolling tail buffer: a fixed-size Float32Array of WINDOW_SAMPLES (6s @ 16
  // kHz = 96000 samples). Frames written by MicVAD's `onFrameProcessed` are
  // appended; older samples drop off the front when the cap is exceeded.
  // Using a contiguous Float32Array (not a ring) so partial slices are simple
  // copies — for 6s of audio at 16kHz, the per-frame copy when shifting is
  // O(WINDOW_SAMPLES) but amortized cheap (96k floats every 32ms = ~3 MB/s
  // memcpy, negligible). Per CLAUDE.md complexity guidance.
  // NOTE(F6 known limitation): pre-roll splicing for `preSpeechPadMs` is
  // deferred. The first partial sees only post-VAD-trigger samples and may
  // miss the first 100-300ms of speech.
  // TODO(F6-followup): pre-roll splicing for preSpeechPadMs.
  let tailBuffer: Float32Array | null = null
  let tailLength = 0 // number of valid samples in tailBuffer
  let segmentActive = false
  let segmentStartedAt = 0 // performance.now() at onSpeechStart
  let partialInFlight = false
  let partialsDisabledForSegment = false
  let lastPartialScheduledAt = 0 // performance.now() of the last submission
  let partialSeq = 0 // monotonic per-handle, increments on every schedule
  let currentPartialSeq = 0 // most recent scheduled seq; results with lower seq are dropped
  let latestFinalSeq = -1
  let partialIntervalMs = PARTIAL_INTERVAL_MS_DEFAULT
  let partialEncodeStartMs = 0 // wallclock at the moment we posted; used for caps
  let partialScheduleTimer: ReturnType<typeof setTimeout> | null = null
  let prevPartialRaw = ''
  let stablePrefix = ''
  const LA2_ENABLED = true
  let firstPartialMeasured = false
  let segmentFirstPartialDeliveredAt = 0

  function longestCommonPrefix(a: string, b: string): number {
    // O(min(|a|, |b|))
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
    return i
  }

  function stabilizePartial(curr: string): string {
    if (!LA2_ENABLED) return curr
    const lcpLen = longestCommonPrefix(prevPartialRaw, curr)
    prevPartialRaw = curr
    if (lcpLen > stablePrefix.length) stablePrefix = curr.slice(0, lcpLen)
    if (stablePrefix.length > curr.length) stablePrefix = curr
    return stablePrefix
  }

  const ensureTailBuffer = (): Float32Array => {
    if (!tailBuffer) tailBuffer = new Float32Array(WINDOW_SAMPLES)
    return tailBuffer
  }

  const resetTail = () => {
    tailLength = 0
    // We don't zero the bytes — `tailLength` bounds reads.
  }

  /**
   * Append a frame to the rolling tail. If appending would exceed
   * WINDOW_SAMPLES, we shift the oldest samples out. Keeps tailLength clamped
   * at [0, WINDOW_SAMPLES].
   * Complexity: O(WINDOW_SAMPLES) on overflow due to copyWithin shift; O(frame.length)
   * otherwise. Fires every ~32ms (512 samples @ 16kHz) → fine.
   */
  const appendFrame = (frame: Float32Array) => {
    const buf = ensureTailBuffer()
    const flen = frame.length
    if (flen >= WINDOW_SAMPLES) {
      // Pathological: a single frame larger than the whole window. Take the tail.
      buf.set(frame.subarray(flen - WINDOW_SAMPLES))
      tailLength = WINDOW_SAMPLES
      return
    }
    if (tailLength + flen <= WINDOW_SAMPLES) {
      buf.set(frame, tailLength)
      tailLength += flen
      return
    }
    // Overflow: shift `flen` samples off the front, then append.
    const drop = (tailLength + flen) - WINDOW_SAMPLES
    buf.copyWithin(0, drop, tailLength)
    tailLength -= drop
    buf.set(frame, tailLength)
    tailLength += flen
  }

  const cancelPartialSchedule = () => {
    if (partialScheduleTimer) {
      clearTimeout(partialScheduleTimer)
      partialScheduleTimer = null
    }
  }

  const resetPartialState = () => {
    cancelPartialSchedule()
    segmentActive = false
    partialInFlight = false
    partialsDisabledForSegment = false
    partialIntervalMs = PARTIAL_INTERVAL_MS_DEFAULT
    prevPartialRaw = ''
    stablePrefix = ''
    firstPartialMeasured = false
    segmentFirstPartialDeliveredAt = 0
    resetTail()
  }

  const schedulePartialMaybe = () => {
    if (destroyed) return
    if (!segmentActive) return
    if (partialsDisabledForSegment) return
    if (partialInFlight) return
    if (partialScheduleTimer) return
    if (tailLength < MIN_PARTIAL_AUDIO_SAMPLES) {
      // Re-check after a short tick — frames are still arriving.
      partialScheduleTimer = setTimeout(() => {
        partialScheduleTimer = null
        schedulePartialMaybe()
      }, partialIntervalMs)
      return
    }
    const sinceLast = performance.now() - lastPartialScheduledAt
    if (sinceLast < partialIntervalMs && lastPartialScheduledAt !== 0) {
      partialScheduleTimer = setTimeout(() => {
        partialScheduleTimer = null
        schedulePartialMaybe()
      }, partialIntervalMs - sinceLast)
      return
    }

    // F6 P0-1 + P1-7: respect session-wide kill switches.
    //   - finalOnlyMode (after worker respawn): no partials for the rest of the session
    //   - speechDisabled (twice-failed respawn): no partials, no finals
    //   - partialsEnabled (user toggle): no partial encodes either
    if (finalOnlyMode || speechDisabled) return
    if (opts.partialsEnabled && !opts.partialsEnabled()) return

    // Submit. Take a copy of the tail; the worker call transfers the buffer
    // and we need the live tail to keep growing. tailLength is always
    // <= WINDOW_SAMPLES so this is bounded.
    const buf = ensureTailBuffer()
    const slice = new Float32Array(tailLength)
    slice.set(buf.subarray(0, tailLength))

    partialSeq += 1
    currentPartialSeq = partialSeq
    partialInFlight = true
    partialEncodeStartMs = performance.now()
    lastPartialScheduledAt = partialEncodeStartMs
    currentWorker.postMessage({ type: 'transcribe-partial', audio: slice, seq: partialSeq }, [slice.buffer])
  }

  const transcribeAudio = (audio: Float32Array): Promise<void> => {
    if (audio.length === 0) return Promise.resolve()
    if (speechDisabled) {
      // Twice-failed respawn: never reach the worker. Surface as an error so
      // the host shows a recognizable state and clears the recording ring.
      log.warn('speech', 'transcribeAudio: speech disabled (worker respawn limit hit)')
      if (!destroyed) opts.onError('Speech recognition disabled — please reload the app.')
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      pendingResolvers.push(resolve)
      // F6: tag the final with the next seq, used to gate stale partials.
      partialSeq += 1
      const seq = partialSeq
      latestFinalSeq = seq
      currentWorker.postMessage({ type: 'transcribe', audio, seq }, [audio.buffer])
    })
  }

  const spawnTranscribe = (audio: Float32Array): Promise<void> => {
    const chain = transcribeAudio(audio)
    inFlight.add(chain)
    chain.finally(() => { inFlight.delete(chain) })
    return chain
  }

  const onWorkerMessage = (e: MessageEvent) => {
    if (e.data.type === 'result') {
      const text = e.data.text as string
      // F6 P0-3: echoed seq from the worker. Logged when out-of-order so a
      // future regression in worker FIFO ordering is observable. We still
      // deliver the text — the seq is informational on `result`; dropping
      // the user's transcription would be a worse failure mode than
      // (theoretically) committing a stale one.
      const seq: number = e.data.seq ?? 0
      if (seq && seq < latestFinalSeq) {
        log.warn('speech', 'result: seq below latestFinalSeq (delivering anyway)', { seq, latestFinalSeq })
      }
      if (!destroyed && text) opts.onFinal(text)
      pendingResolvers.shift()?.()
    } else if (e.data.type === 'partial') {
      // F6: cancel-by-suppress. A partial result is delivered only if it is
      // the most-recently scheduled partial AND no final has superseded it.
      const seq: number = e.data.seq ?? 0
      const text: string = e.data.text ?? ''
      const elapsed = performance.now() - partialEncodeStartMs
      partialInFlight = false
      // Hard wallclock caps (PRD §Technical Design).
      if (elapsed >= PARTIAL_DISABLE_MS) {
        partialsDisabledForSegment = true
        log.warn('speech', 'partials.disabled.budget', { elapsedMs: Math.round(elapsed), seq })
      } else if (elapsed >= PARTIAL_SLOWDOWN_MS) {
        partialIntervalMs = Math.min(partialIntervalMs * 2, PARTIAL_INTERVAL_MS_CAP)
        log.warn('speech', 'partials.slowdown', { elapsedMs: Math.round(elapsed), newIntervalMs: partialIntervalMs, seq })
      }
      if (!firstPartialMeasured) {
        firstPartialMeasured = true
        if (elapsed > FIRST_PARTIAL_PROBE_THRESHOLD_MS && partialIntervalMs < 500) {
          partialIntervalMs = 500
          log.info('speech', 'partials.probe.slow_host', { elapsedMs: Math.round(elapsed), newIntervalMs: 500 })
        }
      }
      const stale = seq !== currentPartialSeq || seq <= latestFinalSeq
      if (!destroyed && !stale && text) {
        const stable = stabilizePartial(text)
        if (stable) {
          opts.onPartial?.(stable)
          if (segmentFirstPartialDeliveredAt === 0) {
            segmentFirstPartialDeliveredAt = performance.now()
            log.info('speech', 'partial.first', { msSinceSpeechStart: Math.round(segmentFirstPartialDeliveredAt - segmentStartedAt) })
          }
        }
      }
      // After result lands, schedule the next partial (self-paced).
      schedulePartialMaybe()
    } else if (e.data.type === 'partial-error') {
      // Non-fatal: drop and keep recording. Don't surface as opts.onError —
      // that path tears down the recognition.
      const elapsed = performance.now() - partialEncodeStartMs
      partialInFlight = false
      // F6 P1-2: caps check also runs on partial-error so a slow-and-then-
      // failed encode still flips the slowdown/disable tiers. Without this,
      // a worker that's so loaded it errors after >3s wouldn't trigger
      // partials.disabled.budget — and we'd keep hammering it.
      if (elapsed >= PARTIAL_DISABLE_MS) {
        partialsDisabledForSegment = true
        log.warn('speech', 'partials.disabled.budget (after error)', { elapsedMs: Math.round(elapsed), seq: e.data.seq })
      } else if (elapsed >= PARTIAL_SLOWDOWN_MS) {
        partialIntervalMs = Math.min(partialIntervalMs * 2, PARTIAL_INTERVAL_MS_CAP)
        log.warn('speech', 'partials.slowdown (after error)', { elapsedMs: Math.round(elapsed), newIntervalMs: partialIntervalMs, seq: e.data.seq })
      }
      log.warn('speech', 'partial encode failed', { error: e.data.error, seq: e.data.seq })
      schedulePartialMaybe()
    } else if (e.data.type === 'error') {
      if (!destroyed) opts.onError(e.data.error)
      pendingResolvers.shift()?.()
    } else if (e.data.type === 'status') {
      if (!destroyed) opts.onModelStatus?.(e.data.status, e.data.message)
      if (e.data.status === 'ready') {
        modelReady = true
        modelLoading = false
      }
    } else if (e.data.type === 'progress') {
      if (!destroyed) opts.onProgress?.(e.data.pct)
    }
  }

  currentWorker.addEventListener('message', onWorkerMessage)

  // F6 P0-1: when the shared worker dies and is respawned, our message
  // listener is gone (it was attached to the dead worker). Re-bind to the
  // new worker, surface 'restarting' status, and reject any in-flight
  // resolver so the host's stop() doesn't hang forever.
  const onWorkerDeath = (info: { reason: string; respawned: boolean; finalOnly: boolean }) => {
    if (destroyed) return
    log.warn('speech', 'createRecognition: worker death event', info)
    // Status surface: PRD §State — `'Speech model restarting…'`.
    opts.onStatusChange?.('restarting')
    // Drain any pending resolvers — they were tied to the dead worker's
    // result messages which will never arrive.
    while (pendingResolvers.length) {
      pendingResolvers.shift()?.()
    }
    inFlight.clear()
    // Reset partial scheduling state; finalOnlyMode (set by respawnWorker)
    // will block subsequent partial dispatches.
    cancelPartialSchedule()
    partialInFlight = false
    if (info.respawned) {
      // Detach from the dead worker first so its listener closure (which
      // retains pendingResolvers / inFlight) can be GC'd alongside the
      // terminated Worker object. Then bind to the fresh instance.
      try { currentWorker.removeEventListener('message', onWorkerMessage) } catch { /* */ }
      currentWorker = getWorker()
      currentWorker.addEventListener('message', onWorkerMessage)
    }
    // The store will flip statusPill based on opts.onStatusChange; clear
    // back to 'idle' once the new worker reports {status:'ready'} via the
    // existing onModelStatus path.
  }
  workerDeathListeners.add(onWorkerDeath)

  return {
    start: async () => {
      if (destroyed) return
      if (speechDisabled) {
        opts.onError('Speech recognition disabled — please reload the app.')
        return
      }
      if (!modelReady && !modelLoading) {
        modelLoading = true
        log.info('speech', 'createRecognition.start: triggering model load')
        currentWorker.postMessage({ type: 'load' })
      }
      log.info('speech', 'createRecognition.start: initializing VAD', { modelReady, modelLoading })

      try {
        // Self-host all VAD assets under /vad/ (see src/renderer/public/vad/)
        // so the defaults' jsDelivr CDN never gets hit — that breaks under
        // file:// in the packaged Electron app. Anchor on document.baseURI:
        // a relative './vad/' resolves against the importing JS chunk
        // (dist/assets/) in prod, missing the real dist/vad/ location.
        const vadBase = new URL('vad/', document.baseURI).href

        // F5 stream ownership: build the constraints ourselves so the
        // configured `inputDeviceId` (or OS default if null/undefined) is
        // honored. We do NOT force `sampleRate: 16000` on the AudioContext —
        // F3 critique flagged that as a behavior change risk; MicVAD
        // resamples internally.
        const pinId = opts.inputDeviceId || null
        const audioConstraints: MediaTrackConstraints = {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        }
        if (pinId) {
          // exact: getUserMedia rejects with OverconstrainedError if the
          // device is gone. The renderer surfaces the error and lets the
          // user pick a different device.
          ;(audioConstraints as MediaTrackConstraints & { deviceId?: ConstrainDOMString }).deviceId = { exact: pinId }
        }
        log.info('speech', 'getUserMedia', { hasDeviceId: !!pinId, deviceIdPrefix: pinId ? pinId.slice(0, 8) : null })
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        ownedStream = stream
        ownedAudioCtx = new AudioContext()

        // F3 critique: detect permission revoke / device unplug mid-recording.
        // The browser fires `ended` on each track. Without this, the mic
        // level meter silently parks at 0 forever and the user has no idea
        // why nothing is being transcribed.
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => {
            if (destroyed) return
            log.warn('speech', 'mic track ended (permission revoked or device removed)')
            opts.onError('Microphone disconnected or permission revoked')
          })
        }

        // F3 mic-level meter: wire an AnalyserNode off the owned stream before
        // MicVAD attaches its own worklet. fftSize=2048 gives a ~42 ms window
        // at 48 kHz; smoothingTimeConstant=0.8 matches Web Audio's default,
        // tuned smoother than the PRD v2 (0.3) so a render-side rAF doesn't
        // flash on every frame burst. The source feeds the analyser only —
        // we deliberately do NOT connect to ownedAudioCtx.destination, which
        // would loop the mic to the speakers.
        // Complexity: O(1) per-frame; analyser RMS is computed in C++ inside
        // the meter component's rAF, not here.
        try {
          analyserSource = ownedAudioCtx.createMediaStreamSource(ownedStream)
          analyserNode = ownedAudioCtx.createAnalyser()
          analyserNode.fftSize = 2048
          // 0.3 per F3 PRD v2 — bar feels responsive on speech onset; 0.8
          // (Web Audio default) was visibly laggy.
          analyserNode.smoothingTimeConstant = 0.3
          analyserSource.connect(analyserNode)
        } catch (e: unknown) {
          // Analyser init must never block recording. Log + null both refs so
          // getAnalyser() returns null and the meter component renders nothing.
          log.warn('speech', 'analyser init failed', { error: e instanceof Error ? e.message : String(e) })
          analyserSource = null
          analyserNode = null
        }

        vad = await MicVAD.new({
          audioContext: ownedAudioCtx,
          // Same stream across pause/resume so the device pin survives.
          // PRD v2: resumeStream MUST return the original stream — returning
          // a fresh getUserMedia would silently break the pin on first VAD
          // pause/resume cycle.
          getStream: async () => stream,
          resumeStream: async () => stream,
          // We keep the stream alive between pauses; MicVAD already gates
          // frame processing on its own listening flag.
          pauseStream: async () => { /* no-op: keep stream + tracks live */ },
          baseAssetPath: vadBase,
          onnxWASMBasePath: vadBase,
          model: 'v5',
          // Tuned for short voice commands: a small lead-in pad keeps the
          // first consonant; redemption keeps brief mid-word pauses from
          // chopping the segment. Click-to-stop also flushes the in-flight
          // utterance via submitUserSpeechOnPause.
          positiveSpeechThreshold: VAD_DEFAULT_POSITIVE,
          negativeSpeechThreshold: VAD_DEFAULT_NEGATIVE,
          minSpeechMs: 250,
          // 1200 ms (was 600) — VAD waits this long after the last in-speech
          // frame before committing a turn. 600 ms cut users off mid-sentence
          // when pausing to think; 1200 ms covers a normal "uh, …" hesitation
          // without a perceptible latency hit on the final commit.
          redemptionMs: 1200,
          preSpeechPadMs: 300,
          submitUserSpeechOnPause: true,
          // F6: capture every post-resample 512-sample frame from MicVAD into
          // the rolling tail buffer. Frames flow regardless of speech state;
          // the partial scheduler only fires while `segmentActive`. Per the
          // F6 PRD, `frame` is the post-resample 16 kHz Float32 — the same
          // domain the final encoder sees.
          onFrameProcessed: (_probabilities: unknown, frame: Float32Array) => {
            if (destroyed) return
            if (!segmentActive) return
            appendFrame(frame)
            schedulePartialMaybe()
          },
          onSpeechStart: () => {
            if (destroyed) return
            // F6 P0-2: 'listening' status is owned by the store via
            // onSpeechStart in voice.ts (it sets statusPill='listening' and
            // clears lastPartial). We deliberately don't echo it here.
            // F6: start a fresh partial-encoder segment. Buffer reset; cadence
            // restored to default; not-disabled. Partial scheduling kicks in
            // after the first frame plus the MIN_PARTIAL_AUDIO_MS gate.
            resetPartialState()
            segmentActive = true
            segmentStartedAt = performance.now()
            // Touch segmentStartedAt so the linter knows it's read; primary
            // use is for telemetry in F6-followup.
            void segmentStartedAt
            opts.onSpeechStart?.()
          },
          onSpeechEnd: (audio: Float32Array) => {
            if (destroyed) return
            opts.onStatusChange?.('transcribing')
            // F6: end the partial segment. Buffer cleared — final encode runs
            // through the existing path (full vad-collected audio).
            resetPartialState()

            // TODO(F8-followup): decideEndpoint() goes HERE.
            //
            // PRD F8 v2 §Decision rule (v1):
            //   if !modelReady:                                  use VAD-only
            //   if audioMs < TURN_DETECTOR_MIN_AUDIO_MS:         use VAD-only (cold-start floor)
            //   if vad_ended && eot >= 0.5:                     finalize now
            //   if vad_ended && eot <  0.5:                     extend redemption to MAX_REDEMPTION_MS, capped at 2 extensions
            //   otherwise:                                       keep listening
            //
            // For MVP, we always fall through to the VAD-only commit path.
            // The store is wired (turnDetectorState/Mode) and settings persist;
            // the worker exists; the constants are in scope — but no inference
            // is consulted, so behavior is identical to today.
            spawnTranscribe(audio)
          },
          onVADMisfire: () => {
            if (destroyed) return
            opts.onStatusChange?.('idle')
            // F6: clear partial state on misfire so a stale partial result
            // can't land after the segment is gone.
            resetPartialState()
            opts.onMisfire?.()
          },
        })
        vad.start()
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Microphone access denied'
        const stack = e instanceof Error ? e.stack : ''
        log.error('speech', 'createRecognition.start: VAD init failed', { error: msg, stack })
        // Tear down anything we may have allocated before the throw so we
        // don't leak a held mic / context across retries.
        if (analyserNode) {
          try { analyserNode.disconnect() } catch { /* */ }
          analyserNode = null
        }
        if (analyserSource) {
          try { analyserSource.disconnect() } catch { /* */ }
          analyserSource = null
        }
        if (ownedStream) {
          try { ownedStream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
          ownedStream = null
        }
        if (ownedAudioCtx) {
          try { await ownedAudioCtx.close() } catch { /* */ }
          ownedAudioCtx = null
        }
        opts.onError(msg)
      }
    },

    stop: async () => {
      // Teardown order (F5 PRD v2 §Stream ownership):
      //   1. vad.pause()    — stop emitting onSpeechEnd
      //   2. drain in-flight whisper transcribes
      //   3. vad.destroy()  — let the worklet drain its final frame
      //   4. audioContext.close()
      //   5. stream.getTracks().forEach(stop)
      // Stopping tracks before destroy can race the final frame.
      if (vad) {
        try { await vad.pause() } catch { /* */ }
      }
      // F6: cancel any pending partial-encoder schedule timer so the timeout
      // can't fire after teardown and leak a worker postMessage.
      resetPartialState()
      // Drain any in-flight transcriptions before the listener is torn down.
      while (inFlight.size > 0) {
        await Promise.all(Array.from(inFlight))
      }
      if (vad) {
        try { await vad.destroy() } catch { /* */ }
        vad = null
      }
      // F3 teardown order: analyser/source disconnect AFTER vad.destroy()
      // (worklet drained) but BEFORE audioContext.close(). Closing the
      // context before disconnects throws InvalidStateError on some Chromium
      // builds; tracks stop after disconnects so they can't race with worklet
      // teardown.
      if (analyserNode) {
        try { analyserNode.disconnect() } catch { /* */ }
        analyserNode = null
      }
      if (analyserSource) {
        try { analyserSource.disconnect() } catch { /* */ }
        analyserSource = null
      }
      // Stop tracks before closing the AudioContext: closing first leaves
      // the OS-level mic indicator on briefly until the GC drops the source
      // node. Stopping tracks releases the indicator immediately.
      if (ownedStream) {
        try { ownedStream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
        ownedStream = null
      }
      if (ownedAudioCtx) {
        try { await ownedAudioCtx.close() } catch { /* */ }
        ownedAudioCtx = null
      }
    },

    setVadThresholds: (positive: number, negative: number) => {
      if (!vad) return
      try {
        vad.setOptions({
          positiveSpeechThreshold: positive,
          negativeSpeechThreshold: negative,
        })
      } catch (e: unknown) {
        log.warn('speech', 'setVadThresholds failed', { error: e instanceof Error ? e.message : String(e) })
      }
    },

    getAnalyser: () => analyserNode,

    destroy: () => {
      destroyed = true
      // F6: kill any pending schedule timer first so it can't fire mid-teardown.
      resetPartialState()
      if (vad) {
        // Best-effort sync destroy; the awaited path runs through stop().
        try { vad.destroy() } catch { /* */ }
        vad = null
      }
      // Safety net: close the AudioContext + stop tracks if destroy() was
      // called without stop() (unusual path; stopRecording always awaits
      // stop() first). Ignore errors — these are idempotent on close.
      if (analyserNode) {
        try { analyserNode.disconnect() } catch { /* */ }
        analyserNode = null
      }
      if (analyserSource) {
        try { analyserSource.disconnect() } catch { /* */ }
        analyserSource = null
      }
      if (ownedAudioCtx) {
        try { ownedAudioCtx.close() } catch { /* */ }
        ownedAudioCtx = null
      }
      if (ownedStream) {
        try { ownedStream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
        ownedStream = null
      }
      // F6 P0-1: detach the worker-death subscription and the message
      // listener from the *current* worker. After a respawn, currentWorker
      // points at the new instance — that's the right one to clean up.
      workerDeathListeners.delete(onWorkerDeath)
      currentWorker.removeEventListener('message', onWorkerMessage)
    },
  } as RecognitionHandle
}
