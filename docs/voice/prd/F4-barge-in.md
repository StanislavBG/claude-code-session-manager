# F4 — Barge-in for TTS

Status: draft
Owner: voice
Depends on: F1 (mic capture + VAD), F3 (TTS playback)

## Problem & Motivation

When `ttsEnabled === true`, Claude's assistant turns are spoken via the Web Speech API (`src/renderer/lib/speechSynthesis.ts:34`, wired in `src/renderer/lib/useVoiceTTS.ts:16`). Today the user must wait for TTS to finish — clicking mic mid-sentence does stop speech (`useVoiceTTS.ts:38`), but only because `isRecording` flips on click, not because the user said anything. If `isRecording` is already true (push-to-talk) and the user speaks while Claude is being read aloud, the mic captures voice overlapped with TTS audio and Whisper hears garbage.

Production voice agents treat barge-in as non-negotiable; sub-100 ms cut-off is the bar for "feels human" (Sources). We want Silero VAD's `onSpeechStart` as the trigger: the moment VAD confirms voiced speech, the current utterance stops.

## Scope

In scope: cut TTS on VAD-confirmed `onSpeechStart` while `isRecording` is true; log every barge-in with offset into the utterance; no-op when TTS isn't speaking.

Out of scope: resuming TTS after the user finishes (text remains in transcript; resume requires offset bookmarking + re-queuing — rarely wanted); stopping TTS on mere mic activation without VAD-confirmed speech (`useVoiceTTS.ts:37-39` already handles that); turn-taking models (prosody/semantic — pure VAD sufficient for v1); cross-tab barge-in.

## UX Flow

1. Claude streams an answer; TTS begins speaking.
2. User taps mic (or push-to-talk hotkey, post-F2). `isRecording` flips true.
3. User starts speaking. ~30-100 ms later VAD's `onSpeechStart` fires.
4. Current `SpeechSynthesisUtterance` is cancelled mid-word; audio cuts abruptly.
5. Mic indicator already shows "Listening…" (`speechRecognition.ts:174`).
6. Whisper transcribes on `onSpeechEnd` and text is sent to the active PTY tab.

Hard stop is acceptable for v1; 100 ms fade is in Open Questions. No banner or toast — audio cut is the feedback. No auto-resume; the rest of the assistant message remains in the transcript.

## Technical Design

### Where to call `stopSpeaking()`

Three options: (a) inline in `speechRecognition.ts` `onSpeechStart` — lowest latency but couples the speech-recognition layer to TTS; (b) callback into `createRecognition` — pure layer, one more plumb; (c) voice-store callback — same as (b). **Decision: (b)/(c)**, which collapse into the same change.

Add optional `onSpeechStart?: () => void` to `RecognitionCallbacks` (`speechRecognition.ts:15`). Wire from the VAD callback (`speechRecognition.ts:172-175`) alongside the existing `onInterim('Listening…')`. In `voice.ts:82` pass `onSpeechStart: () => stopSpeaking()` (import from `../lib/speechSynthesis`). The recognition layer stays TTS-agnostic; the store brokers both, mirroring how `onFinal` is plumbed today.

### Race: `stopSpeaking()` while another `speak()` is queued

`window.speechSynthesis.cancel()` clears the entire queue (spec). Streamed assistant messages can land several `speak()` calls in flight (`useVoiceTTS.ts:30`); cancelling all of them is what we want — the user has the floor.

Edge: a `speak()` call arrives *after* `stopSpeaking()` because its transcript event was a tick late. Fix: add `bargedInThisTurn: boolean` to the voice store, set on barge-in, cleared on next `startRecording` and on `onFinal`. `useVoiceTTS.ts:24` checks it before calling `speak()`.

### Self-talk feedback loop

Central risk. TTS through laptop speakers reaches the mic, VAD trips (`positiveSpeechThreshold: 0.5`, `speechRecognition.ts:166`), barge-in cancels TTS, but VAD already buffered Claude's own voice and Whisper transcribes it as a prompt. Layered mitigation:

1. **`echoCancellation: true`** in the VAD's `getUserMedia` constraints via `additionalAudioConstraints`. Default-on in modern Chrome, but be explicit (Sources).
2. **Gate barge-in on `isRecording`** — passive speakers-on never triggers it.
3. **NoiseSuppression + AGC** also true (default-on). We do *not* duck VAD threshold during TTS — fights AEC, adds state.

### Integration points

- `speechRecognition.ts:15` — add `onSpeechStart?: () => void` to `RecognitionCallbacks`.
- `speechRecognition.ts:172-175` — invoke `opts.onSpeechStart?.()` alongside `onInterim`.
- `speechRecognition.ts:158` — pass `additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }` to `MicVAD.new`.
- `voice.ts:82` — `onSpeechStart: () => { stopSpeaking(); set({ bargedInThisTurn: true }); log.info('voice', 'barge-in', { ttsWasSpeaking: isSpeaking() }) }`.
- `voice.ts` — add `bargedInThisTurn` to `VoiceState`; reset on `startRecording` and `onFinal`.
- `useVoiceTTS.ts:24` — also bail if `useVoice.getState().bargedInThisTurn`.

## Edge Cases & Failure Modes

