import { create } from 'zustand'
import {
  createRecognition,
  isRecognitionSupported,
  preloadModel,
  resetModel,
  type RecognitionHandle,
} from '../lib/speechRecognition'
import { stopSpeaking, isSpeaking, getSpeakStartedAt } from '../lib/speechSynthesis'
import { attachVadDucking } from '../lib/vadDucking'
import { log } from '../lib/logger'
import { matchVoiceCommand } from '../lib/voiceCommands'

export type GateReason =
  | 'ready'
  | 'idle'
  | 'loading'
  | 'error'
  | 'load-timeout'
  | 'permission-denied'
  | 'unsupported'

export type ErrorKind = 'load' | 'timeout' | 'recording' | null
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unknown'

/**
 * F8 — Semantic turn-detector state. MVP framing: 'disabled' is the default
 * because the model is NOT loaded in v1; the worker stub posts 'load_failed'
 * if/when init is attempted. The decision-rule call site is also stubbed —
 * see `TODO(F8-followup)` in speechRecognition.ts. None of these state values
 * change endpointing behavior in MVP; they're wired so the follow-up can drop
 * in the model with no further store migrations.
 *
 * Note: 'inference_timeout' is a per-call telemetry event, not a persistent
 * state — see PRD §Backpressure. It's logged from the inference loop without
 * flipping this enum, so a transient timeout doesn't lock subsequent calls out.
 */
export type TurnDetectorState =
  | 'disabled'
  | 'load_failed'
  | 'runtime_error'
  | 'ok'

export type TurnDetectorMode = 'audio' | 'text' | 'off'

/** F1 hotkey state machine — single source of truth in this store. */
export type HotkeyState =
  | 'idle'
  | 'armed'
  | 'recording'
  | 'stopping'
  | 'error'
  | 'aborted'
  | 'destroyed'

export type HotkeyMode = 'hold' | 'toggle'

interface VoiceState {
  isRecording: boolean
  ttsEnabled: boolean
  /**
   * When true (default), each `onFinal` arms a `submitDelayMs` timer that
   * writes `\r` to the PTY and stops the mic. Resets on every new onFinal.
   * When false, text is written but the user must press Enter manually
   * (legacy "autoSend off" behavior, but without the embedded `\n`).
   */
  autoSubmit: boolean
  /** ms after the last onFinal before auto-submit + mic-close fires. */
  submitDelayMs: number
  /** performance.now() when the current submit countdown began. null = not armed. */
  submitCountdownStartAt: number | null
  lastTranscript: string
  /**
   * F6 — Streaming partials: provisional, **display-only** transcript text
   * from the in-flight tail-window encoder. Cleared on speechEnd / misfire /
   * stopRecording. NEVER causes a pty.write — see invariant comment in
   * startRecording.
   */
  lastPartial: string
  /**
   * F6: separated status indicator. Replaces v1's onInterim overwrites of
   * lastTranscript so the committed final and provisional partial render in
   * independent slots.
   *
   * NOTE: this F6 MVP does not yet render statusPill in the UI; it's kept as
   * a slice so a follow-up render lands without another store migration.
   * `truncated` corresponds to the >30s monologue case.
   */
  statusPill: 'idle' | 'listening' | 'transcribing' | 'truncated' | 'restarting'
  /**
   * F6: kill switch. When false, partial messages from the worker are still
   * posted but the host discards them (does not write to lastPartial). The
   * encoder still runs (CPU isn't saved); this is the simplest user-facing
   * disable. Default true.
   * TODO(F6-followup): also gate scheduling so the encoder stops running.
   */
  partialsEnabled: boolean
  error: string | null
  errorKind: ErrorKind
  modelStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** 0-100 model download progress; 100 also means warmup may still be running. */
  loadingProgress: number
  permissionState: PermissionState
  /**
   * Timestamp (performance.now()) of the last barge-in. F4 uses this as a
   * 1500ms TTL to suppress streamed `speak()` chunks that arrive after the
   * user cut off TTS. `null` means no recent barge-in.
   */
  lastBargeInAt: number | null

  /** F1 hotkey state machine. */
  hotkeyState: HotkeyState

  /**
   * F3 mic-level meter feature flag. When false, <MicLevelMeter /> renders
   * nothing even while recording. The analyser itself is always wired in
   * speechRecognition.ts (v1 cut); flipping this is a render-only kill switch.
   * TODO(F3-followup): gate analyser construction in speechRecognition.ts on
   * this flag too, plus surface a Settings UI toggle and an env override
   * (SM_VOICE_LEVEL_METER) per F3 PRD v2 §Feature flag.
   */
  levelMeterEnabled: boolean

