/**
 * MicWizard — F7 first-run mic-check (v1 cut).
 *
 * Step machine: welcome → permission → device → record → playback → verify → done.
 * Every step has a Skip CTA equally prominent with the primary action.
 *
 * Privacy invariants (F7 PRD §Security & Privacy):
 *   - The recorded sample is held only in renderer memory (Blob + AudioBuffer +
 *     Float32Array). It is never written to disk, never logged, never shipped
 *     over IPC.
 *   - URL.createObjectURL is not used in the playback path; if a future
 *     fallback adds one, revokeObjectURL must run in the same tick that
 *     decodeAudioData returns. (We decode → AudioBufferSourceNode → destination.)
 *   - getUserMedia stream tracks are stopped when the wizard advances past the
 *     record step, when the user closes the modal, and on unmount.
 *
 * Logging: only step transitions and error categories. Never audio bytes,
 * never level-meter values, never transcript content.
 *
 * Soft deps: F2 (gate predicate), F3 (level meter), F5 (device picker). Each
 * is degraded individually rather than blocking the wizard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './ui/Modal'
import { MicDevicePicker } from './MicDevicePicker'
import { useVoice } from '../state/voice'
import { useSessions } from '../state/sessions'
import { transcribeOnce } from '../lib/speechRecognition'

type Step =
  | 'welcome'
  | 'permission'
  | 'device'
  | 'record'
  | 'playback'
  | 'verify'
  | 'done'

const RECORD_DURATION_MS = 5000

/** Renderer-only logger wrapper. Never includes audio or transcript content. */
function wlog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) {
  try {
    window.api?.logs?.write('voice-wizard', level, msg, meta)
  } catch { /* preload not ready */ }
}

/**
 * F3-style level meter that reads from a caller-owned AnalyserNode rather than
 * the active recognition handle. Same RMS curve as MicLevelMeter so visual
 * intensity is consistent. Component-local state only.
 *
 * Complexity: O(fftSize) per rAF; fftSize=2048 ⇒ ~10 µs/frame.
 */
function LevelBarFromAnalyser({ analyser }: { analyser: AnalyserNode | null }) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!analyser) {
      setWidth(0)
      return
    }
    let raf = 0
    let cancelled = false
    const buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    const tick = () => {
      if (cancelled) return
      analyser.getByteTimeDomainData(buf)
      let sumSq = 0
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] - 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / buf.length) / 128
      const display = Math.min(1, Math.max(0, Math.pow(rms, 0.4) * 1.2))
      setWidth(display)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [analyser])
  return (
    <div className="h-1.5 w-full rounded bg-bg overflow-hidden">
      <div
        className="h-full bg-green-500 transition-[width] duration-75 ease-out"
        style={{ width: `${width * 100}%` }}
        data-testid="wizard-level-bar"
      />
    </div>
  )
}

interface MicWizardProps {
  open: boolean
  onClose: () => void
}

