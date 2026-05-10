# F4 Barge-In — Implementation Critique (v2 PRD vs code)

## Verdict

Implementation is **substantially aligned** with the v2 PRD's contract. The decision matrix is honored, `lastBargeInAt` TTL gating works, ducking is wired through real `setOptions` mutation that the FrameProcessor reads each frame. However: (a) `onSpeechStart` triggers on Silero's *early* `SpeechStart` (first frame above threshold) rather than the more conservative `SpeechRealStart`, increasing TTS-misfire risk; (b) a TOCTOU window exists where TTS can start *before* `attachVadDucking` runs; (c) the `utterance.onerror` handler doesn't filter `'canceled'`, contradicting PRD §Edge 12 expectations; (d) AEC `additionalAudioConstraints` was silently dropped — that's fine because MicVAD already enables EC/AGC/NS by default (`real-time-vad.js:63-65`), but the PRD should be amended.

## Severe issues

1. **`SpeechStart` vs `SpeechRealStart` confusion** — `speechRecognition.ts:202` wires the early `onSpeechStart`. In `frame-processor.js:128-130`, `SpeechStart` fires the very first frame `isSpeech >= positiveSpeechThreshold` — no `minSpeechMs` gate. `SpeechRealStart` only fires after 250 ms confirmation (`frame-processor.js:132-136`). The PRD's "≤400 ms p50" budget assumed the early signal, so this is what we want for latency, but every transient blip above 0.5 will now cancel TTS. The `onVADMisfire` path (`speechRecognition.ts:212`) does NOT roll back the TTS cancel. PRD §Edge 2 acknowledges "VAD misfire — TTS cancelled — acceptable cost", but the implementation has no logging tying a misfire back to a recent barge-in (PRD §Telemetry promised `barge-in.misfire`). **Missing.**

2. **`utterance.onerror` not filtered** — `speechSynthesis.ts:62-67` clears `speakStartedAt` and notifies end on **any** error, including the `canceled` event Chrome fires after every `cancel()` call. PRD §Edge 12 explicitly says filter `'canceled'` in F3 logging — but the larger problem here is that `notifyEnd()` will fire twice on barge-in: once via `stopSpeaking()` (line 75) and again via `onerror` for the canceled utterance. `vadDucking` will then run `setVadThresholds(restored, restored)` while VAD should still be in normal mode — benign duplicate, but ensures duck-off is logged twice. Filter `e.error !== 'canceled'`.