  /**
   * F8 — Semantic turn-detection store slice. MVP: persisted, settable, and
   * read on mount, but never consulted by the endpointing path in v1.
   *
   * `turnDetectorState` is a finite enum tracking the runtime health of the
   * worker: `'disabled'` (default — mode === 'off'), `'load_failed'` (worker
   * init posted load_failed), `'runtime_error'` (worker threw mid-inference),
   * `'inference_timeout'` (250 ms hard timeout breach — see PRD §Backpressure),
   * `'ok'` (would be set after a successful warmup; never reached in MVP).
   *
   * `turnDetectorMode` mirrors voice.json's `turnDetector.mode`. 'off' is the
   * safe default — pure-VAD path. 'audio' = smart-turn-v3 (planned, follow-up).
   * 'text' = rejected on license per PRD §Alternatives (Rejected).
   *
   */
  turnDetectorState: TurnDetectorState
  turnDetectorMode: TurnDetectorMode

  /**
   * F7 first-run wizard flags.
   *
   * `wizardArmed` — set true at boot when persisted state shows the wizard
   * hasn't been completed under the current schema (and we're not in E2E).
   * `wizardOpen` — set true while the modal is on screen. The mic button
   * checks `wizardArmed && !wizardOpen` and opens the wizard instead of
   * starting recording on the first click.
   */
  wizardArmed: boolean
  wizardOpen: boolean

  startRecording: (tabId: string) => void
  stopRecording: () => void
  toggleTTS: () => void
  setAutoSubmit: (v: boolean) => void
  setSubmitDelayMs: (ms: number) => void
  /** Cancel an armed submit countdown (e.g. user typed manually). */
  cancelSubmit: () => void
  /** F6: kill-switch setter. */
  setPartialsEnabled: (v: boolean) => void
  clearError: () => void
  initModel: () => void
  resetAndRetryModel: () => void
  setPermissionState: (p: PermissionState) => void
  setLevelMeterEnabled: (v: boolean) => void

  /**
   * F8 — Set the turn-detector mode and persist via IPC. Setting to 'off'
   * emits `voice-turn.disabled-by-user`; any other mode emits `voice-turn.enabled`.
   * MVP: also flips `turnDetectorState` to 'disabled' on 'off' so the
   * decision-rule call site (TODO in speechRecognition.ts) sees a consistent
   * snapshot. Persistence is fire-and-forget; failures log warn.
   */
  /** Internal setter for the runtime state enum (App.tsx mount hook only). */
  setTurnDetectorRuntimeState: (s: TurnDetectorState) => void

  /** F7: arm/disarm and open/close the first-run wizard modal. */
  setWizardArmed: (v: boolean) => void
  openWizard: () => void
  closeWizard: () => void

  /** F1 push-to-talk: handle a hotkey phase event from main. */
  armHotkey: (event: { phase: 'down' | 'up'; source: 'window' | 'global'; mode: HotkeyMode; tabId: string | null }) => void
  /** F1 lifecycle: when the window is destroyed mid-recording. */
  destroyHotkey: () => void
  /**
   * F5: stop the current recording (if any), wait for the previous handle to
   * fully drain (no polling), then start a new recording on the same tab.
   * The new handle reads the latest persisted deviceId via startRecording.
   * Used by MicDevicePicker on selection change. Returns a promise so callers
   * can chain UI feedback. O(1) IPC + one drain.
   */
  restartWithDevice: () => Promise<void>
}

/**
 * Auto-stop after this many ms of no VAD speech activity. Reset on every
 * `onSpeechStart`; armed on segment end (`onFinal` / `onMisfire`) and on
 * `startRecording` so a totally-silent user still auto-closes.
 *
 * 40 s (was 30 s) so a long thinking pause between dictated turns doesn't
 * close the mic — user keeps a continuous-listening session and only loses
 * the mic if they truly walk away.
 */
const IDLE_AUTO_STOP_MS = 40_000
let idleAutoStopTimer: ReturnType<typeof setTimeout> | null = null

function armIdleAutoStop() {
  if (idleAutoStopTimer) clearTimeout(idleAutoStopTimer)
  idleAutoStopTimer = setTimeout(() => {
    idleAutoStopTimer = null
    useVoice.getState().stopRecording()
  }, IDLE_AUTO_STOP_MS)
}

function cancelIdleAutoStop() {
  if (idleAutoStopTimer) {
    clearTimeout(idleAutoStopTimer)
    idleAutoStopTimer = null
  }
}

/**
 * Auto-submit timer: armed after each `onFinal` types text. Fires `\r` to
 * the PTY and re-arms the idle auto-stop, but does NOT close the mic — the
 * session stays in continuous-listening mode across turns. Reset on
 * subsequent `onFinal` / `onSpeechStart` (user is still talking). Cancelled
 * on stopRecording / destroyHotkey.
 *
 * Separate from IDLE_AUTO_STOP_MS — that timer runs even with no speech;
 * this one only arms after a transcript has been typed.
 */
let submitTimer: ReturnType<typeof setTimeout> | null = null
let submitGuardRaf: number | null = null

/**
 * Typical mic noise floor with EC/AGC (existing constraint chain): RMS 0.005-0.015.
 * Speech onset: RMS 0.05-0.20. 0.04 is conservative — false positives only on loud
 * transients (keyboard, chair) that VAD would confirm within ~200 ms anyway.
 *
 * NOTE: this RMS guard is the fallback. The primary signal is the VAD frame
 * probability (lastVoiceProb below), which is far more reliable on quiet mics
 * and AGC-flattened streams where speech can sit below 0.04 RMS.
 */
