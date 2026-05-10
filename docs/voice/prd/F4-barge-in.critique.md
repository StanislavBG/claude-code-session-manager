# F4 Barge-in — Adversarial Critique

## Verdict

The PRD has a credible core design but materially underestimates three risks: VAD-onset latency, AEC honoring through MicVAD's custom AudioContext, and tab/PTY scoping of the barge-in side effects. The "<200 ms" claim is not achievable with `onSpeechStart` alone given the configured `minSpeechMs: 250` and `preSpeechPadMs: 300` in `speechRecognition.ts:166-170`. Several edge cases marked "verify in QA" are load-bearing for the design and should be resolved before build, not after. Recommend a v2 pass before implementation.

## Severe issues

**S1. `onSpeechStart` is not <100 ms.** `@ricky0123/vad-web` fires `onSpeechStart` once `positiveSpeechThreshold` (0.5) is crossed for at least one frame, but the Silero v5 model runs on 32 ms frames and the callback typically fires 100–200 ms after voicing onset; combined with the user's `minSpeechMs: 250` (which Silero internally enforces before classifying), the practical barge-in latency is 200–400 ms, not the 30–100 ms claimed in §UX Flow step 3. The PRD's <200 ms QA criterion (§Testing) is essentially the *floor*, not a comfortable target. The PRD must either (a) acknowledge this honestly, (b) introduce a tighter pre-trigger signal — e.g. a raw RMS gate on the AudioWorklet upstream of the VAD model, firing a "tentative barge-in" within ~30 ms then committing/reverting on VAD confirmation, or (c) lower `positiveSpeechThreshold`/`minSpeechMs` *only while TTS is speaking*.

**S2. AEC through MicVAD is unverified and probably partial.** `@ricky0123/vad-web` builds its own `AudioContext` and routes `getUserMedia` through an `AudioWorkletNode`. Chrome's AEC is applied at the `MediaStreamAudioSourceNode` boundary only when the audio graph plays out through a `MediaStreamAudioDestinationNode` *connected to the same logical session* — when a custom AudioContext is created and TTS plays via `window.speechSynthesis` (which uses a **completely separate** OS-level audio path outside the page's AudioContext), Chrome cannot reference-cancel TTS at all. `additionalAudioConstraints: { echoCancellation: true }` will be honored on the track, but the reference signal it cancels against is the page's WebAudio output, not Web Speech output. Net effect: AEC is largely a no-op for this loop. §Self-talk feedback loop treats AEC as a primary mitigation; it is not. This needs to be either tested empirically before adoption or replaced with a real mitigation (mic mute during TTS, ducking, headphones-required disclaimer, or `chrome.audioCapture` reference).

**S3. Multi-tab / wrong-PTY scoping.** `useVoiceTTS` is keyed on `activeTabId` (`useVoiceTTS.ts:9`) and the recognition handle's `onFinal` closes over `tabId` from `startRecording(tabId)` (`voice.ts:91`). If TTS is speaking for tab A, the user switches to tab B (which tears down the tab-A subscription but `window.speechSynthesis.speaking` is still true because it is a global singleton), then speaks while `isRecording` is true with the tab-B handle, the barge-in correctly cancels TTS but the resulting transcript goes to tab B — fine. However, if the user starts recording on tab A, switches to tab B (without stopping recording — does the UI even allow this?), TTS for tab B begins, user speaks, barge-in cancels tab-B TTS but transcript appends to tab A. The PRD §Edge 10 dismisses this with "correct" without analysis. The "out of scope: cross-tab barge-in" line in §Scope conflicts with §Edge 10. Pick one and reason it through.

**S4. `bargedInThisTurn` lifetime is wrong for streamed responses.** Claude streams; `useVoiceTTS.ts:24` calls `speak()` once per assistant message event, but a single assistant turn can produce N message events (e.g. tool-use interleaved with text). The PRD says "cleared on next `startRecording` and on `onFinal`". `onFinal` is the *user's* transcription completing — that races against the *next* assistant message arriving. If Claude streams a follow-up before `onFinal` resolves (Whisper takes 200–800 ms), the flag still blocks the legitimate next turn. Conversely, if `onFinal` resolves before Claude's next assistant message, the flag is cleared and a late-arriving leftover `speak()` from the bargèd turn slips through anyway. The flag needs a TTL or to key off `speakStartedAt` per turn, not boolean.

## Moderate issues

**M1. `speakStartedAt` for telemetry is wrong granularity.** §Telemetry computes `utteranceOffsetMs = performance.now() - speakStartedAt`. That is the time since `speak()` was called, not the offset *into the spoken audio*. `speechSynthesis.speak()` returns immediately; actual playback start fires `utterance.onstart` (often 50–500 ms later, especially on first speak — the iifx.dev source you cited covers this exact flake). Use `onstart`, and combine with `onboundary` events (which fire per word/sentence with `charIndex`) to compute the more useful "interrupted at word N of M" metric. The PRD's question 9 about boundary events is half-answered: `boundary` works in Chrome for `name: 'word'` but is unreliable in Safari and absent for the eventual macOS native voices. Document the fallback.

