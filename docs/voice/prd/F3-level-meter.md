# F3 — Mic-level meter / waveform visualization

Status: Draft
Owner: Voice subsystem
Last updated: 2026-05-02 (PDT)

## Problem & Motivation

Today the only feedback that the microphone is "hot" is a pulsing red dot plus the literal string "Listening…" in `LeftNav.tsx:122-128`. That UI is satisfied by a successful `MicVAD.new()` call — it does **not** prove that audio frames are actually arriving from the OS. A muted hardware switch, a wrong default input device, a Pulse/Pipewire route to `Monitor of …`, or a permission prompt the user mis-clicked all produce the same "Listening…" UI while the mic is silent. Users only discover the failure after speaking a full sentence and getting no transcript (or a hallucinated `"Thank you."` from the ASR-hallucination guardlist in `voice.ts:32-43`).

A real-time level meter solves this in <100 ms of speech: the bar moves, the user knows the path is alive. It is also a privacy primitive — a visible meter is harder to forget than a status string and reinforces the OS-level mic indicator. F3 ships a small RMS bar in the `RecordingStatus` slot wired to the same `MediaStream` the VAD consumes.

## Scope

- **In scope:** A horizontal RMS bar, ~80 px wide, rendered inside `RecordingStatus` (`LeftNav.tsx:89-130`), visible **only** while `useVoice.isRecording === true`. Color shifts to amber/red on near-clip. Refresh rate tied to `requestAnimationFrame` (~60 Hz, throttled by the browser when the window is occluded).
- **Out of scope (v1):** Scrolling waveform, spectrogram, per-frequency bars, persisted level history. A full waveform is ~10× the draw cost and adds nothing over RMS for a "is the mic hot?" affordance.
- **Stretch (v1.1):** Optional thin waveform behind the RMS bar (single-channel time-domain trace, 64 px wide, decimated to 32 samples), gated behind a setting. Not built in v1.

The meter is **not** a settings-page diagnostic. F4 will add a dedicated mic test pane; F3 is purely the always-on indicator next to the record button.

## UX Flow

1. User clicks the mic button → `startRecording()` runs (`voice.ts:74`).
2. `RecordingStatus` swaps from "Loading speech model" / null to the recording row (red dot + transcript). The level meter renders to the right of the transcript text, taking ~64 px.
3. While recording, the bar fill is the smoothed normalized RMS in [0, 1].
   - 0.00–0.70: accent green (`bg-accent`)
   - 0.70–0.90: amber (`bg-yellow-400`)
   - ≥ 0.90: red (`bg-red-400`) + a 1 px outline flash on any single frame ≥ 0.98 (clip warning)
4. On `stopRecording()`, the meter is unmounted (no fade — recording ended, no input is honest).
5. **Accessibility:** the bar has `role="meter"`, `aria-valuemin="0"`, `aria-valuemax="1"`, `aria-valuenow={smoothedRms.toFixed(2)}`, `aria-label="Microphone input level"`. Screen-reader users do not get per-frame updates (would spam) — `aria-valuenow` is updated at 4 Hz via a separate setInterval. The clip warning also writes `aria-live="polite"` text "Microphone input clipping" once per recording session.
6. **Reduced motion:** if `prefers-reduced-motion: reduce`, color transitions disable but the bar still moves (movement *is* the signal).

## Technical Design

### MediaStream sharing

Today MicVAD owns the stream end-to-end via its default `getStream` (it calls `getUserMedia` internally and sets `ownsAudioContext = true`, see `real-time-vad.d.ts:54`). To tap the same audio for an `AnalyserNode`, we lift `getUserMedia` and the `AudioContext` to our layer and inject both into MicVAD:

```ts
// in createRecognition() — replaces the bare MicVAD.new() at speechRecognition.ts:158
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
const audioContext = new AudioContext({ sampleRate: 16000 })
const source = audioContext.createMediaStreamSource(stream)

const analyser = audioContext.createAnalyser()
analyser.fftSize = 1024              // 512 freq bins; ~32 ms window @ 16 kHz
analyser.smoothingTimeConstant = 0.6 // lower than default 0.8 for responsiveness
source.connect(analyser)             // does NOT connect to destination — silent

vad = await MicVAD.new({
  ...existingOpts,
  audioContext,                      // documented option, real-time-vad.d.ts:32
  getStream: async () => stream,     // hand MicVAD the same stream, real-time-vad.d.ts:33
  pauseStream: async () => { /* keep tracks live; we own them */ },
  resumeStream: async () => stream,
})
```

The MicVAD type confirms `audioContext?: AudioContext` and `getStream: () => Promise<MediaStream>` are first-class options. By providing both, MicVAD's `ownsAudioContext` flag stays false and `destroy()` will not close our context out from under the analyser.