const SUBMIT_PRECEDENCE_RMS = 0.04

/**
 * Per-frame VAD probability threshold for preempting the auto-submit
 * countdown. Set well below VAD's segment-commit threshold (positiveSpeechThreshold=0.5)
 * so even soft "wait" / "hold on" cancels the cooldown before VAD's 300ms
 * minSpeechMs gate would let `onSpeechStart` fire. Silero typically reports
 * 0.05-0.15 for background and 0.5+ for clear speech; 0.3 covers voiced
 * onsets without false-tripping on typing/breath.
 */
const SUBMIT_PRECEDENCE_PROB = 0.3

// Updated on every VAD frame (~32ms) via the onFrame callback below. The
// submit guard reads it each rAF tick. Stale data is OK — frames fire faster
// than the guard polls.
let lastVoiceProb = 0
let lastVoiceProbAt = 0

function startSubmitGuard(countdownStartAt: number) {
  if (submitGuardRaf !== null) cancelAnimationFrame(submitGuardRaf)

  const tick = () => {
    // Timer ended naturally or was already cancelled — stop the guard.
    if (submitTimer === null || useVoice.getState().submitCountdownStartAt === null) {
      submitGuardRaf = null
      return
    }
    const now = performance.now()
    // Primary signal: VAD per-frame probability. Considered fresh if the most
    // recent frame fired within 200ms (frames are ~32ms apart; 200ms means
    // we'd catch a stalled VAD pump and fall back to the RMS check below).
    if (now - lastVoiceProbAt < 200 && lastVoiceProb > SUBMIT_PRECEDENCE_PROB) {
      const msIntoCountdown = now - countdownStartAt
      log.info('voice', 'submit.preempted_by_voice', { reason: 'vad', prob: lastVoiceProb.toFixed(2), msIntoCountdown: Math.round(msIntoCountdown) })
      cancelSubmitInternal()
      armIdleAutoStop()
      return
    }
    // Fallback: RMS amplitude check. Catches loud transients VAD might miss
    // and covers the case where the onFrame pump is stalled.
    const analyser = getActiveAnalyser()
    if (analyser) {
      const buf = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(buf)
      // Mirror MicLevelMeter.tsx RMS math: samples are unsigned [0,255], center at 128.
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const s = (buf[i] - 128) / 128
        sum += s * s
      }
      const rms = Math.sqrt(sum / buf.length)
      if (rms > SUBMIT_PRECEDENCE_RMS) {
        const msIntoCountdown = now - countdownStartAt
        log.info('voice', 'submit.preempted_by_voice', { reason: 'rms', rms: rms.toFixed(3), msIntoCountdown: Math.round(msIntoCountdown) })
        cancelSubmitInternal()
        armIdleAutoStop()
        return
      }
    }
    submitGuardRaf = requestAnimationFrame(tick)
  }

  submitGuardRaf = requestAnimationFrame(tick)
}

function armSubmit(tabId: string) {
  if (submitTimer) clearTimeout(submitTimer)
  const delayMs = useVoice.getState().submitDelayMs
  const countdownStartAt = performance.now()
  useVoice.setState({ submitCountdownStartAt: countdownStartAt })
  submitTimer = setTimeout(() => {
    submitTimer = null
    useVoice.setState({ submitCountdownStartAt: null })
    try {
      window.api.pty.write({ tabId, data: '\r' })
    } catch (e: unknown) {
      log.warn('voice', 'submit pty.write failed', { error: e instanceof Error ? e.message : String(e) })
    }
    // Continuous listening: keep the mic open across turns. The user closes
    // it explicitly via hotkey/button; if they truly walk away, the idle
    // auto-stop (re-armed here) catches it after IDLE_AUTO_STOP_MS.
    armIdleAutoStop()
  }, delayMs)
  startSubmitGuard(countdownStartAt)
}

function cancelSubmitInternal() {
  if (submitGuardRaf !== null) {
    cancelAnimationFrame(submitGuardRaf)
    submitGuardRaf = null
  }
  if (submitTimer) {
    clearTimeout(submitTimer)
    submitTimer = null
  }
  if (useVoice.getState().submitCountdownStartAt !== null) {
    useVoice.setState({ submitCountdownStartAt: null })
  }
}

let activeHandle: RecognitionHandle | null = null
let detachVadDucking: (() => void) | null = null

/**
 * F3: read-only getter for <MicLevelMeter />. Returns the active recognition
 * handle's AnalyserNode, or null if no recording is in flight (or the handle
 * was created before getAnalyser() landed). Callers should treat null as a
 * transient pre-start state and re-poll on the next rAF, since the handle is
 * built asynchronously after startRecording() is called.
 *
 * Complexity: O(1).
 */
