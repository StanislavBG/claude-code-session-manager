# F6 — Streaming Partial Transcripts: Adversarial Critique

## Verdict

Reject in current form. The UX framing and edge-case enumeration are solid, but three load-bearing technical claims are wrong, unverified, or under-budgeted: (1) the sliding-window CPU model diverges on the very long-utterance case the PRD targets, (2) the cited "Moonshine v2 streaming" escape hatch does not exist in `@huggingface/transformers@^4.1.0` for our pinned model, (3) cancellation silently concedes that we burn full encoder time per dropped partial, making the §"Partial cost" budget optimistic by ~2×. v2 needs a smaller, work-bounded design.

## Severe issues

**S1 — Sliding-window CPU budget diverges, not just at worst case.** §"Partial cost" computes 60 encodes ≈ 42 s wasm for a 30 s monologue, then concedes "the worker keeps up only to ~10 s." That is the steady state for any utterance >10 s, not a corner case. Once encode time exceeds `PARTIAL_INTERVAL_MS` the queue grows monotonically until `onSpeechEnd`. "Drop previous unanswered partial" doesn't help (see S3) because ONNX can't be cancelled. The visible partial drifts further behind, and the *final* sits behind a queue of stale partials. Worse than today's UX on the very case the PRD targets.

**S2 — Moonshine v2 streaming is not a real fallback.** Both §"Partial cost" and §"Alternatives Considered" lean on a future Moonshine-v2 streaming path. In `node_modules/@huggingface/transformers/src/models/moonshine/modeling_moonshine.js`, `MoonshineModel` and `MoonshineForConditionalGeneration` are empty subclasses of `MoonshinePreTrainedModel` (`forward_params = ['input_values', 'decoder_input_ids', 'past_key_values']`). No streaming encoder cache, no chunked-attention helper, no `generate_step` for incremental encoding. Streaming Moonshine needs encoder KV-cache management *and* sliding encoder state — neither is wired in transformers.js v4. The cited arXiv ID `2602.12241` and the HF docs URL `moonshine_streaming` are unverifiable from this checkout. F6.1 currently means "wait for an upstream feature that may not exist."

**S3 — "Cancel only suppresses posting" is conceded, not budgeted.** §"Worker contention" admits cancel cannot interrupt ONNX, so every scheduled partial costs full encoder time even when discarded. The §"Partial cost" arithmetic does not include those wasted encodes. At `PARTIAL_INTERVAL_MS=500` and a 700 ms encode on a 10 s buffer, the host schedules a partial every 500 ms, the worker drains them at 700 ms each, and the encode queue grows by ~200 ms wallclock per partial. The "drop previous" optimization saves screen updates, not CPU. The PRD is underwater on its own numbers.

**S4 — Adaptive backoff (cap 2 s) defers the problem, doesn't solve it.** Doubling the interval cuts encode rate but not per-encode cost, which is dominated by buffer length. At a 30 s buffer, encode is ~2.1 s extrapolated from the PRD's table; 2 s interval / 2.1 s encode is still divergent. UX-wise, a partial cadence stretching from 500 ms to 2 s mid-utterance reads as the app choking — exactly the impression streaming partials are meant to dispel.

## Moderate issues

