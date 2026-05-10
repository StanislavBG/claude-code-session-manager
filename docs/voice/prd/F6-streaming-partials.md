# F6 — Streaming Partial Transcripts

Status: Draft
Owner: voice
Related code: `src/renderer/lib/whisperWorker.ts`, `src/renderer/lib/speechRecognition.ts`, `src/renderer/state/voice.ts`

## Problem & Motivation

The current mic flow shows the literal string `"Listening…"` from `onSpeechStart` until VAD redemption (`redemptionMs: 600`) fires `onSpeechEnd`, at which point `"Transcribing…"` flashes briefly and the final appears (`speechRecognition.ts:172-180`). For a 1 s utterance perceived latency is ~750–900 ms; snappy.

Longer utterances degrade sharply. Empirical timings on Moonshine Base @ wasm/fp32:

| Utterance | Time-to-first-text | Perception |
| --- | ---: | --- |
| 1.0 s | ~0.85 s | Snappy |
| 2.5 s | ~2.4 s | Noticeably laggy |
| 5.0 s | ~5.0 s | Feels broken; user re-speaks |
| 10.0 s | ~10.5 s | Indistinguishable from a hang |

The static placeholder gives no signal the model is catching words; users repeat themselves or abort. Streaming ASR products (Deepgram, AssemblyAI, Gladia) set the bar: visible word-level updates within 200–400 ms of speech onset, then a stabilized final.

## Scope

In scope:

- A new `voice.lastPartial` state field, rendered with a clear visual distinction from `voice.lastTranscript`.
- Periodic re-transcription of the in-progress speech buffer in the existing whisper worker (sliding window).
- Cancellation/sequencing so partials cannot overwrite finals.

Out of scope:

- Streaming text into the PTY. Partials are display-only; the canonical write to `window.api.pty.write` still happens in `onFinal` (`voice.ts:84-95`). This is a hard rule — see Edge Cases.
- Replacing Moonshine Base with Moonshine v2 Streaming, Whisper-streaming, or a cloud provider. Tracked as alternatives.
- Word-level timestamps or confidence colouring.
- Partial TTS feedback (irrelevant — TTS reads model output, not user input).

## UX Flow

1. User starts mic. Status pill reads `Listening…` (unchanged).
2. VAD `onSpeechStart`. Schedule first partial at `T + 400 ms`.
3. Partial arrives, rendered in the transcript slot but muted: `opacity: 0.6`, italic, leading pulsing dot. Partials **replace** in place — never append.
4. Subsequent partials (~500 ms cadence) overwrite. Multi-character flicker acceptable; whole-sentence shrink/grow is not (mitigated by hallucination filter).
5. `onSpeechEnd`: blank the partial slot, show `Transcribing…` briefly. Final encode is ~150 ms even without cache reuse.
6. Final arrives at full opacity in `lastTranscript`. Auto-send (if enabled) writes to PTY exactly once, from the final.
7. Misfire: both slots cleared silently. No error pill, no content logged.

Visual contract: at a glance the user must distinguish provisional from committed. Dual-buffer (committed + active) is the proven anti-flicker pattern ([AssemblyAI 2026](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)).

## Technical Design

### Strategy

Every `PARTIAL_INTERVAL_MS = 500` ms during an active speech segment, copy the accumulated audio buffer and post it to the worker as `{ type: 'partial', seq, audio }`. Drop any previous unanswered partial. On `onSpeechEnd`, post `{ type: 'transcribe', seq, audio }` (final), and ignore any partial result whose `seq` is older than the latest final.

### Audio capture

`MicVAD`'s `onFrameProcessed` historically only received probabilities — see [ricky0123/vad#13](https://github.com/ricky0123/vad/issues/13). Naive concatenation of frames is broken because vad-web uses a sliding window internally ([#186](https://github.com/ricky0123/vad/issues/186)).

Two options:

- **A (preferred)**: newer 0.0.2x builds emit `onFrameProcessed(probabilities, frame)` where `frame` is the raw 512-sample 16 kHz Float32 frame (npm typings dist). Buffer into a `Float32Array` ring (cap 30 s = 480k samples = 1.92 MB) between `onSpeechStart` and `onSpeechEnd`. Zero extra plumbing.
- **B (fallback)**: parallel `AudioWorkletNode` on the same `MediaStream`. More code, more memory.

Decision: ship A behind a feature check; fall back to B if `frame` is undefined.

### Worker contention

The worker processes messages serially via a single `transcriber` instance (`whisperWorker.ts:77-112`); host-side FIFO resolvers (`speechRecognition.ts:101-110`). Additions:

