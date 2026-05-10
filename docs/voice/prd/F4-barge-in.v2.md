# F4 — Barge-in for TTS (v2)

Status: draft (revised post-critique)
Owner: voice
Depends on: F1 (mic capture + VAD), F3 (TTS playback)

## Changes from v1

- **Latency target: 250-400 ms p50, ≤600 ms p95.** Silero's `minSpeechMs: 250` + `preSpeechPadMs: 300` make sub-200 ms unattainable.
- **AEC demoted to best-effort.** `MicVAD`'s custom `AudioContext` and `window.speechSynthesis`'s OS audio path don't share a reference signal Chrome can cancel against. Primary mitigation is now **VAD threshold ducking while TTS speaks** (raise `positiveSpeechThreshold` from 0.5 to 0.85).
- **Multi-tab routing explicit:** barge-in cancels whatever's speaking regardless of source tab; PTY transcripts always go to the recording tab (closure over `tabId` in `voice.ts`).
- **`bargedInThisTurn` boolean → `lastBargeInAt: number | null` + 1500 ms TTL** to survive streamed `speak()` chunks.
- **Telemetry uses `utterance.onstart`** for the latency anchor.
- **Defensive `cancel()` before `speak()` dropped** — it would kill streaming chunks mid-word.
- **PTT click-stop (`useVoiceTTS.ts:38`) documented as the existing fast path**; F4 is additive for the mic-already-on case.

## Problem & Motivation

When `ttsEnabled === true`, Claude's turns are spoken via the Web Speech API (`speechSynthesis.ts:34`, wired in `useVoiceTTS.ts:16`). Today the user must wait for TTS — clicking mic mid-sentence stops speech (`useVoiceTTS.ts:38`), but only because `isRecording` flips on click. If `isRecording` is already true (PTT held, or mic-on session) and the user speaks during TTS, the mic captures voice overlapped with TTS audio and Whisper transcribes garbage.

Realistic bar with Silero VAD is "feels responsive" (≤400 ms), not "feels human" (<100 ms — needs a raw-RMS fast-path we defer to F4.1). Trigger is Silero's `onSpeechStart`.

## Scope

**In scope:** cut TTS on VAD-confirmed `onSpeechStart` while `isRecording` is true; raise VAD threshold while TTS speaks to suppress self-talk; log every barge-in with `onstart`-relative offset; TTL-gated suppression of late-arriving streamed chunks.

**Out of scope:** resuming TTS after the user finishes; sub-250 ms latency (would need an AudioWorklet RMS fast-path — F4.1 follow-up); turn-taking models (prosody/semantic); any change to how PTT click currently stops TTS.

## UX Flow

1. Claude streams an answer; TTS speaks.
2. User taps mic, holds PTT (post-F2), or is already recording.
3. User speaks. ~250-400 ms later VAD's `onSpeechStart` fires.
4. Current utterance is cancelled mid-word.
5. Mic shows "Listening…" (`speechRecognition.ts:174`).
6. Whisper transcribes on `onSpeechEnd`; text routes to the **recording tab** (closure over `startRecording(tabId)`), not necessarily the TTS tab.

Hard stop. No banner — audio cut is the feedback. No auto-resume.

## Decision matrix (TTS playing × VAD speech-start)

