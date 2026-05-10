# F3 — Mic-level meter / waveform visualization (v2)

Status: Draft v2
Owner: Voice subsystem
Last updated: 2026-05-02 (PDT)

## Changes from v1

Folds in the v1 critique:

- **Stream ownership.** F3 owns `getUserMedia` and the `AudioContext`. F5 threads `inputDeviceId` through F3's call site rather than calling `getUserMedia` itself.
- **Sample rate.** Drop `sampleRate: 16000`. Default rate; `fftSize` raised to 2048. Future change requires A/B against the WAV fixture.
- **Disposal order.** `vad.pause() → vad.destroy() → analyser.disconnect() → source.disconnect() → track.stop() → await audioContext.close()`, all awaitables awaited, `close()` in try/catch.
- **rAF home.** `<MicLevelMeter />`'s `useEffect`. Component reads `AnalyserNode` via `getAnalyser()` on `RecognitionHandle`. Cleanup is the `useEffect` return; no cross-module `destroyed` flag.
- **Threshold space.** Clip thresholds in raw RMS; cosmetic curve at render only.
- **Performance budget.** Measured ≤2 % main-thread CPU at 60 Hz, with a benchmark step.
- **Permission revocation.** `track.onended` plumbed to the voice store.
- **Feature flag.** `voice.levelMeter` + `SM_VOICE_LEVEL_METER` env override.
- **Visual regression.** Playwright `toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`.
- New **Success Criteria** section.

## Problem & Motivation

The only feedback that the mic is hot today is a pulsing red dot plus "Listening…" in `RecordingStatus`. That UI is satisfied by a successful `MicVAD.new()` — it does not prove audio frames arrive from the OS. A muted hardware switch, the wrong default device, a Pulse/PipeWire route to "Monitor of …", or a mis-clicked permission prompt all produce the same UI while the mic is silent. Users discover failure only after speaking and getting no transcript (or the hallucinated `"Thank you."` filtered by the guardlist).

A real-time meter resolves this in <100 ms of speech. It is also a privacy primitive: a moving bar is harder to forget than a status string.

## Scope

- **In scope:** ~80 px horizontal RMS bar in `RecordingStatus`, visible only while `useVoice.isRecording === true`. Colour shifts to amber/red on near-clip.
- **Out of scope (v1):** Scrolling waveform, spectrogram, per-frequency bars, persisted history.
- **Stretch (v1.1):** Thin time-domain trace; silent-mic auto-warning (deferred — needs calibration).

F4 owns the dedicated mic-test pane.

## UX Flow

1. Mic button → `startRecording()`.
2. `RecordingStatus` swaps to the recording row; the meter renders to the right of the transcript.
3. Fill width = `clamp(pow(rawRms, 0.4) * 1.2, 0, 1)`. Colour by raw RMS: `< 0.40` green; `0.40–0.70` amber; `≥ 0.70` red. Any frame with `max(|x − 128|) ≥ 125` triggers a one-shot outline flash and a single `aria-live` warning per `start/stop` pair.
4. `stopRecording()` → meter unmounts, no fade.
5. **A11y:** `role="meter"`, `aria-valuenow={rawRms.toFixed(2)}` updated at 4 Hz via `setInterval`. `prefers-reduced-motion` disables colour transitions; the bar still moves.
6. **Window hidden:** `visibilitychange` → static "Recording — window hidden" badge instead of a frozen bar.

## Technical Design

### Stream and AudioContext ownership (authoritative)

F3 is the source of truth for `getUserMedia` and the `AudioContext`. `speechRecognition.ts` owns both and injects them into MicVAD. F5 does not call `getUserMedia`; it passes `inputDeviceId` into `createRecognition`, threaded into the `audio` constraint below. This resolves the F3↔F5 deferral cycle.

```ts
// createRecognition({ inputDeviceId? })
const audio = inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true
const stream = await navigator.mediaDevices.getUserMedia({ audio })
const audioContext = new AudioContext() // default rate; do NOT force 16 kHz
const source = audioContext.createMediaStreamSource(stream)

const analyser = audioContext.createAnalyser()
analyser.fftSize = 2048              // ~42 ms window @ 48 kHz
analyser.smoothingTimeConstant = 0.3
source.connect(analyser)             // sink only; never to destination

const vad = await MicVAD.new({
  ...existingOpts,
  audioContext,
  getStream: async () => stream,
  pauseStream: async () => {},       // no-op; teardown via destroy()
  resumeStream: async () => stream,  // valid only within one session
})

stream.getAudioTracks()[0].onended = () => onPermissionLost()
```

`ownsAudioContext` stays false because we supplied the context, so MicVAD's `destroy()` will not close it.

### Why default sample rate

MicVAD resamples internally. Forcing 16 kHz on the source pushes resampling into Chromium's `MediaStreamAudioSourceNode` — a different (lower-quality) resampler — and may shift VAD false-positive rates on sibilants. We take the platform default.

### rAF home

The rAF loop lives in `<MicLevelMeter />`'s `useEffect`. The component reads the live `AnalyserNode` via `recognition.getAnalyser()` exposed through a `RecognitionContext`. The `useEffect` return cancels the rAF id.

```ts
useEffect(() => {
  const analyser = recognition.getAnalyser()
  if (!analyser) return
  const buf = new Uint8Array(analyser.fftSize) // alloc once
  let raf = 0
  const tick = () => {
    analyser.getByteTimeDomainData(buf)
    // O(n) over fftSize=2048: amortised O(1) per frame
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] - 128
      sum += v * v
    }
    setMicLevel(Math.sqrt(sum / buf.length) / 128) // raw [0, 1]
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}, [recognition])
```