1. **Self-talk loop (speakers).** TTS leaks into mic → infinite cancel. Mitigated by `echoCancellation: true` + `isRecording` gate. Verify in QA at >50 % internal-speaker volume.
2. **VAD misfire** (`speechRecognition.ts:181`): brief noise tripped `onSpeechStart`, no real utterance follows. TTS already cancelled — acceptable v1 cost; log `barge-in.misfire`.
3. **Barge-in during model load.** Mic isn't capturing yet (`speechRecognition.ts:143-148`); `onSpeechStart` cannot fire. No-op.
4. **Multiple queued utterances.** `cancel()` clears the queue — desired; user wants the floor.
5. **Headphones.** No echo path; `echoCancellation` irrelevant. `isRecording` gate still applies. Verify in QA.
6. **Browser still speaking after `cancel()`** (documented Chrome flake, Sources). Mitigation: prefix every `speak()` with a defensive `cancel()` (no-op on empty queue).
7. **TTS finished naturally just as user starts speaking.** `isSpeaking()` false → `cancel()` is no-op. Log `barge-in.no-op`.
8. **Push-to-talk held during TTS (post-F2).** Same VAD path — only voiced speech triggers barge-in; holding the button silently doesn't.
9. **`autoSend` interaction.** Audio cancels; text still flows through `onFinal` to PTY (`voice.ts:84-91`). Unchanged.
10. **Multi-tab.** `useVoiceTTS` subscribes per `activeTabId` (`useVoiceTTS.ts:14`). Tab switch tears down the subscription. `window.speechSynthesis` is global, so barge-in still cancels in-flight utterances regardless of tab — correct.
11. **`ttsEnabled` toggled off mid-utterance.** `useVoiceTTS.ts:37` only calls `stopSpeaking()` on `isRecording` change. Adjacent bug — out of scope for F4 but flag.
12. **`SpeechSynthesisErrorEvent` after cancel.** Chrome fires `error: 'canceled'`. If F3 adds utterance error logging, filter `'canceled'` out.

## Security & Privacy

None specific. Mic is already requested per F1; no new audio leaves the machine. TTS uses only the local Web Speech API.

## Telemetry & Logging

Via `src/renderer/lib/logger.ts` → `src/main/logs.cjs`. On every barge-in:

```ts
log.info('voice', 'barge-in', {
  tabId,
  ttsWasSpeaking: isSpeaking(),
  utteranceOffsetMs: performance.now() - speakStartedAt,
})
```

Track `speakStartedAt` in the voice store, set inside the `speak()` wrapper. Also log `barge-in.no-op` when `ttsWasSpeaking` is false, and `barge-in.misfire` when `onVADMisfire` fires within 600 ms of a barge-in.

## Testing Plan

Manual (primary): speakers + TTS, speak mid-utterance — audio cuts <200 ms, no echo loop; headphones repeat; TTS finishing exactly as user speaks (expect `no-op`); `ttsEnabled === false` (no crash); multi-tab switch.

E2E (Playwright Electron + fake-audio harness, see `e2e_test_infra.md`): inject WAV (1 s silence + 1 s speech) while calling `speak('long text…')` from a test hook. Assert `__transcripts` receives the text and `speechSynthesis.speaking` flips false within 250 ms of speech onset. Caveat: Web Speech API isn't deterministic in headless Chromium — likely needs a `window.speechSynthesis` stub.

## Alternatives Considered

1. **VAD threshold ducking during TTS.** Raise `positiveSpeechThreshold` to 0.85 while `isSpeaking()`. Reduces echo false-positives but raises real-user threshold. Rejected — ad-hoc tuning; AEC is the right primitive.
2. **AEC via `getUserMedia` constraints.** `echoCancellation`, `noiseSuppression`, `autoGainControl` on the VAD track. Standard, browser-native. **Adopted** as a layered mitigation, not the sole mechanism.
3. **Explicit hotkey (Cmd-period) to barge in.** Lowest false-positive rate, but defeats natural-conversation goal. Rejected for v1; possible power-user setting later.
4. **Turn-taking model (prosody + semantics).** Industry trend (Sources), needs non-trivial local model or server inference. Out of scope.

## Open Questions

1. **Hard stop vs 100 ms fade?** Web Speech API has no native fade; would require a Web Audio rewrite (`AudioContext` + `GainNode` + a TTS engine returning a buffer). Recommend hard stop for v1; revisit only if QA reports jarring.
2. **Surface "skipped rest of assistant turn" in UI?** E.g. strikethrough the un-spoken portion. Probably no — transcript stays canonical.
3. **Per-tab vs global `bargedInThisTurn`?** Currently global because `window.speechSynthesis` is global; revisit if we support concurrent tab TTS.
4. **`onVADMisfire` un-cancel & resume?** Requires resume infra that's already out of scope. No.

## Sources

- [Barge-in for Voice Agents: What It Is & How to Implement It Properly — orga-ai.com](https://orga-ai.com/blog/blog-barge-in-voice-agents-guide)
- [Master Voice Agent Barge-In Detection & Handling — sparkco.ai](https://sparkco.ai/blog/master-voice-agent-barge-in-detection-handling)
- [Optimizing Voice Agent Barge-in Detection for 2025 — sparkco.ai](https://sparkco.ai/blog/optimizing-voice-agent-barge-in-detection-for-2025)
- [Real-Time vs Turn-Based Voice Agent Architecture — softcery.com](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [Chrome TTS Workarounds: SpeechSynthesisUtterance event and initial speak() failure — iifx.dev](https://iifx.dev/en/articles/457363230/chrome-tts-workarounds-solving-the-speechsynthesisutterance-event-and-initial-speak-failure)
- [Chromium issue 1176078: Web API Speech Synthesis abruptly stops](https://bugs.chromium.org/p/chromium/issues/detail?id=1176078)
- [Taming the Web Speech API — Andrea Giammarchi](https://webreflection.medium.com/taming-the-web-speech-api-ef64f5a245e1)
- [MediaTrackSettings: echoCancellation property — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/echoCancellation)
- [Supported Audio Constraints in getUserMedia() — addpipe.com](https://blog.addpipe.com/audio-constraints-getusermedia/)
