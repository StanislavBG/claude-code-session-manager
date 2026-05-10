# F8 — Semantic Turn Detection (Replace Pure-VAD Endpointing)

> Status: Draft PRD
> Owner: voice subsystem
> Last updated: 2026-05-02
> Depends on: **F6 — streaming partials** (hard dependency, see [Technical Design](#technical-design))

## Problem & Motivation

The current endpointing pipeline in `src/renderer/lib/speechRecognition.ts:158-185` is 100% acoustic: Silero VAD (`@ricky0123/vad-web`, model `v5`) decides when speech ends purely from frame-level energy/probability, with `redemptionMs: 600` and `negativeSpeechThreshold: 0.35`. The instant a user pauses for ~600 ms, `onSpeechEnd` fires and the buffer is shipped to Moonshine. That works for short, uninterrupted commands ("open settings"), but it cuts users off the moment they think out loud.

Concrete failure cases observed in dogfooding:

1. *"and… uh… so the thing is — actually, never mind, just run the tests."* — VAD ends after "uh" (~700 ms gap); Moonshine ships a half-sentence and the rest becomes a second segment. Two PTY writes; the agent acts on the first.
2. *"refactor this function to use a map instead of …"* — user pauses to read the screen; segment finalizes on the trailing "of".
3. *"git commit dash m … ‘fix the thing’"* — quoted argument is sent as a separate utterance.
4. *Code dictation* (*"def foo open paren …"*) — token-level pauses are normal but catastrophic for VAD endpointing.

A semantic turn detector reads a partial transcript and/or a short audio context and answers: *does this look like a complete turn?* If "no" with high confidence, extend redemption past 600 ms; if "yes", finalize immediately. This is the same insight LiveKit and Pipecat ship in production.

## Scope

In scope:

- Replace the **endpointing decision** (when to call `onSpeechEnd` -> `spawnTranscribe`) with a hybrid: VAD detects acoustic silence as today, then a learned classifier decides whether to commit, extend, or hold.
- Introduce a turn-detector worker (or co-tenant in `whisperWorker.ts`) that loads an ONNX model on demand, sharing the existing `preloadModel` lifecycle.
- A telemetry channel that logs `(vad_says, model_says, final_decision)` triples for tuning.

Out of scope:

- Replacing Silero VAD. We still need acoustic VAD for the speech-start signal, the pre-roll padding, and to gate out total silence (so the model never runs on "you" / "Thank you." hallucination prompts).
- Streaming partial transcripts themselves — handled by **F6**.
- Multi-speaker diarization or barge-in — separate features.
- Cloud STT or push-to-talk fallbacks (covered as alternatives in [§9](#alternatives-considered)).

## UX Flow

Invisible to the user — same pulse-while-listening UI from F1/F2, same final-transcript flush. What changes:

- **Latency on natural endings** drops ~300–500 ms: the model can confirm end-of-turn before the 600 ms redemption window expires (commit at `eot > 0.85` after ~150 ms of acoustic silence).
- **Mid-thought pauses no longer truncate.** Incomplete partials ("…use a map instead of") extend redemption to a hard cap of 2.5 s. If the user resumes within that window, the segment continues; otherwise we flush anyway.
- **Cold start** may be ~50–80 ms slower because turn-detector inference is on the critical path. Hidden behind warmup (see [§4](#technical-design)).

No new UI. A hidden `voice.semanticTurnDetection` flag (default `true`) flips back to pure-VAD if the model fails to load.

## Technical Design

### Model candidate selection

Three contenders surveyed (May 2026):

| Model | Modality | Params | Quantized size | License | Notes |
|---|---|---|---|---|---|
| **LiveKit `turn-detector`** ([HF](https://huggingface.co/livekit/turn-detector)) | text-only | ~0.5B (Qwen2.5-0.5B-Instruct distilled from 7B) | INT8 ONNX `model_q8.onnx`, ~500 MB RAM | LiveKit Model License (custom; usage permitted, redistribution restricted) | 14 languages incl. EN; expects up to 6 turns of chat-template context, predicts P(`<\|im_end\|>` next). Per-language thresholds in `languages.json`. |
| **Pipecat `smart-turn-v3`** ([HF](https://huggingface.co/pipecat-ai/smart-turn-v3)) | audio-only (Whisper-tiny encoder + linear head) | ~8M | INT8 ONNX, **8 MB** | **BSD-2-Clause** | ~12 ms CPU inference. 23 languages. Drop-in classifier on raw waveform; no transcript needed. |
| `latishab/turnsense` ([GitHub](https://github.com/latishab/turnsense)) | text-only | 135M (SmolLM2-135M LoRA) | ONNX available | Apache-2.0 | English-only, trained on 2k samples; weakest signal of the three. |

**Recommendation: ship Pipecat `smart-turn-v3` (audio) as the primary, with LiveKit `turn-detector` (text) as an opt-in upgrade.**

Rationale: BSD-2 fits the app's distribution model; LiveKit's custom license is workable but not owned by default. 8 MB INT8 vs. ~500 MB working set matters in a renderer that already pays Moonshine's footprint. 12 ms CPU is well under any reasonable budget. Audio-only is more robust because F6 partials may not be ready at the exact moment VAD commits. Runtime is identical to Moonshine — `onnxruntime-web` via `@huggingface/transformers` (`whisperWorker.ts:10`); no new toolchain.

### Inputs

`smart-turn-v3` consumes the last ~8 s of 16 kHz mono Float32 audio (Whisper-tiny encoder input). We already have this buffer: `@ricky0123/vad-web` holds the live segment and `onSpeechEnd` at `speechRecognition.ts:176-180` receives it. Per-tick we slice the most recent N samples. No resampling.

If `useText === true` (LiveKit path), inputs become the last 6 transcript turns (chat-template, 128-token cap) from a ring buffer in `voice.ts`. Gated on F6.

### Inference cadence

Two triggers:

1. **VAD-redemption-imminent**: when `@ricky0123/vad-web` starts its redemption countdown, run one inference. Highest-value tick.
2. **Periodic during speech**: every 500 ms while VAD reports speaking, gated on ≥1 s of audio, skipped if the previous call is in flight.

Hard cap: 2 inferences/sec/stream. At ~12 ms each that's ~2.4% of one core.

### Decision rule

Let `eot = endOfTurn ∈ [0,1]`, `vad_ended` = the redemption timer fired.

```
if !modelReady:                 use VAD-only (today's behavior)         // fallback
if vad_ended && eot >= 0.6:     finalize now                            // confirmed endpoint
if vad_ended && eot <  0.3:     extend redemption to min(redemptionMs * 4, 2500ms)
if vad_ended && 0.3 <= eot < 0.6: finalize (lean on VAD; ambiguous)
if !vad_ended && eot >= 0.85:   finalize early (drop redemption)        // fast-path
otherwise:                      keep listening
```

Thresholds (`0.6`, `0.3`, `0.85`) are starting values, not load-bearing — they live in a config block and are tuned from the telemetry log (see [§7](#telemetry--logging)). The 2.5 s hard cap exists so a stuck model can't strand a session.

### Worker isolation

Co-tenanting in `whisperWorker.ts` serializes `transcriber()` and turn-detector calls in the same JS turn — exactly when we want them parallel. **Decision: separate `turnDetectorWorker.ts`** with the lifecycle pattern from `speechRecognition.ts:34-54` (lazy `getTurnWorker()`, shared across handles, `preloadModel`-style warmup against `new Float32Array(16000 * 2)`). Cost: ~2 MB JS heap baseline. Crashes don't take down ASR.

### Fallback

System MUST degrade silently to pure-VAD if any of: model file missing on first download, ONNX runtime init throws (wasm under `file://` has bitten us before, see `speechRecognition.ts:152-157`), worker spawn fails or posts `{type:'error'}` on load, inference throws, or inference exceeds the 200 ms budget. Extend `voice.ts` state with a `turnDetectorStatus` independent of `modelStatus`. UI shows nothing different.

### Integration points

- `src/renderer/lib/speechRecognition.ts:158-185` — wrap the VAD callbacks (`onSpeechEnd`, redemption tick) to consult the turn detector. New helper `decideEndpoint(audio, partial?)` returns `{commit, extendMs}`.
- `src/renderer/lib/whisperWorker.ts` — unchanged.
- New file `src/renderer/lib/turnDetectorWorker.ts` — mirrors `whisperWorker.ts` shape; loads `pipecat-ai/smart-turn-v3` ONNX via `@huggingface/transformers`.
- `src/renderer/state/voice.ts:54-72` — extend `initModel` to kick off both preloads in parallel; expose `turnDetectorStatus`.
- `src/renderer/state/voice.ts:74-115` — pass a shared transcript ring buffer into `createRecognition` (only used if F6 + LiveKit text path is enabled).

### Dependency on F6

The audio-only path (default) does **not** require F6 and can ship independently. The optional LiveKit text path requires streaming partials from F6 to be useful at all (otherwise we're feeding the model the previous *finalized* utterance, which is stale by definition). Flag this dependency at the top of the F6 PRD too.

## Edge Cases & Failure Modes

1. **Cold start, no prior context.** Audio-only model needs no history. Text path: empty history yields low-confidence eot, which biases to "keep listening" — acceptable.
2. **Code dictation.** Distribution shift. Mitigation: `voice.dictationMode` toggle that raises early-finalize from `0.85` to `0.95` and the extend threshold from `0.3` to `0.5`.
3. **Intentional pauses for commands.** Same path as #2.
4. **Model false-positive (never lets user finish).** Detect via telemetry (`extend_count >= 3` or total speech > 30 s). Hard cap of 2 extensions; commit regardless after.
5. **Model false-negative (cuts off mid-sentence).** Same recovery as today — user repeats. Mitigated by `0.6` confirm threshold being above 0.5.
6. **Mixed languages.** smart-turn-v3 covers 23, LiveKit 14. Unsupported pair: degrade to `0.5/0.5` thresholds (≈ VAD-only).
7. **Hallucinated partial misleads model.** Only on text path. Whisper/Moonshine hallucinate "Thank you." on silence; reuse the existing blocklist at `voice.ts:32-43` to skip the text inference.
8. **Cold-load latency.** ~80–200 ms first-inference JIT. Warmup against a 2 s zero-buffer at preload, mirroring `whisperWorker.ts:62-72`. Warmup timeout > 5 s → fall back.
9. **Model file corruption.** The Moonshine cache has bitten us before. On ONNX load failure, one cache-bust retry, then fall back. Never crash.
10. **Slow CPUs.** Budget: ≤50 ms p95 on a 2018-class laptop, with a hard 200 ms wall-clock limit per inference; timeouts discard the result and VAD wins that round.
11. **Privacy.** Both candidates run fully local via `onnxruntime-web` and `@huggingface/transformers`. No network at inference. First-run fetch from HF CDN over HTTPS, same trust path as Moonshine. No telemetry endpoints.
12. **Backpressure (VAD ends, model still computing).** Never block. VAD's commit + 100 ms grace is the deadline; otherwise finalize without the model. Log `model_late=true`.
13. **Worker crash mid-session.** `error` handler (mirrors `speechRecognition.ts:49-51`) flips `turnDetectorStatus` to `'error'`; subsequent `decideEndpoint` returns `{commit: vad_ended}`.
14. **Memory pressure.** Combined working set ~150 MB (Moonshine fp32) + ~10 MB (smart-turn INT8) = ~160 MB. Within renderer budget.
15. **Click-to-stop mid-inference.** `stop()` already drains in-flight Whisper transcriptions (`speechRecognition.ts:202-211`); add the same drain for the turn-detector worker.

## Security & Privacy

- All inference is local. No network at runtime. CSP and the existing Electron sandbox unchanged.
- Model artifacts are downloaded once from `huggingface.co` over HTTPS, then cached by transformers.js. Same trust boundary as Moonshine today.
- Transcripts (text path, F6-gated) never leave the renderer process. The worker does not import `window.api`; it cannot reach the main process IPC except via the typed message channel.
- Telemetry decision logs (next section) are written to local rotating logs only via `log.info`. No remote shipping.

## Telemetry & Logging

Every endpoint decision emits one line via the existing `log` channel (`speechRecognition.ts:47`):

```
log.info('turnDetector', 'decision', {
  vad_ended: boolean,        // did VAD's redemption fire?
  eot: number,               // model probability, [0,1], or -1 if unavailable
  partial_len: number,       // chars in partial transcript at decision time
  audio_ms: number,          // segment length so far
  decision: 'commit' | 'extend' | 'commit_early' | 'fallback',
  extend_count: number,      // how many times this segment was held
  model_ms: number,          // inference wall time
  model_late: boolean,       // did we proceed without waiting?
})
```

A debug overlay (gated on `voice.debugOverlay`) renders these live for hand-tuning. After 500 decisions, dump aggregate stats to clipboard via a dev-only command — same pattern as `__transcripts` at `voice.ts:135-142`.

## Testing Plan

Building a corpus is the gating activity. Plan:

1. **Synthetic corpus from existing transcript log.** Mine 200 utterances from `__transcripts` and label each as "complete" or "truncated mid-thought". Ground truth for regression testing the decision rule.
2. **Held-out fixtures.** Hand-record ~30 16 kHz mono WAVs covering hesitation, trailing connectives, long compound sentences with mid-clause pauses, code dictation, command shorthand, mixed EN/ES, near-silent breaths. Store in `e2e/fixtures/turn-detection/` and feed via the existing fake-audio harness (see `e2e_test_infra.md`).
3. **Unit tests** on `decideEndpoint` with mocked `(vad_ended, eot)` pairs, asserting transitions for each row of the [decision rule](#decision-rule).
4. **E2E**: replay each fixture with `semanticTurnDetection: true` vs. `false`; assert truncation cases produce one `__transcripts` entry under the new flag and (often) two under the old.
5. **Performance**: p95 inference < 50 ms over 100 sequential calls on CI; fail the build on regression.
6. **Fallback**: stub the worker to throw on `load`; assert the app still records and transcribes with `turnDetectorStatus === 'error'`.

## Alternatives Considered

1. **Retune `redemptionMs`.** Raising to 1500 ms reduces truncation but uniformly worsens latency on short commands. No single value works for both "short query" and "thinking-out-loud" — that's why a learned signal exists. We'd still raise from 600 to ~900 ms as a safety net under the model.
2. **Cloud streaming STT with built-in endpointing** (Deepgram, AssemblyAI, Speechmatics, OpenAI Realtime). Solves it server-side; rejected on privacy — transcripts must not leave the box. Also reintroduces an API-key surface deliberately removed when we adopted Moonshine.
3. **Push-to-talk only (F1).** Already shipping. Punts the problem to the user. Half the value of voice is hands-free; F8 makes hands-free usable.
4. **Trailing-token heuristic.** "If partial ends in `and|but|of|the|to`, extend." Cheap, no model. Misses hesitations and lacks a completeness concept; kept as a backup signal when the model is unavailable.
5. **LiveKit text-only model (Qwen2.5-0.5B distilled).** Strong accuracy but custom license and 500 MB working set. Opt-in upgrade only.

## Open Questions

- Audio-only by default with text as a power-user toggle, or ensemble both when F6 is available? Ensemble likely more accurate, doubles inference cost.
- Per-language thresholds: hard-coded from LiveKit's `languages.json` or learned from telemetry? Lean hard-coded for v1, revisit at 1k decisions.
- Dictation-mode toggle scope: global, per-tab, or auto-detected from preset (build vs. engage, see `preset_architecture.md`)?
- Ensemble cadence: run text model on every partial or only at VAD-redemption? ~3× cost difference; favor the latter.
- License audit on smart-turn-v3 weights — BSD-2 covers code; confirm weights ship under the same.

---

### Sources

- [LiveKit turn-detector model card (Hugging Face)](https://huggingface.co/livekit/turn-detector)
- [LiveKit turn-detector plugin docs](https://docs.livekit.io/agents/build/turns/turn-detector/)
- [Using a transformer to improve end of turn detection (LiveKit blog)](https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection/)
- [Pipecat smart-turn-v3 model card](https://huggingface.co/pipecat-ai/smart-turn-v3)
- [Smart Turn v2 / v3 announcement (Daily.co)](https://www.daily.co/blog/smart-turn-v2-faster-inference-and-13-new-languages-for-voice-ai/)
- [pipecat-ai/smart-turn GitHub repo](https://github.com/pipecat-ai/smart-turn)
- [latishab/turnsense GitHub repo](https://github.com/latishab/turnsense)
- [Speechmatics: How to build smarter turn detection for Voice AI](https://blog.speechmatics.com/semantic-turn-detection)
