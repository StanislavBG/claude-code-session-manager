# F3 Level Meter — Adversarial Critique

Review date: 2026-05-02 (PDT). Pinned: `@ricky0123/vad-web@^0.0.30`.

## Verdict

Conditional accept. Core claim — lift `getUserMedia` + `AudioContext` into MicVAD — is supported: `audioContext?` and `getStream` exist (`real-time-vad.d.ts:32-33`); impl honours `ownsAudioContext = false` when supplied (`real-time-vad.js:216-223,312-313`). But the PRD has real lifecycle and coordination defects. Fix Severe items first.

## Severe issues

1. **F3↔F5 stream ownership is unowned.** `F5-device-picker.md:60-65` ships option (A) — `additionalAudioConstraints` — *unless F3 lands first*, in which case it switches to (B). F3 says the inverse in edge case 8. Both defer to the other. F3 *requires* lifted ownership; declare F3 source of truth and require F5 to thread `inputDeviceId` through F3's `getUserMedia` site.

2. **`audioContext.sampleRate: 16000` is a behaviour change.** MicVAD today builds `new AudioContext()` (default 48 kHz) and resamples internally via its `Resampler` (`real-time-vad.js:33,129`). Forcing 16 kHz pushes resampling into Chromium's `MediaStreamAudioSourceNode` — different (lower-quality) resampler than the VAD's, may shift VAD false-positive rate on sibilants. Either keep default 48 kHz (then "32 ms @ 16 kHz" comment is wrong — 10.7 ms @ 48 kHz, raise `fftSize` to 2048-4096), or A/B against the fake-audio fixture before locking it.

3. **Disposal ordering is missing `vad.destroy()`.** Listed: rAF cancel → `analyser.disconnect()` → `track.stop()` → `await audioContext.close()`. MicVAD's destroy still references the context (`real-time-vad.js:297,312`); closing first throws `InvalidStateError`. Required: `vad.destroy()` → `analyser.disconnect()` → `source.disconnect()` → `track.stop()` → `await audioContext.close()` in try/catch.

4. **rAF cancellation handle has no declared home.** Section 3.4 says "cancel the rAF id" without saying where it lives. 3.3 puts `<MicLevelMeter />` in `LeftNav.tsx` reading store, while rAF "owned by `createRecognition`" writes to it. PRD mixes "rAF in the lib" and "rAF in the component" — pick one.

5. **`destroyed` flag doesn't cross modules.** Edge 4 cites `speechRecognition.ts:94` ("verified pattern") — that flag is a per-call closure inside `createRecognition`. A sibling React component cannot read it. Expose a cancellation token through `RecognitionHandle`, or use `useEffect` cleanup; drop the claim.

## Moderate issues

6. **Silent-mic threshold unjustified.** RMS < 0.005 for ≥ 3 s vs. asserted "breath noise > 0.01" — no measurement. Quiet headset + treated room sits at 0.001-0.003 normalised; false-positives on calm users. Defer to v1.1 or calibrate.

7. **Clip threshold mixes display and raw spaces.** UX-3 says ≥ 0.90 amber, ≥ 0.98 red; Edge-5 says raw `max(|x−128|) ≥ 125` (≈0.977). The curve `display = pow(rms, 0.4) * 1.2` saturates at raw ≈ 0.58, so "0.90" in display space is meaningless. Spec thresholds in **raw RMS pre-curve** or dBFS; pick one.

8. **Performance budget cites no measurement.** "<0.3 % CPU at 60 Hz on a 2019 i5" is asserted. The dominant cost is `set({ micLevel })` waking subscribers (Open Q3) — not the FFT. rAF runs at display refresh, so 120 Hz panels double the work. Commit to a separate high-frequency store or drop the number.

9. **rAF throttling vs. privacy contract.** Edge 2 accepts 1 Hz when occluded; Security bullet 1 says meter MUST render while recording. A frozen bar plus a lit OS mic indicator reads as "meter broken". Handle `visibilitychange`: swap to static "Recording (window hidden)" badge.

10. **Visual-regression tooling unspecified.** Per MEMORY, infra is Playwright + Electron + xvfb. Spec `toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`, baselines under `e2e/__screenshots__/`, document xvfb-vs-macOS AA differences — this *will* flake.

11. **Test hook drift.** PRD asserts `__voice.getState().micLevel`. `voice.ts:135-141` exposes `__voice`/`__transcripts`. If Open Q3 lands as "separate store", the selector breaks. Resolve Q3 before writing the test plan.

12. **No test for the lifted-stream contract.** Edge 9's `readyState === 'live'` proves the track is open, not that MicVAD uses *our* stream. Spy on `navigator.mediaDevices.getUserMedia`, assert exactly one call per `startRecording`.

## Minor / nits

13. `pauseStream: async () => {}` ignores its arg (default impl stops tracks). Comment why: intentional no-op; cleanup happens in `destroy`.
14. `resumeStream: async () => stream` returns the original ref. After `track.stop()`, dead stream. Document: pause/resume only within one session.
15. `smoothingTimeConstant = 0.6` is sluggish; cited addpipe blog uses 0.3.
16. `bg-yellow-400` / `bg-red-400` on `text-fg-dim` fails WCAG under `prefers-contrast: more`.
17. Line-number refs (`voice.ts:10-26`, `LeftNav.tsx:122-128`) drift fast. Use symbol names.
18. "n is constant 1024" — say "amortised O(1) per frame" to match repo perf-comment style.
19. "aria-live once per session" — define session (start/stop pair vs VAD segment).
20. Telemetry `peakLevel`/`meanLevel` window undefined; per-utterance is the useful one.

## Suggestions for PRD v2

- Lock F3↔F5 ownership: F3 owns `getUserMedia`; F5 threads `inputDeviceId` through F3's site.
- Default to **not** setting `sampleRate`; if set, A/B the WAV fixture.
- Disposal as ordered list, `vad.destroy()` first, try/catch around `close()`.
- One rAF home — `createRecognition` owns it, component is a pure read.
- Replace `destroyed` flag claim with `useRef` + `useEffect` cleanup.
- Thresholds in raw RMS; curve only at render.
- `toHaveScreenshot` + `maxDiffPixelRatio`, CI-only baselines.
- Add a `getUserMedia` call-count test; defer silent-mic auto-warning to v1.1; handle `visibilitychange`; resolve Open Q3 before merge.

## Missing entirely

- **Permission revoked mid-recording.** macOS toggles live; wire `track.onended` to `onError`.
- **ScriptProcessor fallback.** MicVAD picks worklet vs ScriptProcessor at runtime (`real-time-vad.js:232`); document the worklet assumption.
- **PipeWire "Monitor of …" win** — cited in P&M, missing from a (also missing) Success Criteria section.
- **Acceptance bar.** Suggest: meter non-zero within 200 ms of `startRecording`; zero leaked AudioContexts after the 50-cycle test.
- **Feature flag.** Gate behind `voice.levelMeter` (default on); this touches the only working voice path.