The cosmetic curve applies only at render; it is never written back into the store.

### Stores

`<MicLevelMeter />` reads `isRecording` from `useVoice` and `micLevel` from a sibling `useVoiceMeter` store (shallow-equal selector) to avoid waking `useVoice` subscribers 60×/s. Test hook: `__voiceMeter.getState().micLevel`.

### Disposal sequence (authoritative order)

In `RecognitionHandle.stop()` / `destroy()`:

1. `await vad.pause()`.
2. `await vad.destroy()` — releases worklet/script-processor while context is still open.
3. `analyser.disconnect()`; `source.disconnect()`.
4. `stream.getTracks().forEach(t => t.stop())` — releases the OS handle.
5. `try { await audioContext.close() } catch (e) { log.warn('voice', 'audioContext close', e) }`.
6. Null refs; meter `useEffect` cleanup cancels rAF on unmount.

Closing the context before `vad.destroy()` throws `InvalidStateError`. Tracks stop after disconnects so disconnects cannot race with worklet teardown.

### Feature flag

Gate behind `settings.voice.levelMeter` (default `true`) plus env override `SM_VOICE_LEVEL_METER=0|1` (env wins). When disabled: meter does not mount, `speechRecognition.ts` skips analyser construction, `getAnalyser()` returns `null`.

### Permission revoked mid-session

`track.onended` fires when the OS revokes permission. We call `onError({ kind: 'permission-revoked' })`, which flips `useVoice.isRecording` to false and surfaces a toast. The disposal sequence runs as normal.

## Edge Cases & Failure Modes

1. `getUserMedia` denied → existing error path; no meter renders.
2. Tab backgrounded → static "window hidden" badge via `visibilitychange`.
3. Slow machines → throttle store writes to 30 Hz if benchmark fails.
4. Hot signal → clip flash on raw threshold; gain is the OS's job.
5. Silent-mic detection → deferred to v1.1 pending calibration.
6. Back-to-back sessions → fresh stream/context/analyser each time.
7. Device hot-swap → F5 calls `stopRecording()` then `startRecording({ inputDeviceId })`.
8. Permission revoked mid-session → `track.onended` → voice store error.
9. ScriptProcessor fallback → MicVAD picks worklet vs ScriptProcessor; analyser path is independent.

## Security & Privacy

- Meter renders iff `isRecording === true`. No preview mode that holds the mic open without a meter.
- Meter reflects the same stream the VAD consumes — never a synthetic source.
- No mic data leaves the renderer. Only a scalar RMS is exposed.
- When the window is occluded, the static badge keeps the privacy signal alive without burning CPU.

## Telemetry & Logging

- On `stopRecording`, log `{ peakLevelRaw, meanLevelRaw, clipFrames, durationMs }` via `log.info('voice', 'session levels', …)`. Window is the `start → stop` pair.
- Gated behind `voice.logLevels` (default off in v1).

## Success Criteria

Ship-blocking:

1. **Latency:** `useVoiceMeter.micLevel > 0.05` within 200 ms of `startRecording` against the WAV fixture.
2. **Truthful zero:** within 100 ms of `stopRecording`, `micLevel === 0` and the element is detached.
3. **No leaks:** 50 record/stop cycles → JS heap growth < 5 MB; active `AudioContext` count returns to 0.
4. **Stream contract:** one `getUserMedia` call per `startRecording`; `getAudioTracks()[0].readyState === 'live'` after `vad.start()`.
5. **CPU:** measured ≤ 2 % main-thread CPU at 60 Hz on a 2019 i5 via the benchmark below.
6. **Permission revoked:** toggling OS mic permission flips `isRecording` to false within 500 ms.
7. **Flag off:** `SM_VOICE_LEVEL_METER=0` produces no analyser, no meter element, no behavioural change vs. pre-F3.

## Testing Plan

- **Unit:** RMS over synthetic Uint8Arrays — silence = 0, full-scale square = 1, sine peak ≈ 0.707.
- **E2E (Playwright + Electron + xvfb + fake-audio):** Reuse the WAV fixture. Assert criteria 1, 2, 4, 6. Spy on `getUserMedia` to verify call count and `deviceId` plumbing.
- **Visual regression:** `toHaveScreenshot({ maxDiffPixelRatio: 0.01 })` against the recording row at 0 / 50 / 95 % synthetic levels driven via `__voiceMeter.setState({ micLevel })`. Baselines under `e2e/__screenshots__/linux-xvfb/`; macOS baselines tracked separately due to font/AA differences. CI is the source of truth.
- **Benchmark (criterion 5):** `e2e/perf/level-meter.perf.ts` records 30 s with the fixture, samples `process.getCPUUsage()` every 500 ms, asserts 95p main-thread delta ≤ 2 %.
- **Memory:** 50 record/stop cycles asserting heap and `AudioContext` count.
- **Feature flag:** Run the suite once with `SM_VOICE_LEVEL_METER=0` to confirm the analyser path is fully bypassed.

## Alternatives Considered

1. System tray indicator — too far from the record button, hidden on minimise.
2. OS-level indicator only — doesn't move with input level; UX-insufficient.
3. Reuse MicVAD `onFrameProcessed` — couples the meter to VAD frame cadence and duplicates the AnalyserNode's C++ RMS work. Lifting `getUserMedia` is cleaner and gives F5/F6 the same hook.

## Open Questions

1. Clip detection: auto-suggest gain reduction or warn only? (Lean: warn.)
2. Thin waveform behind the bar in v1.1?
3. Telemetry default off (privacy) or on (diagnostics)?
4. Silent-mic calibration data before v1.1 auto-warning ships.