export function getActiveAnalyser(): AnalyserNode | null {
  return activeHandle?.getAnalyser?.() ?? null
}

// F1 drain watchdog: when transitioning to `stopping`, set a 10s timer; if
// we are still not back to `idle` when it fires, transition to `aborted`
// and log `drain-timeout` (PRD F1 v2 §State machine).
const DRAIN_TIMEOUT_MS = 10_000
let drainWatchdog: ReturnType<typeof setTimeout> | null = null

function clearDrainWatchdog() {
  if (drainWatchdog) {
    clearTimeout(drainWatchdog)
    drainWatchdog = null
  }
}

// F1 armed→recording auto-promotion: when the user pressed the hotkey while
// the model was loading, we recorded their intent in `armedContext`. When
// modelStatus flips to ready (set inside initModel's preloadModel callback),
// armHotkey checks this and transitions armed → recording on their behalf.
// The unsubscribe runs on every armHotkey transition out of `armed` so we
// never auto-start after the user has released the key.
type ArmedContext = { tabId: string | null; source: 'window' | 'global'; mode: HotkeyMode }
let armedContext: ArmedContext | null = null
let armedUnsubscribe: (() => void) | null = null

function clearArmedContext() {
  armedContext = null
  if (armedUnsubscribe) {
    armedUnsubscribe()
    armedUnsubscribe = null
  }
}

/** TTL window during which streamed speak() calls after a barge-in are dropped. */
export const BARGE_IN_TTL_MS = 1500

// 90s with no progress event indicates the load is wedged. Tripped to error
// with errorKind='timeout' so the gate can surface a distinct retry copy.
// The watchdog is per-initModel-invocation: each call increments
// `loadGeneration` and only callbacks tagged with that generation can arm
// or trip its timer. This isolates concurrent retries / HMR remounts.
const NO_PROGRESS_TIMEOUT_MS = 90_000
let loadGeneration = 0
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let watchdogGen = -1

function clearWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
    watchdogGen = -1
  }
}

// Documented ASR hallucinations on silent/near-silent input. VAD now gates
// out most silence upstream, but keep this as a backstop for edge cases.
const ASR_HALLUCINATIONS = new Set([
  'you',
  'You',
  'Thank you.',
  'Thanks for watching.',
  'Thanks for watching!',
  'Thank you for watching.',
  'Thank you for watching!',
  '.',
  'Bye.',
  'Bye!',
])

