# F8 — Semantic Turn Detection — Adversarial Critique

> Reviewer: adversarial PRD review
> Target: `F8-turn-detection.md` (2026-05-02 draft)

## Verdict

The direction is sound and the model survey is mostly accurate, but the PRD is over-confident on three load-bearing claims (model loadability via transformers.js, a 12 ms inference budget, and the LiveKit fallback being "workable") and silent on several real risks. As written, an engineer could start implementing and discover at integration time that the primary model is not a drop-in `pipeline()` call, that combined ONNX+Whisper-tiny memory exceeds the stated 10 MB, and that the LiveKit text path is legally unusable in our distribution model. Needs a v2 before staffing.

## Severe issues

**1. "Drop-in via `@huggingface/transformers`" is not validated.** Section §4 states runtime is "identical to Moonshine — `onnxruntime-web` via `@huggingface/transformers`; no new toolchain." That is wishful. `smart-turn-v3` is not an `automatic-speech-recognition` pipeline; it is a Whisper-tiny **encoder** with a **custom linear classification head**, sigmoid output, with no registered transformers.js task. There is no `pipeline('semantic-vad', …)`. The `onnx-community/smart-turn-v3-ONNX` repo exists and is tagged for transformers.js, and a `preprocessor_config.json` is published, but loading it requires either `AutoModel` + manual `WhisperFeatureExtractor` invocation + manual session.run, or a hand-rolled `ort.InferenceSession`. The PRD must call this out as **custom inference glue**, not "no new toolchain", and it should specify which path: `AutoModel.from_pretrained` + `AutoProcessor`, or a raw `onnxruntime-web` session.