**M2. Hard-stop tail.** §Open Q1 dismisses fade. Chrome's `cancel()` flushes the queue but the OS audio device buffer still drains — typically 20–80 ms of TTS continues after `cancel()` returns. With AEC unreliable (S2), that tail is enough to re-trigger VAD. Worth at least mentioning as a known artifact and gating barge-in re-fire with a 150 ms cooldown window.

**M3. `submitUserSpeechOnPause: true` interaction.** When `stopSpeaking()` cancels TTS and the user is mid-utterance, that's fine; but if the user *intended* to barge in and then immediately stops talking (false-start), `submitUserSpeechOnPause` will flush a partial segment to Whisper anyway, producing a junk transcript that — with `autoSend` on — gets typed into the PTY. §Edge 2 mentions misfires but not this combined failure mode.

**M4. `defensive cancel()` before every `speak()` (§Edge 6).** This actively breaks the streaming case. If two assistant text chunks arrive 50 ms apart, the second `speak()` calls `cancel()` first, killing the first chunk mid-word. The PRD prescribes this as a fix to a Chrome bug but doesn't reconcile it with the streaming reality in `useVoiceTTS.ts:25-31`. Either queue is preserved or it isn't.

**M5. Push-to-talk + barge-in race.** §Edge 8 says "holding the button silently doesn't" trigger barge-in. True — but the *act of pressing* the PTT button before F2 is implemented currently flips `isRecording`, which already calls `stopSpeaking()` at `useVoiceTTS.ts:38`. So today, in PTT, TTS stops on key press, not on VAD. F4 doesn't change that. The PRD should explicitly state which signal wins (it's the click-stop today, not VAD), and whether F2 is expected to remove the click-stop in favor of VAD-only — which would *regress* perceived latency for users who want immediate cut-off.

**M6. `ttsEnabled` toggled mid-utterance (§Edge 11) is flagged as out-of-scope, but it changes F4's contract.** If TTS is disabled mid-stream and re-enabled, the `bargedInThisTurn` flag state is undefined.

## Minor / nits

- §Scope: "no-op when TTS isn't speaking" — `cancel()` is already a no-op in that case; the PRD adds a `bargedInThisTurn` flag set even when TTS wasn't speaking, which then suppresses the *next* legitimate `speak()`. This is a real bug, not a nit. Promote to Moderate if confirmed.
- §Integration points line "voice.ts:82" — the `onSpeechStart` callback would need access to `tabId` for the telemetry payload, which means it must be a closure created inside `startRecording`, not the static-import pattern the snippet implies.
- §Alternatives 1 (threshold ducking) is rejected as "ad-hoc tuning" but is precisely the right primitive when AEC is unreliable (see S2). The rejection rationale is backwards.
- §Testing E2E: the WAV fixture is "1s silence + 1s speech" — `minSpeechMs: 250` + `redemptionMs: 600` means `onSpeechEnd` fires ~600 ms after the speech ends, so the test must wait ≥1.6 s before asserting transcript. Spell that out.
- §Sources cite a Chromium bug 1176078 but the linked URL is `bugs.chromium.org` which redirects to `crbug.com/1176078` — fine, but verify the bug is still extant (it has been fixed in recent Chromium iirc).
- "Verify in QA at >50% internal-speaker volume" — needs a specific dB target or a reproducible setup, otherwise it isn't a falsifiable acceptance criterion.

## Suggestions for PRD v2

1. **Replace the AEC mitigation claim** with empirical numbers: build a 10-line probe page that plays a tone via `speechSynthesis.speak()` and logs VAD `onSpeechStart` rate at three speaker volumes. Either AEC works (in which case keep §1) or it doesn't (mute mic during TTS or duck threshold).
2. **Add a fast-path RMS gate** on the AudioWorklet level for sub-100 ms barge-in; commit/revert based on subsequent VAD confirmation. Telemetry: false-positive rate of the fast path.
3. **Re-spec `bargedInThisTurn`** as `lastBargeInAt: number | null` with a 1500 ms TTL, ignored after that. Streaming-safe.
4. **Define wrong-tab semantics explicitly**: if the user speaks while TTS is playing for a non-active tab, does the transcript route to the recording tab or the TTS tab? Today it's the former (mic owner). State this.
5. **Drop the `defensive cancel()` recommendation** or reconcile it with streamed `speak()` calls.
6. **Use `utterance.onstart` and `onboundary`** for telemetry, not `speak()` invocation time.
7. **Add an acceptance latency budget** — e.g. p50 ≤250 ms, p95 ≤500 ms — measured from synthetic speech onset to `speechSynthesis.speaking === false`.
8. **Resolve the §Scope vs §Edge 10 contradiction** on cross-tab barge-in.