export function MicWizard({ open, onClose }: MicWizardProps) {
  const permissionState = useVoice((s) => s.permissionState)
  const modelStatus = useVoice((s) => s.modelStatus)
  // F7 P0-1: render the actual model-load progress on the verify-step gate
  // so the user sees motion instead of a static "Preparing speech model…".
  // Subscribe directly so the percent updates as bytes arrive.
  const loadingProgress = useVoice((s) => s.loadingProgress)

  const [step, setStep] = useState<Step>('welcome')
  const [error, setError] = useState<string | null>(null)
  // Empty-device flag for the device step.
  const [noDevices, setNoDevices] = useState(false)
  // Bumped when the user clicks "Try again" on the no-device screen so the
  // effect re-probes (deps `[open, step]` alone wouldn't re-fire because
  // step is still 'device').
  const [deviceProbeKey, setDeviceProbeKey] = useState(0)

  // Owned-by-wizard audio resources. Created in the record step, torn down
  // when we advance past it / the modal closes / the component unmounts.
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  // Captured Blob from the most recent record. Held in renderer memory only.
  const recordedBlobRef = useRef<Blob | null>(null)
  // Decoded buffer kept across playback↔verify transitions. Channel-0 PCM is
  // posted (transferred) to the worker once, so we keep the buffer for replay.
  const decodedBufferRef = useRef<AudioBuffer | null>(null)
  // The currently-playing source so we can disconnect it.
  const playbackSourceRef = useRef<AudioBufferSourceNode | null>(null)

  const [recording, setRecording] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState<number>(Math.round(RECORD_DURATION_MS / 1000))
  const [isPlaying, setIsPlaying] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState<string | null>(null)
  // Re-render trigger when analyser ref is set/cleared (refs alone don't trigger renders).
  const [analyserVersion, setAnalyserVersion] = useState(0)

  /** Stop & release any owned mic resources. Idempotent. */
  const releaseMic = useCallback(() => {
    try { recorderRef.current?.stop() } catch { /* may already be inactive */ }
    recorderRef.current = null
    if (playbackSourceRef.current) {
      try { playbackSourceRef.current.disconnect() } catch { /* */ }
      playbackSourceRef.current = null
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect() } catch { /* */ }
      analyserRef.current = null
    }
    if (analyserSourceRef.current) {
      try { analyserSourceRef.current.disconnect() } catch { /* */ }
      analyserSourceRef.current = null
    }
    setAnalyserVersion((v) => v + 1)
    if (audioCtxRef.current) {
      const ctx = audioCtxRef.current
      audioCtxRef.current = null
      try { ctx.close() } catch { /* idempotent on close */ }
    }
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach((t) => t.stop()) } catch { /* */ }
      streamRef.current = null
    }
  }, [])

  /** Reset all wizard-local state without touching persisted prefs. */
  const resetAll = useCallback(() => {
    releaseMic()
    recordedBlobRef.current = null
    decodedBufferRef.current = null
    setRecording(false)
    setSecondsRemaining(Math.round(RECORD_DURATION_MS / 1000))
    setIsPlaying(false)
    setTranscribing(false)
    setTranscript(null)
    setError(null)
    setNoDevices(false)
  }, [releaseMic])

  // Fire wizard.opened once on mount when open flips true; reset on close.
  useEffect(() => {
    if (open) {
      wlog('info', 'wizard.opened')
      setStep('welcome')
    } else {
      // Closing: tear down everything. resetAll is intentionally not
      // listed in deps for the effect that opens the wizard — it's stable.
      resetAll()
    }
  }, [open, resetAll])

  // Privacy invariant: tear down owned mic resources on unmount no matter what.
  useEffect(() => {
    return () => releaseMic()
  }, [releaseMic])

  const goto = useCallback((next: Step) => {
    wlog('info', 'wizard.step', { step: next })
    setError(null)
    setStep(next)
  }, [])

  const skipFromHere = useCallback((mode: 'skip-and-record' | 'skip') => {
    wlog('info', 'wizard.skipped', { step, mode })
    releaseMic()
    onClose()
    if (mode === 'skip-and-record') {
      // Flip wizardArmed off so subsequent clicks record normally, then
      // start a recording on the active tab. We do NOT stamp completedAt:
      // skip is distinct from complete. The armed flag is render-only and
      // resets on next launch unless the user actually completed the wizard.
      const v = useVoice.getState()
      v.setWizardArmed(false)
      const tabId = useSessions.getState().activeTabId
      if (tabId) v.startRecording(tabId)
    } else {
      useVoice.getState().setWizardArmed(false)
    }
  }, [step, onClose, releaseMic])

  // ─────────────────────────────────────────── Welcome → Permission gating
  const onStart = useCallback(() => {
    if (permissionState === 'denied') {
      goto('permission')
      return
    }
    // Permission granted, prompt, or unknown → still go through the
    // permission step so the wizard explains what's about to happen.
    // Permission step auto-advances on 'granted'.
    goto('permission')
  }, [permissionState, goto])

  // Auto-advance the permission step when state is granted.
  useEffect(() => {
    if (open && step === 'permission' && permissionState === 'granted') {
      goto('device')
    }
  }, [open, step, permissionState, goto])

  // ─────────────────────────────────────────── Device step: empty-list probe
  useEffect(() => {
    if (!open || step !== 'device') return
    let cancelled = false
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) {
          if (!cancelled) setNoDevices(true)
          return
        }
        const list = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        const inputs = list.filter((d) => d.kind === 'audioinput')
        setNoDevices(inputs.length === 0)
      } catch (e: unknown) {
        if (cancelled) return
        wlog('warn', 'wizard.error', { step: 'device', error: e instanceof Error ? e.message : String(e) })
        setNoDevices(true)
      }
    })()
    return () => { cancelled = true }
  }, [open, step, deviceProbeKey])

  // ─────────────────────────────────────────── Record step
  const startRecording = useCallback(async () => {
    setError(null)
    setRecording(true)
    setSecondsRemaining(Math.round(RECORD_DURATION_MS / 1000))
    try {
      // Read the F5 device pref so the wizard records from the same device
      // the user picked in the device step.
      let deviceId: string | null = null
      try {
        const pref = await window.api.voice.getDevicePref()
        deviceId = pref?.selectedDeviceId ?? null
      } catch { /* fall back to default */ }

      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      }
      if (deviceId) {
        ;(audioConstraints as MediaTrackConstraints & { deviceId?: ConstrainDOMString }).deviceId = { exact: deviceId }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      streamRef.current = stream
      const ctx = new AudioContext()
      audioCtxRef.current = ctx

      // Wire an analyser branch off the stream for the live meter. Sink-only:
      // never connected to ctx.destination, so no monitoring back to the
      // speakers.
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      analyserSourceRef.current = source
      analyserRef.current = analyser
      setAnalyserVersion((v) => v + 1)

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || 'audio/webm'
        recordedBlobRef.current = new Blob(chunks, { type })
        setRecording(false)
        // Stop tracks now: we already have the blob and don't need the live
        // mic for playback or verification. The analyser is also useless
        // after stop, so disconnect it. AudioContext stays alive for playback.
        if (analyserRef.current) {
          try { analyserRef.current.disconnect() } catch { /* */ }
          analyserRef.current = null
        }
        if (analyserSourceRef.current) {
          try { analyserSourceRef.current.disconnect() } catch { /* */ }
          analyserSourceRef.current = null
        }
        setAnalyserVersion((v) => v + 1)
        if (streamRef.current) {
          try { streamRef.current.getTracks().forEach((t) => t.stop()) } catch { /* */ }
          streamRef.current = null
        }
        // Auto-advance to playback.
        goto('playback')
      }
      recorder.onerror = (e: Event) => {
        const msg = (e as { error?: { message?: string } }).error?.message ?? 'recorder error'
        wlog('error', 'wizard.error', { step: 'record', error: msg })
        setError(msg)
        setRecording(false)
      }

      recorder.start()
      // Countdown ticker. setInterval at 250ms gives smooth-ish second-rolls
      // without stressing rAF for an essentially-static UI update.
      const startedAt = Date.now()
      const ticker = setInterval(() => {
        const elapsed = Date.now() - startedAt
        const left = Math.max(0, Math.ceil((RECORD_DURATION_MS - elapsed) / 1000))
        setSecondsRemaining(left)
        if (elapsed >= RECORD_DURATION_MS) {
          clearInterval(ticker)
          try { recorder.stop() } catch { /* already stopped */ }
        }
      }, 250)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      wlog('error', 'wizard.error', { step: 'record', error: msg })
      setError(msg)
      setRecording(false)
      releaseMic()
    }
  }, [goto, releaseMic])

  // ─────────────────────────────────────────── Playback step
  const playRecording = useCallback(async () => {
    setError(null)
    const blob = recordedBlobRef.current
    if (!blob) {
      setError('No recording available')
      return
    }
    try {
      // Reuse audio context if still alive; else build a new one. We never
      // use URL.createObjectURL in this path — decodeAudioData reads the
      // ArrayBuffer directly, satisfying the privacy invariant by construction.
      let ctx = audioCtxRef.current
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext()
        audioCtxRef.current = ctx
      }
      let buffer = decodedBufferRef.current
      if (!buffer) {
        const ab = await blob.arrayBuffer()
        buffer = await ctx.decodeAudioData(ab.slice(0))
        decodedBufferRef.current = buffer
      }
      // Disconnect any prior playback so replay doesn't stack sources.
      if (playbackSourceRef.current) {
        try { playbackSourceRef.current.disconnect() } catch { /* */ }
        playbackSourceRef.current = null
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      playbackSourceRef.current = src
      setIsPlaying(true)
      src.onended = () => {
        setIsPlaying(false)
        try { src.disconnect() } catch { /* */ }
        if (playbackSourceRef.current === src) playbackSourceRef.current = null
      }
      src.start()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      wlog('error', 'wizard.error', { step: 'playback', error: msg })
      setError(msg)
      setIsPlaying(false)
    }
  }, [])

  // Auto-play once when the playback step first opens.
  useEffect(() => {
    if (open && step === 'playback') {
      playRecording().catch(() => { /* surfaced via setError */ })
    }
  }, [open, step, playRecording])

  // ─────────────────────────────────────────── Verify step
  const runTranscribe = useCallback(async () => {
    setError(null)
    setTranscribing(true)
    setTranscript(null)
    try {
      const buffer = decodedBufferRef.current
      if (!buffer) {
        throw new Error('No decoded audio available')
      }
      // Channel-0 Float32 PCM. We copy because transcribeOnce transfers the
      // underlying ArrayBuffer; if the user replays we need the original.
      // 16 kHz vs the recorder's native rate: the worker (Moonshine) handles
      // resampling internally — we don't need to downsample here. Behaviour
      // matches speechRecognition.ts which posts whatever VAD emitted.
      const ch0 = buffer.getChannelData(0)
      const copy = new Float32Array(ch0.length)
      copy.set(ch0)
      const text = await transcribeOnce(copy)
      // Per F7 PRD v2: do NOT pass through ASR_HALLUCINATIONS — that filter
      // targets runtime command false-positives and would fail legitimate
      // short test phrases. Show the transcript verbatim.
      setTranscript(text)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      wlog('error', 'wizard.error', { step: 'verify', error: msg })
      setError(msg)
    } finally {
      setTranscribing(false)
    }
  }, [])

  // F7 P0-1: kick off transcription when the verify step opens AND the
  // model is ready. If the user lands on verify while the model is still
  // loading, this effect re-fires when modelStatus flips to 'ready'. Prior
  // implementation only depended on `step`, so an arrival mid-load left the
  // user waiting on a spinner that never advanced.
  useEffect(() => {
    if (
      open &&
      step === 'verify' &&
      modelStatus === 'ready' &&
      transcript === null &&
      !transcribing &&
      !error
    ) {
      runTranscribe()
    }
  }, [open, step, modelStatus, transcript, transcribing, error, runTranscribe])

  // ─────────────────────────────────────────── Done
  const finish = useCallback(async () => {
    try {
      await window.api.voice.markWizardComplete()
      wlog('info', 'wizard.complete')
    } catch (e: unknown) {
      wlog('error', 'wizard.error', { step: 'done', error: e instanceof Error ? e.message : String(e) })
    }
    useVoice.getState().setWizardArmed(false)
    releaseMic()
    onClose()
  }, [onClose, releaseMic])

  const onModalClose = useCallback(() => {
    wlog('info', 'wizard.skipped', { step, mode: 'modal-close' })
    releaseMic()
    useVoice.getState().setWizardArmed(false)
    onClose()
  }, [step, releaseMic, onClose])

  // ─────────────────────────────────────────── Per-step rendering
  const stepBody = useMemo(() => {
    switch (step) {
      case 'welcome':
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Set up voice input. About 30 seconds. Audio stays on your device — nothing is uploaded.
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90"
                onClick={onStart}
                data-testid="wizard-start"
              >
                Start
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi"
                onClick={() => skipFromHere('skip-and-record')}
                data-testid="wizard-skip-and-record"
              >
                Skip and record now
              </button>
              <button
                type="button"
                className="text-xs text-fg-dim hover:text-fg underline self-start"
                onClick={() => skipFromHere('skip')}
                data-testid="wizard-open-settings-later"
              >
                Open Settings later
              </button>
            </div>
          </div>
        )

      case 'permission':
        if (permissionState === 'denied') {
          // macOS deep link is the standard remediation. We don't re-call
          // askForMediaAccess — Electron caches per-session.
          return (
            <div className="space-y-3">
              <p className="text-sm text-fg">
                Microphone access is blocked. Open your operating system's privacy settings and grant
                Session Manager microphone permission, then re-run the mic check from Settings.
              </p>
              <p className="text-xs text-fg-dim">
                macOS: System Settings → Privacy &amp; Security → Microphone.<br />
                Windows: Settings → Privacy &amp; security → Microphone.<br />
                Linux: depends on desktop — usually Settings → Sound or pavucontrol.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi flex-1"
                  onClick={() => skipFromHere('skip')}
                  data-testid="wizard-skip"
                >
                  Skip
                </button>
              </div>
            </div>
          )
        }
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Session Manager needs microphone access to recognize your speech locally.
              Your operating system may show a prompt — click Allow.
            </p>
            <p className="text-xs text-fg-dim">
              State: {permissionState}
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90 flex-1"
                onClick={() => goto('device')}
                data-testid="wizard-permission-continue"
              >
                Continue
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi flex-1"
                onClick={() => skipFromHere('skip')}
                data-testid="wizard-skip"
              >
                Skip
              </button>
            </div>
          </div>
        )

      case 'device':
        if (noDevices) {
          return (
            <div className="space-y-3">
              <p className="text-sm text-fg">No microphone detected.</p>
              <p className="text-xs text-fg-dim">
                Plug in or connect a mic, then click Try again. Common causes: unplugged USB,
                VM without audio passthrough, or an X-forwarded session.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90 flex-1"
                  onClick={() => {
                    setNoDevices(false)
                    setDeviceProbeKey((k) => k + 1)
                  }}
                  data-testid="wizard-device-retry"
                >
                  Try again
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi flex-1"
                  onClick={() => skipFromHere('skip')}
                  data-testid="wizard-skip"
                >
                  Skip
                </button>
              </div>
            </div>
          )
        }
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">Choose your microphone:</p>
            {/* F5 picker reused inline. It writes the selection to disk on
                change, so the record step picks it up via getDevicePref. */}
            <MicDevicePicker />
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90 flex-1"
                onClick={() => goto('record')}
                data-testid="wizard-device-continue"
              >
                Continue
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi flex-1"
                onClick={() => skipFromHere('skip')}
                data-testid="wizard-skip"
              >
                Skip
              </button>
            </div>
          </div>
        )

      case 'record':
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Say: <span className="text-fg font-medium">"testing one two three"</span>
            </p>
            <p className="text-xs text-fg-dim">Audio stays on your device — nothing is uploaded.</p>
            {recording ? (
              <>
                <div className="text-xs text-fg-dim font-mono" data-testid="wizard-countdown">
                  Recording… {secondsRemaining}s
                </div>
                {/* analyserVersion ensures we re-render on ref churn. */}
                <LevelBarFromAnalyser key={analyserVersion} analyser={analyserRef.current} />
              </>
            ) : (
              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90"
                  onClick={() => { startRecording() }}
                  data-testid="wizard-record-start"
                >
                  Start recording
                </button>
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi"
                  onClick={() => skipFromHere('skip')}
                  data-testid="wizard-skip"
                >
                  Skip
                </button>
              </div>
            )}
          </div>
        )

      case 'playback':
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Did that sound right?
            </p>
            <p className="text-xs text-fg-dim">
              {isPlaying ? 'Playing back…' : 'Playback finished.'}
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90"
                onClick={() => goto('verify')}
                data-testid="wizard-playback-yes"
              >
                Yes — continue
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi"
                onClick={() => { playRecording() }}
                data-testid="wizard-playback-replay"
              >
                Replay
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi"
                onClick={() => {
                  // "No" → re-record. Drop the prior decode so the next
                  // playback re-decodes the new blob.
                  decodedBufferRef.current = null
                  recordedBlobRef.current = null
                  goto('record')
                }}
                data-testid="wizard-playback-no"
              >
                No — try again
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg-dim hover:text-fg"
                onClick={() => skipFromHere('skip')}
                data-testid="wizard-skip"
              >
                Skip
              </button>
            </div>
          </div>
        )

      case 'verify':
        // F7 P0-1: model not ready — render the live loading bar so the
        // user sees motion. The runTranscribe useEffect above will fire
        // automatically when modelStatus flips to 'ready', auto-advancing
        // off this screen without requiring user input.
        if (modelStatus === 'loading' || modelStatus === 'idle') {
          return (
            <div className="space-y-3">
              <p className="text-sm text-fg">Preparing speech model…</p>
              <div className="flex items-center justify-between text-[11px] text-fg-faint">
                <span>Downloading</span>
                <span className="font-mono">{loadingProgress}%</span>
              </div>
              <div className="h-1 rounded bg-bg overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${loadingProgress}%` }}
                  data-testid="wizard-load-progress"
                />
              </div>
              <p className="text-xs text-fg-dim">
                The model runs offline once it's downloaded. This only happens on first launch.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi flex-1"
                  onClick={() => skipFromHere('skip')}
                  data-testid="wizard-skip"
                >
                  Skip
                </button>
              </div>
            </div>
          )
        }
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              {transcribing
                ? 'Transcribing your sample…'
                : transcript === null
                  ? 'Ready to transcribe.'
                  : 'We heard:'}
            </p>
            {transcript !== null && (
              <p
                className="text-sm text-fg bg-bg border border-line rounded p-2 font-mono break-words"
                data-testid="wizard-transcript"
              >
                {transcript || '(no text recognized)'}
              </p>
            )}
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                disabled={transcribing || transcript === null}
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => goto('done')}
                data-testid="wizard-verify-yes"
              >
                Yes — that matches
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg hover:bg-bg-hi"
                onClick={() => {
                  decodedBufferRef.current = null
                  recordedBlobRef.current = null
                  setTranscript(null)
                  goto('record')
                }}
                data-testid="wizard-verify-retry"
              >
                Retry — record again
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded border border-line text-sm text-fg-dim hover:text-fg"
                onClick={() => skipFromHere('skip')}
                data-testid="wizard-skip"
              >
                Skip
              </button>
            </div>
          </div>
        )

      case 'done':
        return (
          <div className="space-y-3">
            <p className="text-sm text-fg">All set. The mic check is complete.</p>
            <p className="text-xs text-fg-dim">
              You can re-run this any time from the mic-controls panel.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="px-3 py-2 rounded bg-accent text-bg text-sm font-medium hover:opacity-90 flex-1"
                onClick={() => { finish() }}
                data-testid="wizard-done"
              >
                Done
              </button>
            </div>
          </div>
        )
    }
  }, [
    step,
    onStart,
    skipFromHere,
    permissionState,
    noDevices,
    recording,
    secondsRemaining,
    analyserVersion,
    isPlaying,
    transcribing,
    transcript,
    modelStatus,
    loadingProgress,
    error,
    goto,
    startRecording,
    playRecording,
    finish,
  ])

  return (
    <Modal open={open} onClose={onModalClose} title="Mic check">
      <div className="space-y-3" data-testid="mic-wizard">
        <div className="text-[10px] text-fg-faint uppercase tracking-wide">
          Step: {step}
        </div>
        {error ? (
          <p className="text-xs text-red-400" data-testid="wizard-error">
            {error}
          </p>
        ) : null}
        {stepBody}
      </div>
    </Modal>
  )
}