**2. The "8 MB / 12 ms" budget is the model file, not the runtime working set.** 8 MB is the INT8 ONNX on disk. At inference the Whisper-tiny encoder allocates mel-spectrogram buffers (80 × ~400 frames × fp32), KV/attention scratch, and ORT wasm arena. Plus the unquantized variant in the same repo is ~32 MB; if the dtype config inadvertently picks fp32 (Moonshine's default in `whisperWorker.ts:40`), we ship ~32 MB plus runtime tensors. The PRD's "Memory pressure" estimate of "+10 MB" (§5 Edge case 14) is optimistic by a factor of 2-5×. Also, **two ONNX runtimes in two workers** = two copies of the wasm SIMD/threaded runtime (~5-10 MB each), not shared. PRD should specify shared backend or accept the duplicated cost explicitly.

**3. 12 ms is upstream Pipecat's number on native CPU. We're in `onnxruntime-web` (wasm).** Wasm SIMD on a 2018-class laptop is typically 2-4× slower than native ORT for this kind of model. A realistic budget is 30-60 ms p50, 100-150 ms p95. The 200 ms hard cap in §4 is plausibly fine, but the PRD's headline "well under any reasonable budget" framing misleads planning. The 50 ms p95 acceptance gate in §6 Testing Plan #5 will likely fail on CI. **Action: re-benchmark in browser before committing thresholds.**

**4. Decision-rule thresholds (`0.6 / 0.3 / 0.85`) are unsourced.** The Pipecat reference inference uses a single 0.5 cutoff (sigmoid). The PRD's three thresholds appear nowhere in the model card, repo, or blog. §4 says they are "starting values, not load-bearing" — but the entire semantics of commit/extend/fast-path turns on them. The PRD should either (a) cite the source if borrowed from Pipecat's `confidence_threshold` config, or (b) explicitly mark them "to be calibrated against the F8 test corpus before launch" and gate launch on calibration.

**5. LiveKit fallback is not a fallback — it's unusable.** The LiveKit Model License (verified text, dated Nov 2024) restricts use to "LiveKit Agents only" and prohibits standalone use or use with other frameworks. An Electron renderer pulling weights from HuggingFace and running them in `onnxruntime-web` is a textbook violation. The PRD calls it "workable but not owned by default" — that is wrong. It cannot ship as an opt-in upgrade without a separate commercial license from LiveKit. Either remove from the doc, or move to "rejected alternatives" with the license citation.

**6. `eot ≥ 0.85` fast-path can preempt a live speaker.** The rule fires while `!vad_ended`, i.e. mid-utterance during any short intra-word pause. With a 0.85 threshold and a model trained on conversational data, this risks chopping off a speaker who paused for breath at a syntactically complete clause boundary ("I want to refactor the auth module … <breath> … and add tests"). PRD acknowledges in §5 Edge case 5 ("user repeats") but does not gate the fast-path on minimum acoustic silence. **Recommend: require ≥150 ms VAD-internal silence even on fast-path, or remove the fast-path until calibrated.**

## Moderate issues

**7. F6 dependency framing is contradictory.** The header says F6 is a "hard dependency"; §3 says audio-only ships independently; §4 §"Dependency on F6" agrees with §3. The audio-only smart-turn path needs no transcripts at all. The "hard dependency" line is wrong and should be downgraded to "soft dependency for the optional text path". Otherwise scheduling F8 behind F6 is an unforced delay.

**8. Cold-start / first-utterance handling is missing.** §3 mentions a +50–80 ms warmup and §5 Edge case 8 covers JIT, but neither addresses first-utterance accuracy. The audio model needs ≥1 s of audio (§4 Inference cadence implies this, but the floor is not stated as a correctness invariant). For utterances that finalize before 1 s of audio is captured (short commands like "stop"), the model must be skipped, not run on padded silence — running it on a 1-s zero-padded sample can yield arbitrary `eot` values and a confident-but-wrong commit/extend.

**9. Code-dictation mitigation is a single magic-number toggle.** §5 #2 raises thresholds to `0.95 / 0.5` — no evidence the model degrades gracefully on code rhythm at any threshold. Smart-turn-v3 is trained on conversational corpora (Liva AI / MundoAI human conversational data); programming voice ("def foo open paren self comma x close paren colon") is wholly out of distribution. The honest answer is: model is likely worse than VAD here. PRD should either (a) propose disabling the model entirely under `dictationMode`, or (b) commit to a code-dictation slice in the test corpus to measure.

**10. Backpressure resolution is "best effort + log".** §5 #12 says "VAD's commit + 100 ms grace is the deadline; otherwise finalize without the model." That's reasonable, but combined with the 200 ms inference cap in §5 #10 and the 50 ms p95 target in §6 #5, the budget is tightly stacked against the wasm reality (see issue #3). Spell out: when `model_late=true`, what decision is taken — the VAD default (`commit`)? PRD says "VAD wins that round" in #10 but "finalize without the model" in #12 — phrase consistently.

**11. Telemetry conflates "model failed to load" with "model disabled in settings".** §3 says the hidden flag flips to pure-VAD if the model fails to load. §6 telemetry has `decision: 'fallback'` but no field distinguishing `disabled_by_user` vs `load_failed` vs `runtime_error`. Add a `fallback_reason` enum so we can detect silent regressions in load reliability vs. expected user opt-out.

**12. Test corpus is a plan, not a corpus.** §6 #1 mines `__transcripts` retrospectively and §6 #2 records 30 WAVs by hand. 30 fixtures is too small to calibrate three thresholds across 23 languages and a dictation mode. PRD should either accept English-only at v1 and document it, or scope the corpus to a defensible size (≥200 labeled utterances minimum, balanced across the failure cases enumerated in §1).

**13. Training-data license not confirmed.** §8 Open Question #5 raises the weights license concern but stops at BSD-2 covering code. The training datasets (`pipecat-ai/smart-turn-data-v3-train`, etc.) ship with **no published license** at the time of writing — empty README, no LICENSE file. For a model whose card declares BSD-2 this is fine for the weights, but if we rely on that data lineage for any downstream fine-tune, it's a blocker. Note this for the audit.

## Minor / nits

**14. Inference cadence cost is underestimated.** §4 "2 inferences/sec at 12 ms = 2.4% of one core" assumes native latency. With a 50 ms p50 wasm reality (issue #3), it's ~10% of one core sustained while speaking — still acceptable, but worth restating.

**15. "Up to 8 s" input window is not in the PRD's Inputs section.** §4 says "last ~8 s" but the model strictly truncates from the head and zero-pads at the **start** if shorter (per the upstream `inference.py`). PRD should call out the padding direction — getting it wrong silently degrades accuracy.

**16. `turnsense` (latishab) listed as a contender is misleading.** PRD itself dismisses it as the weakest signal; including it in the survey table without dismissal in the row text invites a reviewer to suggest it again. Move to "Alternatives Considered" or annotate "not viable".

**17. §4 Worker-isolation claim "Crashes don't take down ASR" assumes the runtime crash is contained to the worker.** ORT wasm OOM tends to abort the whole worker thread, which is fine, but a wasm `unreachable` trap in Chrome can in some versions take the parent renderer with it. Worth a note that the parent should treat worker silence (`postMessage` timeouts) as a failure, not just `error` events.

**18. The 2.5 s extension cap interacts poorly with redemption math.** `min(redemptionMs * 4, 2500ms)` with `redemptionMs=600` gives `min(2400, 2500) = 2400`. Fine. But the constant `2500` lives in two places (cap and §3 UX claim). Make it a named constant.

## Suggestions for PRD v2

- Add an explicit **Loading & inference plumbing** subsection: which transformers.js API path (custom `AutoModel` vs raw `ort.InferenceSession`), the `preprocessor_config.json` expectations, the sigmoid-on-output detail, and a confirmed wasm benchmark (p50/p95) on a target machine before committing thresholds.
- **Drop the LiveKit text path entirely** or move it into "Rejected alternatives" with the license citation. Keeping it as "opt-in upgrade" creates a future trap.
- **Replace the three magic thresholds with one calibration plan**: ship v1 with a single `0.5` cutoff matching upstream; add the three-zone rule only after the test corpus exists, gated on labeled data.
- **Specify the cold-start floor**: minimum audio length (e.g. ≥0.8 s, or ≥40% of the 8-s window) before the model is even consulted; below that, defer to VAD.
- **Disable the model under `dictationMode`** rather than retuning thresholds; document that a code-dictation training corpus is the only real fix.
- Add a `fallback_reason` field to the telemetry schema and split `turnDetectorStatus` into `{disabled, loading, ready, load_failed, runtime_error}`.
- Tighten budgets to wasm reality: realistic p95 of 100-150 ms, hard cap at 250 ms, log `model_late` as an SLO breach not a normal occurrence.
- Gate the fast-path (`eot ≥ 0.85` while `!vad_ended`) on a minimum acoustic silence floor (~150 ms) to prevent live-speaker preemption.
- Replace the 30-WAV fixture target with a labeled set sized to the calibration burden (≥200 utterances, English-first, code-dictation slice carved out).
- Confirm and record the training-data license posture in the model audit; do not ship if the data licenses are unresolved and we plan any fine-tuning.

---

Word count: ~1,180.
