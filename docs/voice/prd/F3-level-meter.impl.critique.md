# F3 mic-level meter — implementation critique vs PRD v2

Status: review of the v1 cut landed in `src/renderer/{lib/speechRecognition.ts,components/MicLevelMeter.tsx,state/voice.ts,components/LeftNav.tsx}` against `docs/voice/prd/F3-level-meter.v2.md`.

## Verdict

Ships. The hot path is correct: AnalyserNode is owned by `speechRecognition.ts`, sink-only off the F5-owned stream, the rAF loop hoists its buffer, RMS math is right, raw RMS drives colour, and the `useEffect` cleanup is honest. The v1 cut consciously defers `track.onended`, `visibilitychange`, `aria-live`, the env override, and the Settings UI, all reasonable and tagged in `MicLevelMeter.tsx:27-31`. Two real problems: the `pow(rms,0.4)*1.2` cosmetic curve saturates at raw RMS ≈ 0.58 — exactly the PRD critique that landed in v2 §UX (`pow(rawRms,0.4)*1.2`, same curve) — and `aria-valuenow` updates every rAF instead of the PRD's 4 Hz `setInterval`. Minor: `smoothingTimeConstant=0.8` is laggier than spec'd, the analyser isn't gated by `levelMeterEnabled` at construction, the `getAnalyser` getter masks a TS hygiene issue, and StrictMode double-mount is benign but worth a note.

## Severe issues

**1. Display saturation at raw 0.58 (PRD §UX, `MicLevelMeter.tsx:85`).** `Math.min(1, Math.max(0, Math.pow(rms,0.4)*1.2))` hits 1.0 when `pow(rms,0.4) ≥ 0.833`, i.e. `rms ≥ 0.833^2.5 ≈ 0.578`. Anything from there to clip pegs the bar full and the user loses headroom feedback in exactly the band where amber→red matters. The PRD repeats the same formula in §UX step 3, so the impl is faithful — but this is the v1 critique landing un-fixed. Fix: drop the `*1.2`, or split: bar width on `pow(rms,0.4)` (max 1.0 at full scale), keep colour thresholds where they are.

**2. `aria-valuenow` updated 60 Hz (`MicLevelMeter.tsx:120`).** PRD §UX step 5 explicitly says "updated at 4 Hz via `setInterval`". The current code re-renders `aria-valuenow={Math.round(rawLevel * 100)}` on every `setRawLevel`, which is every rAF. Screen readers that announce live `meter` value changes will spam the user, and React reconciles a DOM attribute write 60×/s for nothing. Fix: gate aria writes on a separate `setInterval(250 ms)` reading a ref, or only update when `Math.round(raw*100)` changes by ≥5.

## Moderate issues

**3. Disposal order matches PRD partially, drifts on track-stop (`speechRecognition.ts:338-369`).** PRD §Disposal sequence: `vad.pause → vad.destroy → analyser.disconnect → source.disconnect → tracks.stop → audioContext.close()`. Impl: `vad.pause → drain → vad.destroy → analyser.disconnect → source.disconnect → audioContext.close → tracks.stop`. Tracks stop **after** `close()` here, PRD wants tracks stopped **before** `close()`. The in-code comment at `:331-337` even spells out a different order ("close → stop tracks") than what the PRD prescribes. In practice both work — `close()` doesn't synchronously yank the tracks — but per the PRD, swap the last two. The `try/catch` around `close()` is correct (`:363`); `disconnect()` is wrapped too (`:355,359`), so `InvalidStateError` after a stale close is swallowed cleanly.

**4. `smoothingTimeConstant: 0.8` vs PRD 0.3 (`speechRecognition.ts:252`).** Drift is acknowledged in the inline comment (`:241-247`). 0.8 is laggy: the EMA half-life at 60 Hz with α=0.2 is ~3 frames, so visible response to a transient is ~50 ms behind the audio. For an *ear-validation* meter that's borderline OK, but the PRD picked 0.3 deliberately so transients show up. Either land 0.3 to match PRD or amend the PRD.

**5. `levelMeterEnabled` is render-only, not construction-gated (`speechRecognition.ts:248-260`, `voice.ts:59-66`).** PRD §Feature flag: "When disabled: meter does not mount, `speechRecognition.ts` skips analyser construction, `getAnalyser()` returns `null`." The analyser is wired unconditionally in `start()`; only the component checks `enabled` (`MicLevelMeter.tsx:35,46`). Cost is small (one Analyser node, ~2 KB internal buffers), but PRD success criterion 7 ("Flag off → no analyser") fails as written. The TODO at `voice.ts:62-65` admits this. Pipe `levelMeterEnabled` through `RecognitionCallbacks` and skip the analyser block when false.

**6. No `track.onended` wiring (`speechRecognition.ts:235`).** PRD §Permission revoked is explicit: `stream.getAudioTracks()[0].onended = () => onPermissionLost()`. Impl never sets it. Visual consequence: if the OS revokes mic permission mid-recording, the `MediaStream` tracks go to `ended`, `getByteTimeDomainData` returns the last buffer (which decays to 128 after smoothing) and the bar parks at ~0 forever. `isRecording` stays true; the user sees a green-but-still bar and no error. Tagged as deferred at `MicLevelMeter.tsx:30`, but it's also Success Criterion 6 ("toggling OS mic permission flips `isRecording` to false within 500 ms"). This is shipping-blocker territory if SC6 is enforced.