**M1 — Option A is viable on our pin; the PRD hedges incorrectly.** `@ricky0123/vad-web@^0.0.30` (`real-time-vad.d.ts:7`) declares `onFrameProcessed: (probabilities, frame: Float32Array) => …`. State plainly: "Option A is the only path on our pin; Option B is dead unless we downgrade." But `frame` is the raw 512-sample post-resample frame, *not* the lookahead-padded segment vad-web hands `onSpeechEnd` (issue #186). Concatenating raw frames omits `preSpeechPadMs: 300 ms` (`speechRecognition.ts:170`), so the first partial sees a different prefix than the final — a known Moonshine hallucination amplifier.

**M2 — No min-buffer-length before first partial.** §"Edge Cases" #4 mentions hallucination filtering but not a minimum-audio threshold. Whisper-family models hallucinate on <500 ms inputs, especially with non-speech prefix. A first partial at `T+400 ms` over 300 ms preroll yields a 700 ms input — borderline. Recommend `MIN_PARTIAL_AUDIO_MS = 800`. The fixed `ASR_HALLUCINATIONS` set in `voice.ts:32-43` is a string-set, not a length filter.

**M3 — Worker death recovery is unaddressed.** §"Edge Cases" #10 covers transferred buffers but skips the harder case: an ONNX wasm error crashes the worker outright. `whisperWorker.ts` posts `error` and `speechRecognition.ts:49-51` only logs — no respawn. Partials send 60× more requests per session, so worker fatality probability scales linearly. v1 needs an explicit decision: respawn-and-rehydrate (the model is on disk) or fail-closed.

**M4 — "Never auto-send from partial" is asserted but not testable as written.** §"Testing Plan" asserts `__transcripts` has exactly one entry — that's the outcome, not the invariant. The invariant is "no code path from `partialResult` reaches `window.api.pty.write`." Test it with a spy on the IPC channel plus a mutation: inject a synthetic `partialResult` directly into the worker bus and assert the spy is never called. PRD doesn't describe this.

**M5 — Misfire after partials breaks the dual-buffer claim.** §"Edge Cases" #1 says clear silently. With ~5 partials shown across ~2.5 s, "silently clear" means a sentence appears and vanishes with no explanation. The AssemblyAI dual-buffer pattern's whole point is that the committed slot never lit up, so misfire only clears the active slot. The PRD cites the pattern but `lastTranscript` still gets overwritten with `Listening…`/`Transcribing…` interim strings via `onInterim` (`voice.ts:83`). Pick one model.

**M6 — Toast at 30 s mid-utterance.** §"Edge Cases" #9 fires a toast while the user is still speaking. Toasts shift layout and grab focus. Drop silently with telemetry, or render an inline indicator in the partial slot ("…").

**M7 — E2E fixture punted.** Current fixture is "testing one two three" (~1 s); F6 needs >5 s with multi-partial assertions. PRD says "synthesized 5 s WAV with three distinct phrases" but doesn't specify source, license, or that it satisfies the 16 kHz mono PCM requirement (`e2e_test_infra.md`). TTS-generated clips are too clean; add a noisy variant.

## Minor / nits

**N1** — Logging `audio.length` leaks cadence; flag as accepted residual risk.

**N2** — Cancellation counter must be worker-scoped, not handle-scoped (`sharedWorker` at `speechRecognition.ts:29` is global). State explicitly.

**N3** — Cited `voice.ts:90` may have drifted post-F2/F4; verify.

**N4** — Add `lastPartialSeq: number` so React can `key` and skip identical-string diffs.

**N5** — Set `aria-hidden` on the partial slot; provisional text in `aria-live` confuses screen readers.

**N6** — Dual-buffer pattern predates the 2026 blogs cited; cite the canonical source.

## Suggestions for PRD v2

1. **Self-paced partials, not fixed cadence.** Schedule partial N+1 only when N's result lands AND `wallclock - lastPartialStart >= MIN_PARTIAL_INTERVAL_MS`. Removes the divergent-queue mode (S1, S3).
2. **Tail-window encoding.** Re-encode only the last `WINDOW_SECONDS = 6` for partials; final keeps full buffer. Encoder cost becomes O(1) after t=6 s. Provisional word-boundary discontinuity is acceptable. This is the only way wasm/fp32 stays in budget on a 2026 laptop without a real streaming model.
3. **Drop Moonshine-v2 as F6.1.** Replace with "evaluate Distil-Whisper chunked or Whisper-tiny streaming" (real ONNX builds exist) or "cloud opt-in for slow hardware."
4. **`MIN_PARTIAL_AUDIO_MS = 800` and `MAX_PARTIAL_BACKLOG = 1`.** Refuse to schedule when a partial is in flight.
5. **Worker respawn.** On `error` from worker, recreate it and re-issue load; toast `Speech model restarting…` once.
6. **Spy-based invariant test** on `window.api.pty.write` with synthetic `partialResult` injection.
7. **True dual buffer.** Move `Listening…`/`Transcribing…` to `voice.statusPill`; `lastTranscript` only ever holds finals.
8. **Commit the e2e fixture.** 6 s 16 kHz mono PCM WAV under `tests/fixtures/voice/`, plus a noisy variant; document license.
9. **Missing entirely:** F4 barge-in interaction (TTS ducking on partial?), F8 turn-detection race, i18n (Moonshine is English-only — non-English partials must be suppressed at language detect, not on the user).