### Sampling cadence

Use `requestAnimationFrame` while `isRecording` is true. Per frame: call `analyser.getByteTimeDomainData(buf)` (Uint8Array, length 1024, allocated **once** at construction — never re-allocated per frame, per [addpipe.com guide](https://blog.addpipe.com/understanding-audio-frequency-analysis-in-javascript-a-guide-to-using-analysernode-and-getbytefrequencydata/)), compute RMS over the buffer, normalize: `rms = sqrt(sum((x - 128)^2) / N) / 128`. Apply ease-in cosmetic curve `display = pow(rms, 0.4) * 1.2`, clamp to 1, and write into a `useState`. Total budget per frame: ~1024 subtracts + squares + one sqrt — well under 50 µs on a 2018-era laptop. Time complexity O(n) where n = fftSize; n is constant 1024.

### Component placement

A new `<MicLevelMeter />` component lives next to `RecordingStatus` in `LeftNav.tsx` and reads RMS from a new field on the voice store (`useVoice.micLevel: number`). The store is updated by the rAF loop owned by `createRecognition`. This keeps the meter out of the speech-recognition module's render tree and lets test hooks read `__voice.getState().micLevel`.

### Disposal

On `stop()` / `destroy()` (`speechRecognition.ts:196-220`):

1. Cancel the rAF id.
2. `analyser.disconnect()`, `source.disconnect()`.
3. `stream.getTracks().forEach(t => t.stop())` — release the OS handle so the browser/OS mic indicator turns off.
4. `await audioContext.close()` — frees the audio thread; per [chrisguttandin/standardized-audio-context#410](https://github.com/chrisguttandin/standardized-audio-context/issues/410) and [WebAudio/web-audio-api#904](https://github.com/WebAudio/web-audio-api/issues/904), failing to close leaks the underlying MediaStreamAudioSourceNode and its raw frame buffer indefinitely.
5. Null all refs so the `<MicLevelMeter />` unmounts cleanly.

### Integration points

- `src/renderer/lib/speechRecognition.ts:158` — replace `MicVAD.new(...)` block with the lifted-stream version above.
- `src/renderer/lib/speechRecognition.ts:196-220` — extend `stop`/`destroy` with the disposal sequence.
- `src/renderer/state/voice.ts:10-26` — add `micLevel: number` to `VoiceState`; setter wired through callbacks.
- `src/renderer/components/LeftNav.tsx:122-128` — render `<MicLevelMeter />` inside the recording row.
- `src/main/logs.cjs` — no change; renderer logs via existing `log.info('voice', …)`.

## Edge Cases & Failure Modes

1. **`getUserMedia` denied.** Already caught at `speechRecognition.ts:188-193`; the lifted call sits inside the same try, so the existing error path is unchanged. No meter renders because `isRecording` flips back to false via `onError`.
2. **Tab backgrounded.** Browsers throttle rAF to ~1 Hz when occluded. The meter visibly stalls but the VAD continues (its AudioWorklet is unaffected). Acceptable: the user can't see the meter anyway. Do **not** fall back to setInterval — it would burn CPU on a hidden window.
3. **Slow machines / CPU budget.** Hard target: <0.3 % main-thread CPU at 60 Hz on a 2019 i5. Implementation is one O(1024) loop per frame plus a zustand set; fits comfortably. If profiling shows hot paths, throttle store writes to 30 Hz (skip every other frame) — visual difference is negligible.
4. **Meter still rendering after destroy.** Risk: the rAF callback re-schedules itself by reading a stale closure. Mitigation: closure reads a `cancelled` flag set by `destroy()`; the callback no-ops and does not re-arm. Verified with the existing `destroyed` pattern at `speechRecognition.ts:94`.
5. **Hot signal that clips.** Any single frame with `max(|x − 128|) ≥ 125` (98 % full-scale) triggers a one-shot amber-to-red flash and a single `aria-live` warning. We do not modify gain — that is the OS's job.
6. **Silent mic (broken hardware).** RMS stays < 0.005 for ≥ 3 s while `isRecording` is true → log a single `log.warn('voice', 'mic appears silent')` and (v1.1) surface a hint "No input detected — check input device". Distinguishes from a quiet user (who would still cross 0.01 on breath noise).
7. **Back-to-back recording sessions.** Each `startRecording` builds a fresh `AudioContext`, stream, and analyser; `stopRecording` tears them all down. No reuse — Chromium's pooling makes context construction cheap (<5 ms), and reuse historically leaks per the WebAudio bugs cited above.
8. **Device hot-swap (F5 territory).** When F5 ships device-change handling, it must call `stopRecording()` then `startRecording()` so the new input rebuilds the analyser chain. Until then, hot-swapping mid-recording leaves the meter stuck on the old device's level — documented limitation, owned by F5.
9. **MicVAD API drift.** The `getStream` / `audioContext` options are present in the installed `@ricky0123/vad-web` typings (`real-time-vad.d.ts:32-35`). Pin the dependency to the current minor and add a smoke test that asserts the constructed `MicVAD` actually consumes the injected stream (assert `stream.getAudioTracks()[0].readyState === 'live'` after `vad.start()`).

## Security & Privacy

A visible, always-moving meter is a **privacy win**: the user can never be unsure whether the mic is hot. Requirements:

- The meter must render iff `isRecording === true`. No "preview" mode that holds the mic open without a meter.
- The meter must reflect the same stream the VAD consumes — never a synthetic oscillator or a paused stream — otherwise it lies.
- No mic data leaves the renderer process. The analyser produces only a scalar RMS; nothing is persisted unless telemetry is explicitly enabled.

## Telemetry & Logging

- On `stopRecording`, log `{ peakLevel, meanLevel, clipFrames, durationMs }` at info via `log.info('voice', 'session levels', …)` to `src/main/logs.cjs`. Useful for diagnosing "mic seems quiet" reports without recording audio.
- Gate the per-segment log behind a `voice.logLevels` setting (default off in v1) — this is diagnostic, not product telemetry.

## Testing Plan

- **Unit:** Pure RMS function tested with synthetic Uint8Arrays (silence = 0, full-scale square = 1, sine peak ≈ 0.707).
- **E2E (Playwright + Electron + xvfb + fake-audio, per repo MEMORY):** Reuse the WAV fixture from the existing mic test. Assertions:
  - During fake-audio playback, `__voice.getState().micLevel > 0.05` for ≥ 80 % of frames sampled at 4 Hz.
  - After `stopRecording`, `micLevel === 0` and the meter element is detached from the DOM.
  - Track lifecycle: `stream.getAudioTracks()[0].readyState === 'ended'` post-stop.
- **Visual regression:** Screenshot the recording row at 0 %, 50 %, 95 % synthetic levels (drive `useVoice.setState({ micLevel })` directly from a test hook).
- **Memory:** Run 50 record/stop cycles and assert `performance.memory.usedJSHeapSize` growth < 5 MB and active `AudioContext` count returns to 0.

## Alternatives Considered

1. **System tray indicator only.** Rejected: the tray is far from the record button and disappears on minimize. Users would still get the silent-hot-mic failure mode.
2. **OS-level mic indicator only (Chromium tab dot, macOS menu-bar indicator).** Rejected: present on every page that has ever had mic permission, doesn't move with input level, and is invisible when the Electron window is focused over the menu bar. Privacy-good but UX-insufficient for "is it hearing me?"
3. **Reuse MicVAD's `onFrameProcessed` callback** (it exposes per-frame Float32 frames already). Rejected: would couple the meter to VAD frame cadence (~30 Hz at 16 kHz / 512-sample frames), and we'd duplicate RMS work the AnalyserNode does in C++. Lifting `getUserMedia` is cleaner and gives F5/F6 the same hook.

## Open Questions

1. Should clip detection auto-suggest a system mic-gain reduction, or just warn? (Lean: warn only — gain is the OS's job.)
2. Do we want the optional thin waveform behind the bar in v1, or is the RMS bar sufficient until users ask? (Lean: ship RMS only.)
3. Should `micLevel` live on the existing `useVoice` store or a separate high-frequency store to avoid waking unrelated subscribers 60×/s? (Lean: separate store / selector with shallow equality — measure first.)
4. Telemetry default: off (privacy) or on (diagnostics)? Need product call.

---

### Sources

- [Web Audio AnalyserNode level meter guide (addpipe)](https://blog.addpipe.com/understanding-audio-frequency-analysis-in-javascript-a-guide-to-using-analysernode-and-getbytefrequencydata/)
- [Building a real-time mic level meter (dev.to)](https://dev.to/tooleroid/building-a-real-time-microphone-level-meter-using-web-audio-api-a-complete-guide-1e0b)
- [MDN: AnalyserNode](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)
- [MDN: Visualizations with Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)
- [@ricky0123/vad-web — npm](https://www.npmjs.com/package/@ricky0123/vad-web)
- [ricky0123/vad — browser user guide](https://docs.vad.ricky0123.com/user-guide/browser/)
- [standardized-audio-context #410 — AudioContext memory leak](https://github.com/chrisguttandin/standardized-audio-context/issues/410)
- [WebAudio/web-audio-api #904 — stop/disconnect doesn't free memory](https://github.com/WebAudio/web-audio-api/issues/904)
- [WebAudio/web-audio-api #2484 — MediaStreamAudioSourceNode leak](https://github.com/WebAudio/web-audio-api/issues/2484)