export const useVoice = create<VoiceState>((set, get) => ({
  isRecording: false,
  ttsEnabled: false,
  autoSubmit: true,
  submitDelayMs: 8000,
  submitCountdownStartAt: null,
  lastTranscript: '',
  lastPartial: '',
  statusPill: 'idle',
  partialsEnabled: true,
  error: null,
  errorKind: null,
  modelStatus: 'idle',
  loadingProgress: 0,
  permissionState: 'unknown',
  lastBargeInAt: null,
  hotkeyState: 'idle',
  levelMeterEnabled: true,
  // F8 MVP: model is not loaded in v1, so default state is 'disabled'. The
  // App.tsx mount hook reads voice.json and may flip mode without touching
  // turnDetectorState — that stays 'disabled' until a worker init runs in
  // a follow-up.
  turnDetectorState: 'disabled',
  turnDetectorMode: 'off',
  wizardArmed: false,
  wizardOpen: false,

  initModel: () => {
    if (get().modelStatus !== 'idle') return
    log.info('voice', 'initModel: kicking off preload')
    set({ modelStatus: 'loading', error: null, errorKind: null, loadingProgress: 0 })

    const myGen = ++loadGeneration
    const armWatchdog = () => {
      // Only the current generation can re-arm; stale callbacks from a prior
      // load that have not yet been GC'd are no-ops.
      if (myGen !== loadGeneration) return
      clearWatchdog()
      watchdogGen = myGen
      watchdogTimer = setTimeout(() => {
        if (watchdogGen !== myGen) return
        if (get().modelStatus !== 'loading') return
        log.warn('voice', 'mic.gate.timeout: no progress within 90s')
        set({ modelStatus: 'error', error: 'Model load timed out', errorKind: 'timeout' })
      }, NO_PROGRESS_TIMEOUT_MS)
    }
    armWatchdog()

    preloadModel(
      (status, msg) => {
        if (myGen !== loadGeneration) return
        if (status === 'ready') {
          clearWatchdog()
          log.info('voice', 'modelStatus -> ready')
          set({ modelStatus: 'ready', loadingProgress: 100, errorKind: null })
        } else if (status === 'error') {
          clearWatchdog()
          log.error('voice', 'modelStatus -> error', { msg })
          set({ modelStatus: 'error', error: msg, errorKind: 'load' })
        } else {
          // Cached pipeline init fires no progress events for 30-90s on slow
          // machines. The worker emits a `status: 'loading'` heartbeat every
          // 10s to compensate — treat it as a watchdog re-arm signal so the
          // 90s no-progress timer doesn't false-trip during cache loads.
          armWatchdog()
          set({ modelStatus: 'loading' })
        }
      },
      (pct) => {
        if (myGen !== loadGeneration) return
        armWatchdog()
        set({ loadingProgress: Math.round(pct) })
      },
    )
  },

  resetAndRetryModel: () => {
    log.info('voice', 'mic.gate.retry')
    clearWatchdog()
    resetModel()
    set({ modelStatus: 'idle', error: null, errorKind: null, loadingProgress: 0 })
    get().initModel()
  },

  startRecording: (tabId: string) => {
    if (get().isRecording) return
    // Defuse fast double-click during async stop-drain: stopRecording sets
    // isRecording=false synchronously but the prior handle drains async, and
    // detachVadDucking is also nulled there. activeHandle stays non-null
    // until the handle is destroyed; if we see one here, a stop is in flight.
    if (activeHandle) {
      log.warn('voice', 'startRecording: prior handle still draining, ignoring')
      return
    }
    if (!isRecognitionSupported()) {
      set({ error: 'Microphone or Web Worker not available', errorKind: 'recording' })
      return
    }

    // F5: read the persisted device pref before instantiating the recognition.
    // We optimistically flip isRecording=true now so the UI shows the ring
    // immediately; if the lookup fails we recover by passing null (= default).
    // O(1); single IPC round-trip.
    const buildHandle = (deviceId: string | null) => {
    try {
      // F6 INVARIANT: never auto-send from a partial.
      //
      // The `onPartial` callback below writes ONLY to `lastPartial`. The
      // existing `onFinal` callback (further down in this object) is the
      // ONLY path that calls `window.api.pty.write`. If you add a new
      // partial-driven side effect, it MUST NOT touch pty.write — that
      // would break the contract that finals are authoritative and partials
      // are advisory display-only (PRD F6 §Scope, §Edge Cases #6).
      const handle = createRecognition({
        inputDeviceId: deviceId,
        // F6 P0-2: status strings flow to statusPill, never lastTranscript.
        // Map the recognition's status enum to the store's statusPill union;
        // unmapped values become 'idle' so the LeftNav RecordingStatus
        // fallback ('Listening…') covers gaps.
        onStatusChange: (status) => {
          if (status === 'transcribing') set({ statusPill: 'transcribing' })
          else if (status === 'restarting') set({ statusPill: 'restarting' })
          else set({ statusPill: 'idle' })
        },
        onPartial: (text) => {
          // F6: kill switch. When disabled, drop on the floor; the encoder
          // still ran in the worker but the user sees no provisional text.
          if (!get().partialsEnabled) return
          set({ lastPartial: text })
        },
        // F6 P1-7: gate partial scheduling at the source so the encoder
        // stops running when the user disables partials. Returns the
        // current value via getState so the host re-checks each tick.
        partialsEnabled: () => get().partialsEnabled,
        // Per-frame VAD probability. Cached for the submit-guard rAF tick so
        // the cooldown cancels on the first voiced frame instead of waiting
        // for VAD's 300ms minSpeechMs gate to fire onSpeechStart.
        onFrame: (probs) => {
          lastVoiceProb = probs.isSpeech
          lastVoiceProbAt = performance.now()
        },
        // F4 barge-in: VAD-confirmed speech start cancels any in-progress TTS.
        // tabId is captured here in the closure so multi-tab telemetry is correct.
        onSpeechStart: () => {
          // F6: entering an active speech segment. Status flips to listening;
          // lastPartial cleared so the previous segment's text doesn't bleed.
          set({ statusPill: 'listening', lastPartial: '' })
          cancelIdleAutoStop()
          // User is talking again — defer auto-submit until they pause again.
          cancelSubmitInternal()
          const ttsWasSpeaking = isSpeaking()
          if (ttsWasSpeaking) {
            const startedAt = getSpeakStartedAt()
            const utteranceOffsetMs = startedAt !== null ? performance.now() - startedAt : null
            stopSpeaking()
            set({ lastBargeInAt: performance.now() })
            log.info('voice', 'barge-in', { tabId, utteranceOffsetMs })
          } else {
            log.debug('voice', 'barge-in.no-op', { tabId })
          }
        },
        // If a VAD misfire follows a barge-in within 600ms, the cancellation
        // was almost certainly spurious. We can't un-cancel TTS but we log
        // so we can tune the threshold over time.
        onMisfire: () => {
          // F6: VAD misfire — clear the provisional partial. lastTranscript
          // (committed) is untouched.
          set({ lastPartial: '', statusPill: 'idle' })
          armIdleAutoStop()
          const last = get().lastBargeInAt
          if (last !== null && performance.now() - last < 600) {
            log.warn('voice', 'barge-in.misfire', { tabId, sinceBargeInMs: Math.round(performance.now() - last) })
          }
        },
        onFinal: (text) => {
          // F6: final landed. Clear the provisional partial; lastTranscript
          // is briefly set then cleared (existing behavior preserved).
          // The pty.write call below is the ONLY user-facing write path —
          // see the invariant comment above near `onPartial`.
          armIdleAutoStop()
          const trimmed = text.trim()
          if (!trimmed || ASR_HALLUCINATIONS.has(trimmed)) {
            set({ lastTranscript: '', lastPartial: '', statusPill: 'idle' })
            return
          }
          const cmd = matchVoiceCommand(trimmed)
          if (cmd) {
            log.info('voice', 'voice-command', { tabId, label: cmd.label, transcript: trimmed })
            window.api.pty.write({ tabId, data: cmd.data })
            set({ lastTranscript: '', lastPartial: '', statusPill: 'idle' })
            // Voice commands ARE the submission — no separate countdown needed.
            cancelSubmitInternal()
            const w = window as unknown as { __transcripts?: Array<{ tabId: string; text: string }> }
            if (w.__transcripts) {
              w.__transcripts.push({ tabId, text: trimmed })
              if (w.__transcripts.length > 500) w.__transcripts.shift()
            }
            return
          }
          window.api.pty.write({ tabId, data: trimmed })
          set({ lastTranscript: '', lastPartial: '', statusPill: 'idle' })
          // Auto-submit: arm the countdown. Fires Enter + closes mic at submitDelayMs.
          if (get().autoSubmit) armSubmit(tabId)
          const w = window as unknown as { __transcripts?: Array<{ tabId: string; text: string }> }
          if (w.__transcripts) {
            w.__transcripts.push({ tabId, text: trimmed })
            if (w.__transcripts.length > 500) w.__transcripts.shift()
          }
        },
        onError: (err) => {
          log.error('voice', 'recognition error', { err })
          set({ error: err, errorKind: 'recording', isRecording: false, lastPartial: '', statusPill: 'idle' })
          // Without this, an error mid-recording leaks a VAD-ducking
          // listener pair; the next startRecording would stack another.
          detachVadDucking?.()
          detachVadDucking = null
          cancelIdleAutoStop()
          activeHandle?.destroy()
          activeHandle = null
        },
        onModelStatus: (status) => {
          if (status === 'ready') set({ modelStatus: 'ready', loadingProgress: 100 })
          else if (status === 'loading') set({ modelStatus: 'loading' })
        },
        onProgress: (pct) => set({ loadingProgress: Math.round(pct) }),
      })

      activeHandle = handle
      // Set isRecording before start() resolves so the UI shows the recording
      // ring immediately. Ducking is attached inside the start chain so
      // setVadThresholds runs after MicVAD's worklet booted (otherwise the
      // first ~300-800ms of TTS plays without the VAD raised).
      set({ isRecording: true, error: null, lastTranscript: '', lastPartial: '', statusPill: 'listening' })
      // Cover the silent-user case: arm the auto-stop now so a session that
      // never sees a speech segment still closes after IDLE_AUTO_STOP_MS.
      armIdleAutoStop()
      handle
        .start()
        .then(() => {
          if (activeHandle !== handle) return // stopped before start resolved
          detachVadDucking?.()
          detachVadDucking = attachVadDucking(handle)
        })
        .catch((e: unknown) => {
          log.error('voice', 'handle.start() failed', { error: e instanceof Error ? e.message : String(e) })
        })
    } catch (e: unknown) {
      set({
        error: e instanceof Error ? e.message : 'Failed to start recording',
        errorKind: 'recording',
      })
    }
    }

    // Fire-and-forget IPC: read the persisted device pref then build the
    // recognition handle. If the IPC fails (e.g. preload not ready yet)
    // we fall back to OS default so the user can still record.
    Promise.resolve()
      .then(() => window.api?.voice?.getDevicePref?.() ?? Promise.resolve(null))
      .then((pref) => buildHandle(pref?.selectedDeviceId ?? null))
      .catch((e: unknown) => {
        log.warn('voice', 'getDevicePref failed; using default device', { error: e instanceof Error ? e.message : String(e) })
        buildHandle(null)
      })
  },

  stopRecording: () => {
    const handle = activeHandle
    if (!handle) return
    cancelIdleAutoStop()
    cancelSubmitInternal()
    lastVoiceProb = 0
    lastVoiceProbAt = 0
    detachVadDucking?.()
    detachVadDucking = null
    set({ isRecording: false, lastTranscript: '', lastPartial: '', statusPill: 'idle' })
    // Hold activeHandle non-null until the drain completes so a fast
    // double-click in startRecording sees it and bails.
    handle.stop().finally(() => {
      handle.destroy()
      if (activeHandle === handle) activeHandle = null
      // F1: if a hotkey-driven flow is in `stopping`, transition to `idle`
      // and clear the drain watchdog. Other paths (button click) stay in
      // their hotkeyState (which is `idle` already, this is a no-op).
      const hk = get().hotkeyState
      if (hk === 'stopping') {
        clearDrainWatchdog()
        set({ hotkeyState: 'idle' })
      }
    })
  },

  restartWithDevice: async () => {
    if (!get().isRecording) return
    const handle = activeHandle
    if (!handle) return
    // Inline stop+restart: chain directly off handle.stop() instead of going
    // through stopRecording (which fires-and-forgets via .finally and would
    // need a polling loop to observe completion). This makes the restart
    // race-free and respects "no sleep-loops" — we await the drain itself.
    cancelIdleAutoStop()
    detachVadDucking?.()
    detachVadDucking = null
    set({ isRecording: false, lastTranscript: '', lastPartial: '' })
    try {
      await handle.stop()
    } catch (e: unknown) {
      log.warn('voice', 'restartWithDevice: drain rejected', { error: e instanceof Error ? e.message : String(e) })
    }
    handle.destroy()
    if (activeHandle === handle) activeHandle = null
    const { useSessions } = await import('./sessions')
    const id = useSessions.getState().activeTabId
    if (id) get().startRecording(id)
  },

  toggleTTS: () => set((s) => ({ ttsEnabled: !s.ttsEnabled })),
  setAutoSubmit: (v) => set({ autoSubmit: v }),
  setSubmitDelayMs: (ms) => set({ submitDelayMs: Math.max(500, Math.min(13_000, Math.floor(ms))) }),
  cancelSubmit: () => cancelSubmitInternal(),
  setPartialsEnabled: (v) => {
    if (get().partialsEnabled === v) return
    set({ partialsEnabled: v })
    if (!v) set({ lastPartial: '' })
  },
  clearError: () => set({ error: null, errorKind: null }),
  setPermissionState: (p) => {
    if (get().permissionState === p) return
    log.info('voice', 'mic.gate.permission_changed', { from: get().permissionState, to: p })
    set({ permissionState: p })
  },
  setLevelMeterEnabled: (v) => {
    if (get().levelMeterEnabled === v) return
    set({ levelMeterEnabled: v })
  },

  setTurnDetectorRuntimeState: (s) => {
    if (get().turnDetectorState === s) return
    set({ turnDetectorState: s })
    if (s === 'load_failed') log.warn('voice-turn', 'voice-turn.load_failed')
    else if (s === 'runtime_error') log.warn('voice-turn', 'voice-turn.runtime_error')
    else if (s === 'disabled') log.info('voice-turn', 'voice-turn.fallback_to_vad')
  },

  setWizardArmed: (v) => {
    if (get().wizardArmed === v) return
    set({ wizardArmed: v })
  },
  openWizard: () => {
    if (get().wizardOpen) return
    set({ wizardOpen: true })
  },
  closeWizard: () => {
    if (!get().wizardOpen) return
    set({ wizardOpen: false })
  },

  /**
   * F1 hotkey state machine entry point. Called from App.tsx when main emits
   * voice:hotkey events. Branches on phase + mode + current hotkeyState.
   *
   * Complexity: O(1).
   */
  armHotkey: ({ phase, source, mode, tabId }) => {
    const s = get()
    const { canRecord, reason } = selectCanRecord(s)

    if (phase === 'down') {
      // F2 gate: error/load-timeout → trigger retry per VoiceButton's pattern.
      if (reason === 'error' || reason === 'load-timeout') {
        s.resetAndRetryModel()
        log.info('voice-hotkey', 'down.retry', { source, reason })
        return
      }
      // F2 gate short-circuit: if not allowed and not a retry case, log + bail.
      if (!canRecord && reason !== 'loading') {
        log.warn('voice-hotkey', 'miss-model-loading', { modelStatus: s.modelStatus, reason })
        return
      }

      // From `recording` (or any path where isRecording===true, e.g. button-
      // started flow): a second `down` in toggle mode stops; in hold mode
      // we ignore (the keyup will stop us). Global is forced toggle.
      if (s.hotkeyState === 'recording' || s.isRecording) {
        const effectiveToggle = mode === 'toggle' || source === 'global'
        if (effectiveToggle) {
          set({ hotkeyState: 'stopping' })
          clearDrainWatchdog()
          drainWatchdog = setTimeout(() => {
            if (get().hotkeyState === 'stopping') {
              log.warn('voice-hotkey', 'drain-timeout', { durationMs: DRAIN_TIMEOUT_MS })
              set({ hotkeyState: 'aborted' })
              // After aborted, drop to idle on next tick so the UI doesn't latch.
              setTimeout(() => {
                if (get().hotkeyState === 'aborted') set({ hotkeyState: 'idle' })
              }, 0)
            }
          }, DRAIN_TIMEOUT_MS)
          s.stopRecording()
        }
        return
      }

      // From `armed` or `idle`: model-loading path arms; ready path starts.
      if (reason === 'loading') {
        if (s.hotkeyState !== 'armed') {
          set({ hotkeyState: 'armed' })
          log.info('voice-hotkey', 'armed', { source, modelStatus: s.modelStatus })
        }
        // Capture intent so the auto-promotion in the modelStatus subscriber
        // knows which tab/source/mode to launch. Replace any prior armed
        // context so re-arming a different tab works.
        clearArmedContext()
        armedContext = { tabId, source, mode }
        armedUnsubscribe = useVoice.subscribe((curr, prev) => {
          // Fire only on the loading→ready transition, while we're still
          // armed and the user hasn't released the key. Hold mode also
          // requires that the keyup hasn't already cleared armedContext.
          if (
            armedContext &&
            curr.modelStatus === 'ready' &&
            prev.modelStatus !== 'ready' &&
            curr.hotkeyState === 'armed'
          ) {
            const ctx = armedContext
            clearArmedContext()
            if (!ctx.tabId) {
              log.warn('voice-hotkey', 'armed-promote-no-tab', { source: ctx.source })
              set({ hotkeyState: 'idle' })
              return
            }
            log.info('voice-hotkey', 'armed-promote', ctx)
            set({ hotkeyState: 'recording' })
            useVoice.getState().startRecording(ctx.tabId)
          }
        })
        return
      }

      // canRecord && reason === 'ready' → start recording.
      if (!tabId) {
        log.warn('voice-hotkey', 'no-active-tab', { source })
        return
      }
      log.info('voice-hotkey', 'start', { source, mode, tabId })
      s.startRecording(tabId)
      // startRecording flips isRecording synchronously on the success path
      // and short-circuits without flipping it on guarded paths (already
      // recording, prior handle draining, unsupported env). Mirror that
      // outcome into hotkeyState so a failed start doesn't strand the
      // state machine with `recording` while isRecording stays false.
      if (get().isRecording) {
        set({ hotkeyState: 'recording' })
      } else {
        log.warn('voice-hotkey', 'start: recording did not engage', {
          errorKind: get().errorKind,
        })
        set({ hotkeyState: 'idle' })
      }
      return
    }

    // phase === 'up' — hold-mode keyup. Toggle mode never sees `up` from main
    // because main only emits `down` for fresh keydowns in toggle mode.
    if (mode !== 'hold' || source === 'global') return

    if (s.hotkeyState === 'armed') {
      // Released before model ready → cancel silently (PRD state machine).
      // Drop the auto-promote subscriber so a late ready-flip doesn't
      // start recording the user didn't ask for.
      clearArmedContext()
      log.info('voice-hotkey', 'miss-model-loading-armed-up')
      set({ hotkeyState: 'idle' })
      return
    }
    if (s.hotkeyState === 'recording') {
      set({ hotkeyState: 'stopping' })
      clearDrainWatchdog()
      drainWatchdog = setTimeout(() => {
        if (get().hotkeyState === 'stopping') {
          log.warn('voice-hotkey', 'drain-timeout', { durationMs: DRAIN_TIMEOUT_MS })
          set({ hotkeyState: 'aborted' })
          setTimeout(() => {
            if (get().hotkeyState === 'aborted') set({ hotkeyState: 'idle' })
          }, 0)
        }
      }, DRAIN_TIMEOUT_MS)
      s.stopRecording()
    }
  },

  /** Window-destroyed terminal transition. Called on beforeunload. */
  destroyHotkey: () => {
    const s = get()
    // Always cancel any pending armed-promote subscription on destroy so
    // a stray ready-flip during shutdown can't start a phantom recording.
    clearArmedContext()
    cancelSubmitInternal()
    if (s.hotkeyState === 'recording') {
      log.warn('voice-hotkey', 'destroyed-mid-recording')
      set({ hotkeyState: 'destroyed' })
      try { s.stopRecording() } catch { /* */ }
    } else if (s.hotkeyState === 'armed' || s.hotkeyState === 'stopping') {
      // armed/stopping leak the drain watchdog otherwise.
      clearDrainWatchdog()
      set({ hotkeyState: 'destroyed' })
    }
  },
}))