- `seq` on every transcribe request, echoed in the response.
- Host tracks `currentPartialSeq`; deliver a partial result only if `seq === currentPartialSeq` AND no final with a higher seq has landed.
- A `cancel` opcode sets a flag; ONNX Runtime Web cannot interrupt mid-inference, so cancel only suppresses posting. Wasted CPU is bounded since partials are short.
- Finals never preempted by partials. If a final is in flight, skip scheduling new partials.

### Partial cost

Moonshine Base encoder is O(audio_length) (`whisperWorker.ts:1-8`). Per-partial wasm/fp32: 1 s ≈ 80 ms, 3 s ≈ 220 ms, 5 s ≈ 360 ms, 10 s ≈ 700 ms.

Worst case: a 30 s monologue with partials every 500 ms ≈ 60 encodes on a linearly-growing buffer ≈ 42 s of single-thread wasm work — the worker keeps up only to ~10 s. Mitigation: if an encode exceeds `PARTIAL_INTERVAL_MS`, double the interval (capped 2 s). True streaming via Moonshine v2 ([paper](https://arxiv.org/abs/2602.12241)) is the right long-term fix but out of scope.

### State

- `voice.lastTranscript: string` — final, committed. Existing.
- `voice.lastPartial: string` — provisional. New.
- `voice.partialSeq: number` — monotonically increasing, internal.

### Cancellation token

A single integer counter, shared between host and worker. Stored in closure of `createRecognition`. Worker echoes the `seq` back in its result; host drops mismatches.

### Integration points

- `whisperWorker.ts:93-111` — extend the `transcribe` branch to read `seq` and echo it back, add a parallel `partial` branch using the same pipeline call but tagging the response `type: 'partialResult'`.
- `speechRecognition.ts:158-185` — add `onFrameProcessed` to capture frames; schedule `setInterval` for partial flushes between `onSpeechStart` and `onSpeechEnd`; cancel interval in both terminal paths plus `onVADMisfire`.
- `speechRecognition.ts:119-136` — extend `onWorkerMessage` to dispatch `partialResult` to a new `opts.onPartial(text, seq)` callback.
- `voice.ts:82-107` — add `onPartial: (text) => set({ lastPartial: text })`, clear it on `onFinal` and on `onError`.

## Edge Cases & Failure Modes

1. **VAD misfire**. `onVADMisfire` after `onSpeechStart`: drop in-flight partials, clear `lastPartial`, log only the discard count — never text.
2. **Final differs from last partial**. Cosmetic flicker; mitigated by lower-emphasis partial style so users treat it as provisional.
3. **Partial returns after final**. Compare `seq`. If a final with `seq >= partial.seq` has been delivered, discard. Without this, `lastPartial` could overwrite `lastTranscript`.
4. **Hallucinations on near-silent prefix**. 300 ms `preSpeechPadMs` plus `ASR_HALLUCINATIONS` (`voice.ts:32-43`) can mis-fire on the first partial. Apply the same filter silently.
5. **Worker queue saturation**. If `inFlight.size > 1` (a final pending), skip scheduling new partials.
6. **Auto-send NEVER on a partial**. Hard invariant. Test asserts `window.api.pty.write` is unreachable from any `partialResult` path. The autoSend branch (`voice.ts:90`) stays reachable only from `onFinal`.
7. **Push-to-talk release**. PTT release calls `stopRecording` → `vad.pause()` + drain (`speechRecognition.ts:196-211`). Additionally cancel the partial interval and discard pending partial results; the drained final is canonical.
8. **Stop mid-utterance**. `vad.pause()` triggers `submitUserSpeechOnPause` → `onSpeechEnd` with buffered audio. Final wins; partials discarded.
9. **Memory growth**. Audio ring capped at 30 s (1.92 MB); drop oldest second past cap, surface one-time `"Utterance truncated at 30 s"` toast.
10. **Worker dies / transferred buffers**. Today we transfer `audio.buffer` (`speechRecognition.ts:108`). For partials, `slice()` before posting so the ring survives — transferring the live ring would empty it.
11. **Long monologue (>30 s)**. Combination of (5) and (9): adaptive interval doubles, ring truncates from the front. Final reflects only the last 30 s; documented.
12. **Multi-byte UTF-8 mid-token**. Moonshine returns whole strings, not byte streams; React renders unicode correctly. Verified, not a concern.
13. **structuredClone fragmentation**. 1.92 MB is well under limits; reuse a pooled slice buffer to avoid allocation churn.
14. **Concurrent recognition handles**. `activeHandle` enforces single-instance (`voice.ts:28`); assert via test that two handles cannot interleave seqs.

## Security & Privacy

Voice content is sensitive. Apply the existing log discipline:

- Partial *content* MUST NOT be logged at any level. The existing worker log line (`whisperWorker.ts:104`) only emits `chars: text.length` — preserve this for partials.
- Permitted partial telemetry: `seq`, `audio.length` (samples), encode duration, `discarded: boolean`, reason code.
- No partials in renderer console. `log.debug('voice', 'partial', { chars })` only.
- Partials never touch disk: they live only in zustand state and are cleared on every terminal path.
- Crash dumps must scrub `lastPartial` and `lastTranscript`. Add to existing crash redaction list (if absent, file as a follow-up).

## Telemetry & Logging

Counters per recording session, logged once on `stopRecording`:

- `partials.scheduled`
- `partials.delivered`
- `partials.dropped.stale`
- `partials.dropped.misfire`
- `partials.dropped.saturation`
- `partials.encode_ms.{p50,p95,max}`
- `final.encode_ms`
- `final.first_byte_ms` (time from `onSpeechEnd` to first character of final on screen)
- `partial.first_byte_ms` (time from `onSpeechStart` to first partial on screen — primary success metric)

Target: `partial.first_byte_ms.p95 < 700 ms` on a 2026-class laptop.

## Testing Plan

Manual:

- Speak a 1 s, 3 s, 8 s, 30 s utterance. Verify partials appear within 700 ms and update fluidly. Verify final replaces them and only the final goes to PTY.
- Toggle autoSend ON. Verify partials never trigger a newline write.
- Click stop mid-utterance. Verify final wins, no orphaned partial on screen.
- Misfire (cough, single click of mouse near mic). Verify silent clear.

Automated (Playwright Electron, extending the e2e infra in `e2e_test_infra.md`):

- Fixture: synthesized 5 s WAV with three distinct phrases. Drive via fake-audio device.
- Assert `__voice.getState().lastPartial` becomes non-empty between t=400ms and t=1500ms.
- Assert `lastPartial` updates ≥3 times during the utterance.
- Assert `lastPartial === ''` after `onSpeechEnd`.
- Assert `__transcripts` contains exactly one entry whose text matches the final, never a partial.
- Negative test: zero-content WAV (silence) — assert no partial ever rendered.

Benchmarks:

- Run a 30 s torture clip 5×, record CPU% via `performance.measure`. Fail the bench if average partial encode exceeds `PARTIAL_INTERVAL_MS` after backoff.

## Alternatives Considered

1. **Moonshine v2 Streaming / Whisper-Streaming**. Native streaming via cached encoder state ([HF docs](https://huggingface.co/docs/transformers/en/model_doc/moonshine_streaming)) eliminates re-encode cost. Rejected this milestone: ONNX builds for the wasm/fp32 combo we ship aren't on `onnx-community` yet. Track as F6.1.
2. **Cloud streaming (Deepgram/AssemblyAI/Gladia)**. Sub-300 ms partials, zero local CPU. Rejected: violates the offline-local promise (`speechRecognition.ts:1-10`); needs opt-in and a privacy review.
3. **Cut `redemptionMs` 600→200, finals only**. Cheapest. Rejected: shorter redemption fragments natural speech, doesn't help the 5–10 s monologue.
4. **Fixed 1 s chunks, decode and concatenate**. Rejected: word-boundary stuttering, no benefit over rolling window since Moonshine cost is linear.

## Open Questions

- Does our pinned `@ricky0123/vad-web` emit `frame` in `onFrameProcessed`? (Option A vs B.)
- Same DOM node for partial + final, or siblings? Lean siblings, `aria-live="polite"` only on the final.
- Threshold for a "machine struggling" hint? Tentative: drop rate >50% over 5 s.
- Keep the worker message shape compatible with Moonshine v2 streaming for a warm transition later.
- Expose `window.__partials` for e2e parity with `__transcripts`? Gate behind `process.env.E2E === '1'` to avoid DevTools content leakage.

## Sources

- [Moonshine v2: Ergodic Streaming Encoder ASR (arXiv 2026)](https://arxiv.org/abs/2602.12241)
- [HuggingFace Transformers — Moonshine Streaming docs](https://huggingface.co/docs/transformers/en/model_doc/moonshine_streaming)
- [moonshine-ai/moonshine GitHub](https://github.com/moonshine-ai/moonshine)
- [ricky0123/vad Issue #13 — onFrameProcessed audio frame request](https://github.com/ricky0123/vad/issues/13)
- [ricky0123/vad Issue #186 — concatenating frames from onFrameProcessed](https://github.com/ricky0123/vad/issues/186)
- [@ricky0123/vad-web frame-processor typings](https://app.unpkg.com/@ricky0123/vad-web@0.0.22/files/dist/frame-processor.d.ts)
- [AssemblyAI — Best real-time speech APIs 2026](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)
- [Gladia — Best open-source STT models 2026](https://www.gladia.io/blog/best-open-source-speech-to-text-models)
