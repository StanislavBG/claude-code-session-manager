# F8 — Semantic Turn Detection (Replace Pure-VAD Endpointing) — v2

> Status: Draft PRD v2
> Owner: voice subsystem
> Last updated: 2026-05-02
> Depends on: nothing (audio-only path is independent of F6 — see [Technical Design](#technical-design))

## Changes from v1

Folds in the adversarial critique:

- **Loading:** `smart-turn-v3` is **not** a transformers.js pipeline task. v2 uses direct `onnxruntime-web` + `preprocessor_config.json` + manual mel-spectrogram + `session.run`. Significantly more code than `pipeline()`.
- **Memory and latency rebudgeted to wasm.** 8 MB is on-disk INT8; per-worker runtime is ~20–30 MB. Latency 30–60 ms p50 / 100–150 ms p95 on 2018-class hardware. CI gate **200 ms p95**, not 50 ms.
- **F6 dependency removed.** Audio-only path is independent.
- **LiveKit `turn-detector` rejected** under LiveKit Model License (Nov 2024). Moved to "Rejected (license)".
- **Decision rule** simplified to single `0.5` sigmoid cutoff. The `0.6 / 0.3 / 0.85` triplet is dropped; calibration is a TODO.
- **Fast-path removed** (`eot ≥ 0.85` while `!vad_ended`). Reintroduce only gated on `min_silence_ms > 200`.
- **Cold-start floor:** model not consulted until ≥1500 ms accumulated speech.
- **`dictationMode`** disables the model rather than retuning. Default off.
- **Telemetry:** `fallback_reason` enum — `disabled_by_user`, `load_failed`, `runtime_error`, `inference_timeout`.
- **Test corpus** ≥200 utterances, balanced across (continuation/end-of-turn) × (English conversational / code dictation / short commands), under `tests/fixtures/voice/turn-detection/`.
- **Backpressure:** hard 250 ms timeout; on breach, VAD wins, `inference_timeout` logged.
- **Training-data license** raised as Open Question with citation requirement.

## Problem & Motivation

The current endpointing pipeline in `src/renderer/lib/speechRecognition.ts:158-185` is 100% acoustic: Silero VAD (`@ricky0123/vad-web` v5) with `redemptionMs: 600` and `negativeSpeechThreshold: 0.35`. The instant a user pauses ~600 ms, `onSpeechEnd` fires and the buffer ships to Moonshine.

Failure cases observed in dogfooding:

1. *"and… uh… so the thing is — actually, never mind, just run the tests."* — VAD ends after "uh"; the rest becomes a second segment.
2. *"refactor this function to use a map instead of …"* — pause to read the screen; finalizes on "of".
3. *"git commit dash m … 'fix the thing'"* — quoted argument becomes a separate utterance.
4. *Code dictation* (*"def foo open paren …"*) — token-level pauses normal but catastrophic for VAD. Handled by disabling the model under `dictationMode`.

A semantic turn detector reads a short audio context and answers *does this look like a complete turn?* If "no" with high confidence, extend redemption; if "yes", finalize.

## Scope

In scope:

- Replace the **endpointing decision** with a hybrid: VAD detects acoustic silence as today; a learned classifier decides commit vs. extend.
- New turn-detector worker loading an ONNX model on demand via direct `onnxruntime-web`, sharing `preloadModel` lifecycle conventions.
- Telemetry logging `(vad_says, model_says, final_decision, fallback_reason)` for tuning.

Out of scope: replacing Silero VAD (still gates speech-start and silence rejection); F6 streaming partials; diarization, barge-in; cloud STT.

## UX Flow

Invisible to the user — same pulse-while-listening UI from F1/F2, same final-transcript flush. What changes:

- **Latency on natural endings** improves modestly: the model can confirm end-of-turn ~150–250 ms after acoustic silence, against the 600 ms redemption window. No fast-path preemption in v1.
- **Mid-thought pauses no longer truncate.** Incomplete partials extend redemption to a hard cap of 2500 ms (`MAX_REDEMPTION_MS`). If the user resumes within that window the segment continues; otherwise we flush.
- **Cold start** is ~80–200 ms slower on first inference (wasm JIT). Hidden behind warmup at preload.
- **Dictation mode** — new toggle, default off, voice settings. When on, model is bypassed and pure-VAD is used. Targeted at code dictation, which is out-of-distribution for the model.

A hidden `voice.semanticTurnDetection` flag (default `true`) flips back to pure-VAD if the model fails to load.

## Technical Design

### Model selection

| Model | Modality | Params | Size | License | Status |
|---|---|---|---|---|---|
| **Pipecat `smart-turn-v3`** ([HF](https://huggingface.co/pipecat-ai/smart-turn-v3)) | audio (Whisper-tiny encoder + linear head) | ~8M | 8 MB INT8 | **BSD-2-Clause** | **Selected.** |
| LiveKit `turn-detector` | text Qwen2.5-0.5B distill | ~0.5B | ~500 MB | LiveKit Model License (Nov 2024) | **Rejected — license.** See below. |
| `latishab/turnsense` | text SmolLM2-135M LoRA | 135M | ONNX | Apache-2.0 | Weak signal (2k samples, EN only). Out. |

BSD-2 is the only license compatible with our distribution.

### Loading & inference plumbing

`smart-turn-v3` is **not** a registered transformers.js pipeline task. There is no `pipeline('semantic-vad', …)`. `onnx-community/smart-turn-v3-ONNX` ships a graph and `preprocessor_config.json`; running it requires custom glue.

Two paths considered:

1. `@huggingface/transformers` `AutoModel.from_pretrained` + `AutoProcessor` (`WhisperFeatureExtractor`), then manual forward.
2. Direct `onnxruntime-web` `ort.InferenceSession` with our own mel-spectrogram extractor.

**v2 picks (2): direct `onnxruntime-web`.** Avoids transformers.js coupling and version risk. Smaller surface: one ORT session, one preprocessor, one sigmoid on the output logit.

`turnDetectorWorker.ts`:

1. On `init`: download `model.onnx` (INT8) and `preprocessor_config.json` from `onnx-community/smart-turn-v3-ONNX`. Cache in IndexedDB.
2. Construct `ort.InferenceSession` with `executionProviders: ['wasm']`, SIMD on, threaded if `crossOriginIsolated`.
3. Mel-spectrogram extractor matching `preprocessor_config.json` (n_fft, hop, mel filterbank, log-scaling). 80 mel bins × 400 frames @ 16 kHz, fp32.
4. On `infer({audioFloat32})`: truncate or **left-pad with zeros at the start** (matching upstream `inference.py`) to the exact encoder input length, `session.run({input_features: melTensor})`, sigmoid the logit, post `{eot, model_ms}`.

Estimate: ~250 LOC vs. ~80 LOC for a pipeline call. Significantly more complex.

### Inputs & windowing

Input is the most recent **up to 8 s** of 16 kHz mono Float32 audio. `smart-turn-v3` truncates from the head and **left-pads at the start with zeros** if shorter. Our mel extractor must match. The buffer comes from `@ricky0123/vad-web` via `onSpeechEnd` at `speechRecognition.ts:176-180`.

### Cold-start floor

The model is **not consulted until ≥1500 ms of accumulated speech audio**. Below that, pure-VAD endpointing wins. Rationale: running the audio model on a short zero-padded sample yields arbitrary `eot` values, and short commands ("stop", "yes") finalize correctly under VAD alone today. Logged as `decision: 'vad_only_short_audio'`.

### Inference cadence

Two triggers, both gated by the cold-start floor:

1. **VAD-redemption-imminent**: when redemption countdown starts, run one inference. Highest-value tick.
2. **Periodic during speech**: every 500 ms while VAD reports speaking, gated on ≥1500 ms of audio, skipped if a call is in flight.

Hard cap 2 inferences/sec/stream. At ~50 ms p50 wasm cost this is ~10% of one core while mid-utterance — acceptable but not free.

### Decision rule (v1)

Let `eot ∈ [0,1]` be the model's sigmoid output and `vad_ended` be the redemption-fired flag.

```
if !modelReady || dictationMode:
    use VAD-only (today's behavior)            // fallback path
if audio_ms < 1500:
    use VAD-only                                // cold-start floor
if vad_ended && eot >= 0.5:
    finalize now                                // confirmed endpoint
if vad_ended && eot <  0.5:
    extend redemption to MAX_REDEMPTION_MS (2500ms), capped at extend_count <= 2
otherwise:
    keep listening
```

Single sigmoid cutoff at `0.5`, matching the upstream Pipecat reference. **The three-zone rule (`0.6 / 0.3 / 0.85`) is removed.** Reintroduce only after the corpus exists and thresholds are calibrated — see [Open Questions](#open-questions). The fast-path (`eot ≥ 0.85` while `!vad_ended`) is **removed** in v1; reintroduce only gated on `min_silence_ms > 200`.

`MAX_REDEMPTION_MS = 2500` is a single named constant.

### Latency & memory budgets

- **On-disk model:** 8 MB INT8.
- **Per-worker runtime working set:** ~20–30 MB (5–10 MB ORT wasm arena + mel buffers + KV/attention scratch + JS heap). Two ORT-using workers (Moonshine + turn detector) means two wasm-runtime copies — ~10–20 MB duplicated. Accepted in v1; backend sharing is a follow-up.
- **Combined renderer working set:** Moonshine fp32 (~150 MB) + smart-turn (~25 MB) + ORT wasm × 2 + JS heap ≈ 200 MB. Within renderer budget on 8 GB+ hosts.
- **Latency:** 30–60 ms p50, 100–150 ms p95 on a 2018-class laptop in `onnxruntime-web` (wasm SIMD). Pipecat's 12 ms is native CPU and is **not** representative.
- **CI performance gate: 200 ms p95** over 100 sequential calls. Fail the build on regression. Not 50 ms.
- **Hard timeout:** 250 ms wall clock per inference. On breach, the call is abandoned, VAD wins, telemetry emits `inference_timeout`.

The model is not free.

### Worker isolation

Separate `turnDetectorWorker.ts` — co-tenanting in `whisperWorker.ts` would serialize the calls. Lifecycle from `speechRecognition.ts:34-54` (lazy `getTurnWorker()`, shared across handles, warmup against `new Float32Array(16000 * 2)`). Cost: ~2 MB JS heap.

The parent treats `postMessage` silence (>5 s on a pending call) as worker failure — wasm `unreachable` traps can in some Chrome versions skip `error` events.

### Fallback

Degrade to pure-VAD on any of: model missing on first download, ORT init throws, worker spawn fails, inference throws, or inference exceeds 250 ms. `voice.ts` state gains `turnDetectorStatus: 'disabled' | 'loading' | 'ready' | 'load_failed' | 'runtime_error'`. UI unchanged.

### Integration points

- `src/renderer/lib/speechRecognition.ts:158-185` — wrap VAD callbacks. New helper `decideEndpoint(audio, audioMs)` returns `{commit, extendMs, fallbackReason?}`.
- `src/renderer/lib/whisperWorker.ts` — unchanged.
- New file `src/renderer/lib/turnDetectorWorker.ts` — direct `onnxruntime-web` session plus in-tree `WhisperFeatureExtractor` port.
- `src/renderer/state/voice.ts:54-72` — `initModel` kicks off both preloads in parallel; expose `turnDetectorStatus`.
- New setting `voice.dictationMode` (default `false`) bypasses the model.

## Edge Cases & Failure Modes

1. **Cold start, audio < 1500 ms.** Model skipped; pure-VAD wins. Logged `vad_only_short_audio`.
2. **Code dictation.** Out-of-distribution. `dictationMode` disables the model. The corpus carries a code-dictation slice; if results show the model is fine, we can revisit the default.
3. **Intentional pauses for commands.** Extend up to 2 times then commit.
4. **Model false-positive (never lets user finish).** Hard cap of 2 extensions per segment; commit regardless after.
5. **Model false-negative (cuts off mid-sentence).** Same recovery as today — user repeats.
6. **Mixed languages.** smart-turn-v3 covers 23 languages; degrade gracefully on unsupported pairs. No per-language thresholds in v1.
7. **Cold-load latency.** ~80–200 ms first-inference JIT. Warmup against 2 s zero-buffer at preload. Warmup timeout > 5 s → fall back.
8. **Model file corruption.** One cache-bust retry on ONNX load failure, then fall back.
9. **Slow CPUs.** 250 ms wall-clock cap; timeouts discard the result and VAD wins (`inference_timeout`).
10. **Privacy.** Fully local. First-run fetch from HF CDN over HTTPS, same trust path as Moonshine.
11. **Backpressure (VAD ends, model computing).** Single 250 ms timeout. On breach, call is cancelled, VAD's commit stands, telemetry emits `inference_timeout`. No separate "grace" rule.
12. **Worker crash.** `error` handler flips `turnDetectorStatus` to `'runtime_error'`; subsequent `decideEndpoint` returns `{commit: vad_ended, fallbackReason: 'runtime_error'}`. Parent also treats `postMessage` silence (>5 s) as failure.
13. **Memory pressure.** ~200 MB combined working set documented above.
14. **Click-to-stop mid-inference.** `stop()` already drains Whisper (`speechRecognition.ts:202-211`); add the same drain for the turn detector.

## Security & Privacy

- All inference is local. No network at runtime. CSP and Electron sandbox unchanged.
- Model artifacts downloaded once from `huggingface.co` over HTTPS, then cached. Same trust boundary as Moonshine.
- Telemetry logs are local only via `log.info`. No remote shipping.

## Telemetry & Logging

Every endpoint decision emits one line via the existing `log` channel:

```
log.info('turnDetector', 'decision', {
  vad_ended: boolean,
  eot: number,                  // [0,1], or -1 if model not consulted
  audio_ms: number,
  decision: 'commit' | 'extend' | 'vad_only_short_audio' | 'fallback',
  fallback_reason:              // present iff decision === 'fallback'
    'disabled_by_user' | 'load_failed' | 'runtime_error' | 'inference_timeout' | null,
  extend_count: number,
  model_ms: number,             // -1 if not consulted
  model_late: boolean,          // true iff inference exceeded 250 ms (paired with inference_timeout)
})
```

`fallback_reason` is the four-state enum: each value is logged distinctly so we can separate silent load regressions from user opt-out.

A debug overlay (gated on `voice.debugOverlay`) renders these live. After 500 decisions, dump aggregate stats to clipboard via a dev-only command.

## Testing Plan

1. **Test corpus.** **Minimum 200 utterances**, balanced across:
   - axis A (label): continuation vs. end-of-turn (~100 each)
   - axis B (domain): English conversational / code dictation / short commands (~67 each)
   Each utterance is a 16 kHz mono WAV with sample-accurate ground-truth end-of-turn timestamps. Stored under `tests/fixtures/voice/turn-detection/` with a `manifest.json` listing path, label, domain, eot_sample. Recording protocol in a sibling README.
2. **Unit tests** on `decideEndpoint` with mocked `(vad_ended, eot, audio_ms)` triples — single-cutoff rule, cold-start floor, dictation-mode bypass, extension cap.
3. **E2E:** replay each fixture with `semanticTurnDetection: true` vs. `false` via the fake-audio harness; assert truncation cases produce one `__transcripts` entry under the flag and (often) two under the old.
4. **Performance:** p95 inference < 200 ms over 100 sequential calls on CI.
5. **Fallback:** stub the worker to throw on `load`; assert app still records with `turnDetectorStatus === 'load_failed'`. Repeat for `runtime_error` and `inference_timeout`.
6. **Calibration sweep** (post-v1, gated on corpus): cutoffs in `[0.3, 0.4, 0.5, 0.6, 0.7]`; compute false-truncate and false-extend rates per slice.

## Alternatives Considered

1. **Retune `redemptionMs`.** Raising to 1500 ms uniformly worsens short-command latency. We'll still raise from 600 to ~900 ms as a safety net under the model.
2. **Cloud streaming STT with built-in endpointing.** Rejected on privacy.
3. **Push-to-talk only (F1).** Already shipping. Punts the problem to the user.
4. **Trailing-token heuristic** (extend if partial ends in `and|but|of|the|to`). Cheap but lacks a completeness concept; backup signal at best, F6-gated.
5. **`latishab/turnsense`.** English-only, weakest signal. Out.

## Alternatives — Rejected (license)

**LiveKit `turn-detector`** ([HF](https://huggingface.co/livekit/turn-detector)) — text-only Qwen2.5-0.5B distill, 14 languages, strong reported accuracy. **Cannot ship.** The LiveKit Model License (Nov 2024) restricts use to **LiveKit Agents only** and prohibits standalone use or use with other frameworks. An Electron renderer pulling weights from HuggingFace and running them in `onnxruntime-web` is a textbook violation. Using the model in our distribution would require a separate commercial license from LiveKit.

A hard "no", not a deferred upgrade. If a text path is wanted later, candidates must be on a permissive license (Apache-2.0, BSD, MIT) or self-trained on permissively licensed data.

## Open Questions

- **Training-data license posture.** The `pipecat-ai/smart-turn-data-v3-train` dataset ships with no published LICENSE at writing. Model card declares BSD-2 on the weights, sufficient to ship weights as-is but blocks any downstream fine-tune that depends on the data lineage. **Action before launch:** either (a) cite the dataset's LICENSE if it lands, or (b) explicitly note we ship the model weights only, leaning on the BSD-2 model-card declaration. No fine-tuning on this data until resolved.
- **Per-language thresholds.** Hard-coded from upstream or learned from telemetry? Lean hard-coded after calibration at 1k decisions.
- **Dictation-mode scope.** Global, per-tab, or auto-detected from preset (build vs. engage, see `preset_architecture.md`)?
- **Backend sharing.** Share a single `onnxruntime-web` backend across the Moonshine and turn-detector workers, or accept the per-worker arena cost?
- **Reintroducing the fast-path.** Only after calibration shows false-preempt rate < 1% with `min_silence_ms > 200` gating.

---

### Sources

- [Pipecat smart-turn-v3 model card](https://huggingface.co/pipecat-ai/smart-turn-v3)
- [onnx-community/smart-turn-v3-ONNX](https://huggingface.co/onnx-community/smart-turn-v3-ONNX)
- [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
- [LiveKit Model License (Nov 2024)](https://huggingface.co/livekit/turn-detector/blob/main/LICENSE) — rejection citation
- [Smart Turn v2/v3 announcement (Daily.co)](https://www.daily.co/blog/smart-turn-v2-faster-inference-and-13-new-languages-for-voice-ai/)
- [onnxruntime-web docs](https://onnxruntime.ai/docs/tutorials/web/)