## Minor / nits

**7. rAF cleanup is correct (`MicLevelMeter.tsx:96-103`).** `cancelled` flag plus `cancelAnimationFrame(raf)` plus `setTimeout` cleanup: clean. No stale closure — `latchedAnalyser`/`buf` are loop-locals re-created each effect run. Buffer is hoisted out of the rAF body (`:58, :71`), allocated once on first non-null analyser. Good.

**8. Null-analyser handling is correct (`MicLevelMeter.tsx:63-67`).** Polls each frame until `getActiveAnalyser()` returns non-null, then latches at `:69-72`. No crash, no spin — bounded by the time `start()` takes (≤ a few hundred ms with model warm).

**9. StrictMode double-mount (`MicLevelMeter.tsx:45`).** Dev-only StrictMode would mount the effect twice. Each mount has its own `cancelled`/`raf`, the first cleanup runs before the second mount's effect, so only one rAF is live at steady state. Benign. If concerned, add a single shared `useRef<number>` keyed off the analyser identity.

**10. F4 ducking interaction.** Correct: `setVadThresholds` (`speechRecognition.ts:372`) only mutates VAD thresholds via `vad.setOptions`. The Analyser node is on the same stream regardless, so the meter shows real input during TTS — which is the desired behaviour for self-talk visibility.

**11. F5 device switch.** Correct rebuild path. `stopRecording` (`voice.ts:345`) tears down the handle (analyser disconnected, context closed, tracks stopped) and `startRecording` (`voice.ts:233`) builds a fresh `RecognitionHandle` with a fresh AnalyserNode on a fresh `AudioContext`. `MicLevelMeter`'s effect re-runs on `isRecording` flip and re-latches.

**12. Stream-ownership PRD drift (`speechRecognition.ts:236-260`).** Clean. F3 hooks the analyser onto F5's owned context (`ownedAudioCtx`), no parallel context, no second `getUserMedia`. Source is created on the owned stream, analyser added next to MicVAD's worklet sink. Matches PRD §Stream and AudioContext ownership.

**13. TS hygiene.** `as RecognitionHandle` cast at `speechRecognition.ts:414` is slightly sloppy — the object literal already has the right shape. `(audioConstraints as MediaTrackConstraints & { deviceId?: ConstrainDOMString })` at `:232` is the only `as` widen-cast and is justified. `e: unknown` is used consistently in catches. `Uint8Array<ArrayBuffer>` typing at `MicLevelMeter.tsx:58` is the right call to satisfy `getByteTimeDomainData`'s lib.dom.d.ts signature.

**14. Clip flash UX.** `ring-1 ring-red-500` (`MicLevelMeter.tsx:125`) on a 4 px-tall bar is visible but small. PRD §UX step 3 says "outline flash" plus an `aria-live` warning; `aria-live` is deferred. On light theme `bg-bg` may not contrast strongly with `ring-red-500`; visual regression baselines should cover both themes.

**15. Clip threshold mismatch.** PRD §UX step 3 wants `max(|x − 128|) ≥ 125` (per-sample peak). Impl uses `rms >= 0.95` (`MicLevelMeter.tsx:88`). RMS 0.95 ≈ peak ≥ 121 for a sine, ~127 for square — close but not the same metric. Compute peak alongside RMS in the same loop: O(0) extra cost.

## Concrete fixes for v2

1. **Fix bar saturation:** drop `*1.2` in `MicLevelMeter.tsx:85` so width is `Math.pow(rms, 0.4)` clamped — full scale at raw 1.0, not 0.58.
2. **Throttle aria:** add `useEffect(() => { const id = setInterval(() => setAria(rawRef.current), 250); return () => clearInterval(id) }, [])` and store `rawRef` from the rAF; bind `aria-valuenow` to `aria` state.
3. **Fix disposal order:** swap `audioContext.close()` and `tracks.stop()` in `speechRecognition.ts:362-369` to match PRD line 119-120.
4. **Smoothing:** set `analyser.smoothingTimeConstant = 0.3` at `speechRecognition.ts:252` or amend PRD; don't leave silent drift.
5. **Construction gate:** thread `levelMeterEnabled` into `createRecognition` opts; skip the analyser block at `:248-260` when false; satisfies SC7.
6. **Permission revoked:** wire `ownedStream.getAudioTracks()[0].onended = () => opts.onError('permission-revoked')` at `:236` and have `onError` in `voice.ts:292` flip `isRecording=false`. Satisfies SC6.
7. **Peak clip metric:** track `let peak = 0; ...; if (Math.abs(v) > peak) peak = Math.abs(v);` in the loop at `MicLevelMeter.tsx:78-81` and trigger flash on `peak >= 125`.
8. **Visibility hidden badge:** subscribe to `document.visibilitychange`, dim the bar via `opacity-30` + a "window hidden" tooltip; PRD §Edge Cases item 2.
9. **Drop the `as RecognitionHandle`** at `speechRecognition.ts:414` — type the returned literal directly.