export const selectLiveTranscript = (s: VoiceState) => ({
  isRecording: s.isRecording,
  statusPill: s.statusPill,
  lastPartial: s.lastPartial,
  lastTranscript: s.lastTranscript,
  submitCountdownStartAt: s.submitCountdownStartAt,
})

/**
 * Pure predicate. F1 hotkey imports this directly. View-layer copy lives in
 * voiceCopy.ts; never put strings in here.
 */
export const selectCanRecord = (
  s: VoiceState,
): { canRecord: boolean; reason: GateReason } => {
  if (!isRecognitionSupported()) return { canRecord: false, reason: 'unsupported' }
  if (s.permissionState === 'denied') return { canRecord: false, reason: 'permission-denied' }
  if (s.modelStatus === 'ready') return { canRecord: true, reason: 'ready' }
  if (s.modelStatus === 'loading') return { canRecord: false, reason: 'loading' }
  if (s.modelStatus === 'error') {
    return { canRecord: false, reason: s.errorKind === 'timeout' ? 'load-timeout' : 'error' }
  }
  return { canRecord: false, reason: 'idle' }
}

// Test-only read hooks: expose voice state and a transcript history buffer
// so e2e tests can assert on exactly what the mic feature produced.
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __voice?: typeof useVoice
    __transcripts?: Array<{ tabId: string; text: string }>
  }
  w.__voice = useVoice
  w.__transcripts = []
}