| | TTS playing | TTS not playing |
|---|---|---|
| **VAD `onSpeechStart` fires** | Cancel TTS, set `lastBargeInAt = now`, log `barge-in` with `utteranceOffsetMs` from `onstart`. Subsequent `speak()` calls within 1500 ms are suppressed. | No-op on TTS. Log `barge-in.no-op`. `lastBargeInAt` **not** set (so streaming next assistant turn isn't suppressed). |
| **VAD `onSpeechStart` does not fire** | Continue speaking. PTT click can still call `stopSpeaking()` (existing `useVoiceTTS.ts:38` path, unchanged). | Idle. |

This matrix is the contract. Any deviation is a bug.

## Technical Design

### Wire `onSpeechStart` → `stopSpeaking()`

Add optional `onSpeechStart?: () => void` to `RecognitionCallbacks` (`speechRecognition.ts:15`); invoke from the VAD callback (`speechRecognition.ts:172-175`) alongside `onInterim('Listening…')`. The `onSpeechStart` closure is created **inside** `startRecording(tabId)` in `voice.ts` so it captures `tabId` for telemetry.

### VAD threshold ducking (primary self-talk mitigation)

`@ricky0123/vad-web` exposes `positiveSpeechThreshold` / `negativeSpeechThreshold` as live-mutable on the `MicVAD` instance. New module `src/renderer/lib/vadDucking.ts` subscribes to TTS start/end events (via the `speechSynthesis.ts` wrapper) and toggles:

- TTS speaking: `positive = 0.85`, `negative = 0.7`.
- TTS idle: restore to `0.5` / `0.35` (defaults at `speechRecognition.ts:166-167`).

Cost: missed barge-ins on quiet speech during TTS. Acceptable.

### Best-effort AEC

Pass `additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }` to `MicVAD.new` (`speechRecognition.ts:158`). Helps on hardware-canceling headsets and some OS AEC paths; ducking carries the load elsewhere.

### `lastBargeInAt` + TTL

Add `lastBargeInAt: number | null` to `VoiceState`. Set on barge-in, never explicitly cleared. `useVoiceTTS.ts:24` gates each `speak()`:

```ts
const last = useVoice.getState().lastBargeInAt
if (last !== null && performance.now() - last < 1500) return
```

1500 ms covers Whisper's 200-800 ms transcription window plus jitter; expires before the next legitimate assistant turn.

### Telemetry: `utterance.onstart`

In `speechSynthesis.ts`, `utterance.onstart = () => { speakStartedAt = performance.now() }`; expose `getSpeakStartedAt()`. `utteranceOffsetMs = performance.now() - speakStartedAt` when non-null, else `null`. Log `charIndex` from `onboundary` where available (Chrome desktop only).

### Multi-tab semantics

`window.speechSynthesis` is a global singleton.

- **Barge-in cancels whatever's speaking regardless of source tab.** User speaking into tab B during tab A's TTS cuts tab A. Desired UX — user has the floor.
- **PTY transcript routes to the recording tab.** `onFinal` closure in `voice.ts:91` captures `tabId` at `startRecording`; switching tabs does not retarget. Recording on A, switching to B, speaking during B's TTS → transcript lands on A.
- **`lastBargeInAt` is global** (one TTS engine, one flag).

### Integration points

- `speechRecognition.ts:15` — add `onSpeechStart?: () => void` to `RecognitionCallbacks`.
- `speechRecognition.ts:172-175` — invoke `opts.onSpeechStart?.()` alongside `onInterim`.
- `speechRecognition.ts:158` — pass `additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }` (best-effort).
- `voice.ts:82` — inside `startRecording(tabId)`: `onSpeechStart: () => { stopSpeaking(); set({ lastBargeInAt: performance.now() }); log.info('voice', 'barge-in', { tabId, ttsWasSpeaking: isSpeaking(), utteranceOffsetMs: getSpeakStartedAt() ? performance.now() - getSpeakStartedAt() : null }) }`.
- `voice.ts` — add `lastBargeInAt: number | null` to `VoiceState`.
- `useVoiceTTS.ts:24` — TTL gate (see above).
- New `src/renderer/lib/vadDucking.ts` — toggles VAD thresholds on TTS start/end events; wired from `voice.ts` after recognition handle is created.
- `speechSynthesis.ts` — set `utterance.onstart` to capture `speakStartedAt`; expose getter. **Do not** add a defensive `cancel()` before `speak()` (would break streaming).

## Edge Cases & Failure Modes

1. **Self-talk loop.** Ducking + best-effort AEC. Acceptance: at 60-70% laptop-speaker volume, ≤1 false barge-in per 60 s of TTS.
2. **VAD misfire.** TTS cancelled — acceptable cost. TTL blocks streaming chunks for 1500 ms; user can re-trigger on the next turn.
3. **Hard-stop tail.** OS buffer drains 20-80 ms after `cancel()`. Ducking + TTL absorb it.
4. **Multiple queued utterances.** `cancel()` clears the queue. Streamed chunks within 1500 ms are dropped; after TTL, new chunks resume.
5. **Headphones.** No echo path; ducking harmless.
6. **Browser still speaking after `cancel()`** (Chrome flake). Ducking + TTL handle it; no defensive pre-`cancel()`.
7. **TTS finished naturally as user speaks.** `isSpeaking()` false; `cancel()` no-op. `lastBargeInAt` **not** set (see matrix). Log `barge-in.no-op`.
8. **PTT click while TTS plays.** `useVoiceTTS.ts:38` calls `stopSpeaking()` on `isRecording` flip — ~5 ms, beats VAD. F4 covers only the *already-recording* case. Click-stop and F4-VAD are complementary.
9. **`autoSend` + false-start.** User barges in then stops; `submitUserSpeechOnPause: true` flushes a partial; with `autoSend` on, junk types into PTY. Mitigation deferred (min-length gate); flag in release notes.
10. **`ttsEnabled` toggled mid-utterance.** `lastBargeInAt` survives; if re-enabled within 1500 ms, next `speak()` suppressed once. Acceptable.
11. **Cross-tab during recording** — see Multi-tab semantics.
12. **`SpeechSynthesisErrorEvent: 'canceled'`.** Filter in F3 utterance error logging.

## Security & Privacy

None new. Mic granted per F1; no audio leaves the machine. TTS is local Web Speech API.

## Telemetry & Logging

Via `logger.ts` → `logs.cjs`. On every barge-in: `tabId`, `ttsWasSpeaking`, `utteranceOffsetMs` (from `onstart` or `null`), `charIndex` (if `onboundary` available). Log `barge-in.no-op` when `ttsWasSpeaking` is false. Log `barge-in.misfire` when `onVADMisfire` fires within 600 ms of a barge-in. Log `tts.duck.on` / `tts.duck.off` from `vadDucking.ts`.

## Testing Plan

**Manual:** speakers + TTS at 60% volume, speak mid-utterance — audio cuts within 400 ms p50, no sustained echo loop; headphones repeat; TTS finishing as user speaks (expect `no-op`); `ttsEnabled === false`; cross-tab (record A, switch to B, speak during B's TTS — verify transcript lands on A).

**E2E** (Playwright Electron + fake-audio, see `e2e_test_infra.md`): inject WAV (1 s silence + 1 s speech + 1 s silence; `redemptionMs: 600` means `onSpeechEnd` ~1.6 s in) while calling `speak('long text…')`. Stub `window.speechSynthesis` (non-deterministic in headless Chromium): track `cancel()` calls and `speaking` manually. Assert `speaking === false` within 600 ms of speech onset; wait ≥1.8 s before asserting `__transcripts`.

**Latency budget:** p50 ≤400 ms, p95 ≤600 ms, from synthetic speech onset to `cancel()` returning.

## Alternatives Considered

1. **AudioWorklet RMS fast-path** for sub-100 ms barge-in. Defer to F4.1; non-trivial worklet + noise-floor calibration.
2. **Mic mute during TTS.** Defeats barge-in.
3. **Hotkey-only barge-in (Cmd-period).** Defeats natural-conversation goal. Possible power-user setting.
4. **Turn-taking model.** Out of scope.
5. **Defensive `cancel()` before `speak()`** (v1 §Edge 6). Rejected: kills streaming chunks.

## Open Questions

1. **Hard stop vs fade.** Web Speech API has no fade. Hard stop for v1.
2. **`onboundary` reliability.** Chrome desktop yes; Safari/macOS native voices no. Fall back to `null` `charIndex`.
3. **Ducking threshold value.** 0.85 is a guess; tune against the 60 s false-barge-in metric.
4. **TTL value.** 1500 ms — revisit if streaming gaps exceed it.

## Sources

- [Barge-in for Voice Agents — orga-ai.com](https://orga-ai.com/blog/blog-barge-in-voice-agents-guide)
- [Master Voice Agent Barge-In — sparkco.ai](https://sparkco.ai/blog/master-voice-agent-barge-in-detection-handling)
- [Real-Time vs Turn-Based Voice Agent Architecture — softcery.com](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [Chrome TTS Workarounds — iifx.dev](https://iifx.dev/en/articles/457363230/chrome-tts-workarounds-solving-the-speechsynthesisutterance-event-and-initial-speak-failure)
- [Chromium 1176078](https://crbug.com/1176078)
- [MediaTrackSettings: echoCancellation — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/echoCancellation)
- [@ricky0123/vad-web](https://github.com/ricky0123/vad)