3. **TOCTOU on attach order** — `voice.ts:213-216`: `handle.start()` is awaited only inside the function (it's `async` but the call is fire-and-forget — no `await`), then `attachVadDucking(handle)` is called synchronously. If a `speak()` call (from a streamed assistant message that arrives in the same tick) starts TTS before MicVAD's worklet boots, `onSpeakStart` will fire before there's a listener — ducking missed for that utterance. `vadDucking.ts:29` handles the *already-speaking-on-attach* case but only sets thresholds; it does NOT know whether the in-flight utterance has *already* fired its `onstart`. Acceptable for cold-start, but the `handle.start()` being un-awaited (`voice.ts:213`) means `setVadThresholds` calls inside `vadDucking.ts:33-39` no-op (`vad` is null in `speechRecognition.ts:245`) until init resolves. Symptom: ducking silently disabled for the first ~300-800 ms after `startRecording`.

## Moderate issues

4. **Decision matrix item 1 — correct.** `voice.ts:177-186` only sets `lastBargeInAt` and logs `barge-in` when `ttsWasSpeaking`; otherwise logs `barge-in.no-op` and leaves the TTL untouched. Matches PRD §Decision matrix exactly.

5. **`speakStartedAt` race after `stopSpeaking()`** — Question 11. `stopSpeaking()` clears `speakStartedAt = null` (`speechSynthesis.ts:74`). If a queued utterance kicks off afterward (Chromium 1176078 flake), its `onstart` re-sets `speakStartedAt` (line 51) and `notifyStart()` re-arms ducking. Subsequent barge-in computes `utteranceOffsetMs` from this *post-cancel* anchor, which is misleading telemetry — but the TTL gate in `useVoiceTTS.ts:23` blocks new `speak()` calls for 1500 ms, so the residual is bounded. Keep, but consider clamping offset to `null` when `lastBargeInAt < speakStartedAt`.

6. **Multi-tab semantics — correct.** `stopSpeaking()` -> `window.speechSynthesis.cancel()` is a global singleton, so cancellation is tab-agnostic. `tabId` is closed over in `voice.ts:176` -> log line 183. Transcripts route to the recording tab (`voice.ts:195`). PRD §Multi-tab satisfied.

7. **`utterance.onend` heuristic** — `speechSynthesis.ts:56-61` checks `!speechSynthesis.speaking` before clearing. Question 4: there is a transient window between one utterance's `onend` and the next utterance's actual playback where `speaking` *can* read `false` in Chrome. If true, `notifyEnd()` would fire spuriously, ducking is lifted, then the next `onstart` re-ducks — VAD threshold flaps for ~1 frame. Cost: one frame at the lower threshold while TTS is technically still playing. Probably below the noise floor but fragile. A timestamp-based debounce (e.g., suppress `notifyEnd` if a `notifyStart` occurs within 100 ms) would be more robust.

8. **AEC dropped, undocumented** — Question 13. PRD §Best-effort AEC says pass `additionalAudioConstraints`. That option doesn't exist in this MicVAD version (`real-time-vad.js:55-91`); EC/AGC/NS are baked into the default `getStream`. So the requirement is *already met* by the library default. PRD should be edited to say "library default — no action needed" rather than leaving it as a missing TODO.

## Minor / nits

9. **Listener-stacking risk** — Question 9. `attachVadDucking` is called once per `startRecording` (`voice.ts:215-216`), and the prior `detachVadDucking?.()` runs first. `stopRecording` (line 229) also detaches before nulling. The only path that doesn't detach is `onError` (line 200-205), which destroys the handle but leaves `detachVadDucking` non-null. **Bug:** an error during recording leaks one start/end listener pair, and the next `startRecording` adds another. Fix: clear `detachVadDucking` in the `onError` path too.

10. **TTL-gate race** — Question 10. `useVoiceTTS.ts:21-28`: gate read at speak()-entry. If `ev.kind === 'message'` arrives, gate passes (last is null), `speak()` is called, then user barges in 5 ms later — `stopSpeaking()` cancels mid-utterance, `lastBargeInAt` set, behavior is exactly correct. No issue.

11. **`isRecording` -> `stopSpeaking()` effect** — `useVoiceTTS.ts:51-53` calls `stopSpeaking()` when `isRecording` flips on. This is the click-stop fast path PRD §15 documents as pre-existing. Side effect: it *also* clears `speakStartedAt` and notifies end, so any in-flight VAD `onSpeechStart` that fires within milliseconds will see `ttsWasSpeaking === false` and log `barge-in.no-op`. The user's barge-in is silently relabeled as "no-op". Telemetry hazard, not a UX bug. Consider logging differently when `stopSpeaking` was called by the recording-flip vs natural barge-in.

12. **`onError` cleanup** — Question 5. `vad.destroy()` makes `vad = null` (`speechRecognition.ts:240`); subsequent `setVadThresholds` calls return at line 245. Correct. The leak is on the listener side (#9), not the VAD side.

13. **Tests/E2E** — Question 12. Stubbing `window.speechSynthesis` is straightforward because all access goes through `speechSynthesis.ts` exports. The module-level `startListeners` / `endListeners` Sets are accessible only via `onSpeakStart` / `onSpeakEnd`; tests must drive notifications by stubbing `window.speechSynthesis.speak` to invoke `utterance.onstart` directly. No explicit test seam for `speakStartedAt`. Consider adding a `__resetForTest()` export.

## Concrete fixes for v2

1. **`speechSynthesis.ts:62`** — filter `if (e.error !== 'canceled')` before clearing/notifying; or split: clear `speakStartedAt` always, but only `notifyEnd()` on non-canceled errors (cancel goes through `stopSpeaking`).
2. **`voice.ts:204`** — in the `onError` callback, also `detachVadDucking?.(); detachVadDucking = null` to fix #9.
3. **`voice.ts:213`** — `await handle.start()` (make `startRecording` async) OR thread the start-promise into `attachVadDucking` so threshold updates queue until VAD is live. Closes #3.
4. **`speechRecognition.ts:202`** — emit a debug log on the early `SpeechStart` fire and add an `onSpeechRealStart` hook for callers who want the confirmed signal. Optional setting in voice state to choose latency vs accuracy.
5. **`speechRecognition.ts:212`** — wire `barge-in.misfire` log when `onVADMisfire` fires within 600 ms of a recent `lastBargeInAt`. Promised in PRD §Telemetry.
6. **`speechSynthesis.ts:56`** — debounce `notifyEnd` by 100 ms or check whether another utterance is queued (`window.speechSynthesis.pending`) before notifying end. Closes #7.
7. **PRD edit** — strike `additionalAudioConstraints` line in §Best-effort AEC; replace with note that MicVAD's default `getStream` already enables EC/AGC/NS (`real-time-vad.js:60-67`).
8. **`useVoiceTTS.ts:52`** — when the `isRecording`-flip fires `stopSpeaking()`, set `lastBargeInAt = performance.now()` too. Otherwise streaming chunks resume immediately after a click-stop, defeating the TTL contract for the click path.
