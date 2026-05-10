# F6 — Streaming Partial Transcripts (v2)

Status: Draft v2 (supersedes v1; addresses critique REJECT)
Owner: voice
Related code: `src/renderer/lib/whisperWorker.ts`, `src/renderer/lib/speechRecognition.ts`, `src/renderer/state/voice.ts`

## Changes from v1

v1 was rejected because three load-bearing claims didn't survive review: the sliding-window CPU model diverges on the long-utterance case the PRD targets, the cited "Moonshine v2 streaming" escape hatch is not implemented in `@huggingface/transformers@^4.1.0` (`MoonshineModel` and `MoonshineForConditionalGeneration` are empty subclasses with no encoder KV cache or `generate_step`), and "cancel only suppresses posting" silently conceded full encoder cost per dropped partial.

v2 replaces fixed-cadence sliding-window encoding with a **work-bounded, self-paced, tail-window** design:

- **Tail-window cap.** Partial encodes only ever see the last `WINDOW_SECONDS = 6` of audio. Encoder cost is O(1) past t=6 s.
- **Self-paced.** Partial N+1 schedules only after N's result lands. `MAX_PARTIAL_BACKLOG = 1`; nothing queues.
- **First-partial gate.** `MIN_PARTIAL_AUDIO_MS = 800` to dodge silence-prefix hallucinations.
- **Hard wallclock caps.** Encode >1500 ms doubles the inter-partial floor; >3000 ms disables partials for the rest of the segment.
- **Worker-death recovery.** ONNX errors → kill+respawn; on repeat failure, fall back to final-only.
- **Pre-roll splice.** `vad-web` `onFrameProcessed(frame)` delivers post-resample 512-sample frames omitting `preSpeechPadMs`; v2 owns a 1 s pre-roll ring to splice 300 ms of context before the first partial.
- Fictitious arXiv `2602.12241` citation removed. Moonshine v2 streaming is "may exist upstream eventually; do not depend on it." F6.1 reframes around Distil-Whisper chunked or cloud opt-in.
- **True dual-buffer state.** `lastPartial` / `lastTranscript` independent; status strings move to `statusPill` and never overwrite transcript slots.
- **Spy-based auto-send invariant test** with synthetic `partialResult` injection.
- **F4 / F8 / i18n** documented; F6 is English-only.
- **Privacy.** Log only `audio.length` and timing; cadence leak is accepted residual risk.
- **Fallback.** New §"What v1 ships if partials prove infeasible".

## Problem & Motivation

The current flow shows `"Listening…"` from `onSpeechStart` through VAD redemption (`redemptionMs: 600`), then `"Transcribing…"` flashes before the final lands. Sub-1.5 s utterances feel snappy; from ~3 s onward perceived latency tracks utterance length 1:1, and at 10 s users abort or re-speak. Streaming-class products set a 200–400 ms time-to-first-text bar. Goal: the *perception* of liveness. Partials are advisory display-only; final is authoritative.

## Scope

In: `voice.lastPartial` rendered visually distinct from `voice.lastTranscript`; tail-window self-paced re-encoding in the existing whisper worker; sequencing so partials cannot overwrite finals; worker-death detection and bounded recovery.

Out: any PTY write from a partial (`window.api.pty.write` only fires on `onFinal`); replacing Moonshine with a streaming model or cloud; word-level timestamps or confidence colouring; non-English (Moonshine is English-only).

## UX Flow

1. User starts mic. `voice.statusPill = 'Listening…'`. Transcript slots blank.
2. VAD `onSpeechStart` at t=0. Pre-roll ring keeps feeding the live ring.
3. At t=`MIN_PARTIAL_AUDIO_MS` (800 ms), schedule the first partial.
4. Partial result lands → `voice.lastPartial = text`. Render at `opacity: 0.6`, italic, leading pulsing dot. Partials **replace** in place; never append. Committed slot untouched.
5. After result lands, schedule the next partial if `wallclock - lastPartialStart >= MIN_PARTIAL_INTERVAL_MS` (default 400 ms).
6. `onSpeechEnd`: clear `lastPartial`, `statusPill = 'Transcribing…'`. Final encodes the **full** utterance buffer (existing path, unchanged).
7. Final lands → `lastTranscript = text`, `statusPill = ''`. Auto-send (if enabled) writes to PTY exactly once.
8. Misfire: clear `lastPartial` only; `lastTranscript` untouched.

The separated `statusPill` fixes v1's bleed where `Listening…`/`Transcribing…` overwrote `lastTranscript` via `onInterim`.

## Technical Design

**Tail-window encoding.** Partials operate on `audio.slice(-WINDOW_SAMPLES)` where `WINDOW_SAMPLES = 6 * 16000 = 96000`. Past t=6 s every partial is the same cost (~450 ms wasm/fp32 extrapolated from v1's table). Final encodes still see the full ring (capped at 30 s); unchanged.

**Self-paced scheduling.** `MAX_PARTIAL_BACKLOG = 1`: the host refuses to schedule a partial when one is in flight. With self-pacing this is structural, not a guard against a queue.

**Audio capture.** `@ricky0123/vad-web@^0.0.30` (`real-time-vad.d.ts:7`) confirms `onFrameProcessed: (probabilities, frame: Float32Array) => …`; the hedged v1 Option B fallback is dropped. `frame` is 512 samples post-resample at 16 kHz — **not** the lead-in-padded segment (issue #186). v2 owns a separate 1 s pre-roll ring fed every frame regardless of speech state. On `onSpeechStart`, the pre-roll's last 300 ms splices ahead of the live ring before any partial encode runs, so the first partial sees the same prefix as the final. (Alternative if pre-roll proves expensive: accept different prefix; document as known limitation.) Live ring: 30 s = 1.92 MB; on overflow drop oldest second.

**Sequencing.** `seq: number` on every transcribe request, echoed in the response. Worker-scoped (the `sharedWorker` in `speechRecognition.ts:29` is global). Host tracks `currentPartialSeq` and `latestFinalSeq`; deliver a partial only if `seq === currentPartialSeq` AND `seq > latestFinalSeq`. A partial is never scheduled while a final is in flight. Cancellation is posting-suppression only; `MAX_PARTIAL_BACKLOG = 1` plus self-pacing means no wasted-encode CPU to budget.

**Hard wallclock caps.** `>= 1500 ms` doubles `MIN_PARTIAL_INTERVAL_MS` (cap 2000 ms), logs `partials.slowdown`. `>= 3000 ms` disables partials for the rest of the segment, logs `partials.disabled.budget`. Belt-and-suspenders against the divergent mode that killed v1.

**Worker death recovery.** On `worker.onerror` or `{ type: 'error' }` with ONNX/WASM origin: mark the segment failed, set `statusPill = 'Speech model restarting…'`, terminate and respawn, re-issue model load (cached on disk). If respawn succeeds within 3 s, resume in **final-only** mode for the rest of the session. If respawn fails twice, disable speech recognition entirely.

**State.**
- `voice.lastTranscript: string` — committed final. Existing.
- `voice.lastPartial: string` — provisional. New. Cleared independently on misfire / final / error / segment end.
- `voice.statusPill: string` — `Listening…` / `Transcribing…` / `Truncated` / `Speech model restarting…`. Replaces v1's `onInterim` overwrite of `lastTranscript`.
- `voice.partialSeq: number` — internal monotonic counter (worker-scoped).

**Integration points.**
- `whisperWorker.ts:93-111` — extend `transcribe` to read/echo `seq`; add `partial` opcode that runs on tail-window audio and tags responses `type: 'partialResult'`.
- `speechRecognition.ts:158-185` — `onFrameProcessed` capture (live ring + pre-roll); self-paced partial scheduling; cancel in misfire / pause / stop.
- `speechRecognition.ts:119-136` — extend `onWorkerMessage` with `partialResult` dispatch to `opts.onPartial(text, seq)`.
- `voice.ts` — add `onPartial`; clear `lastPartial` on terminal paths; move interim status strings to `statusPill`.

## Edge Cases & Failure Modes

1. **Misfire after partials shown.** Clear `lastPartial` only; `lastTranscript` is never overwritten so nothing committed needs clearing. Provisional styling makes the fade self-explanatory; no toast.
2. **Final differs from last partial.** Cosmetic; styling tells the user partials were guesses.
3. **Partial returns after final.** `seq` check discards it. Separate state field guarantees `lastTranscript` cannot be overwritten.
4. **Silence-prefix hallucination.** First-partial gate at 800 ms plus pre-roll splice. `ASR_HALLUCINATIONS` filter (`voice.ts:32-43`) still applied.
5. **Saturation.** Cannot occur — `MAX_PARTIAL_BACKLOG = 1` plus self-pacing.
6. **Auto-send NEVER on a partial.** Hard invariant; tested with a `pty.write` spy plus synthetic `partialResult` injection.
7. **PTT release / stop mid-utterance.** Cancel pending partial scheduling; drained final wins.
8. **Memory growth.** Live ring 30 s; pre-roll 1 s; combined ~2 MB.
9. **Worker dies.** Respawn + final-only fallback for the session.
10. **Long monologue (>30 s).** Moonshine truncates input above 30 s by model design; partials always show only the last 6 s. At the 30 s mark, surface inline `…` + `statusPill = 'Truncated'`. No toast (toasts shift layout mid-utterance).
11. **Pre-roll underflow.** If `onSpeechStart` fires before pre-roll has 300 ms (mic just opened), splice whatever exists and log `partials.preroll.underflow`.
12. **F4 (TTS barge-in).** Barge-in must NOT fire on partial-driven VAD spurious frames. Barge-in listens to `onSpeechStart` plus the existing energy gate, not to `onPartial`; partial scheduling does not retrigger any VAD callback. Regression test injects synthetic partials and asserts no `tts.stop()` IPC fires.
13. **F8 (turn detection).** When F8 lands, partials feed the LiveKit-style text-based turn detector **only** if F8 picks that path. F8 depends on F6 only for the text variant; pure-audio smart-turn is self-contained. F6 must not block on F8.

## Security & Privacy

- Partial **content** is never logged at any level. Worker emits only `chars: text.length`.
- Permitted partial telemetry: `seq`, `audio.length` (samples), encode duration, `discarded`, reason code. **`audio.length` leaks cadence**; documented as accepted residual risk.
- No partial text in renderer console. `log.debug('voice', 'partial', { chars })` only.
- Partials never touch disk; cleared on every terminal path.
- Crash dumps must scrub `lastPartial`, `lastTranscript`, `statusPill`.
- **i18n.** Moonshine is English-only. F6 is explicitly English-only until the model is swapped. Non-English audio yields hallucinated English partials — a model limitation, not a F6 bug. When language detection lands (post-F6), suppress at the language gate, never on the user.

## Telemetry & Logging

Per session, on `stopRecording`:

- `partials.{scheduled,delivered,dropped.stale,dropped.misfire,dropped.preroll_underflow,slowdown,disabled.budget,worker_respawns}`
- `partials.encode_ms.{p50,p95,max}`
- `final.{encode_ms,first_byte_ms}`
- `partial.first_byte_ms` — primary success metric (time from `onSpeechStart` to first partial on screen)

Target: `partial.first_byte_ms.p95 < 1100 ms` on a 2026-class laptop (800 ms gate + ≤300 ms encode at MIN_PARTIAL_AUDIO_MS).

## Testing Plan

Manual: speak 1 / 3 / 8 / 30 s utterances; verify partial within ~1.1 s of onset and fluid updates; final replaces partial and only the final hits PTY. Toggle autoSend ON; verify no partial-driven newline. Stop mid-utterance; final wins. Misfire (cough); silent clear of partial slot only. 35 s monologue; verify inline `…` at 30 s.

Automated (Playwright Electron, extending `e2e_test_infra.md`):

- Fixture: `tests/fixtures/voice/long-monologue.wav` — 16 kHz mono PCM, ~10 s, three distinct phrases. Add `long-monologue-noisy.wav` (same content + −20 dBFS pink noise).
- Assert `__voice.getState().lastPartial` becomes non-empty between `onSpeechStart + 800 ms` and `onSpeechStart + 1500 ms`.
- Assert `lastPartial` updates ≥3 times on a 10 s utterance.
- Assert `lastPartial === ''` after `onSpeechEnd`.
- Assert `__transcripts` has exactly one entry matching the final.
- Negative: silence WAV → `partials.delivered === 0`.

**Auto-send invariant (mutation test).** Spy on `window.api.pty.write`. During an active recording, dispatch a synthetic message onto the worker bus: `worker.dispatchEvent(new MessageEvent('message', { data: { type: 'partialResult', seq: 999, text: 'INJECTED PARTIAL' }}))`. Assert the spy is never called. Repeat with autoSend ON. Tests the *invariant* (no path from partial to write), not just the *outcome*.

**Worker death.** Force a worker error via injection. Assert respawn occurs, `statusPill` flashes `Speech model restarting…`, and the rest of the session runs final-only.

**Benchmark.** 30 s torture clip × 5. Fail if any partial >1500 ms more than once or any >3000 ms.

## Alternatives Considered

1. **Moonshine v2 streaming.** Inspecting `node_modules/@huggingface/transformers/src/models/moonshine/modeling_moonshine.js` shows empty subclasses — no encoder KV cache, no `generate_step`. Not available; do not depend on it landing.
2. **Distil-Whisper chunked / Whisper-tiny streaming.** Real ONNX builds exist; comparable English-only constraint. F6.1 candidate.
3. **Cloud streaming (Deepgram/AssemblyAI/Gladia).** Sub-300 ms partials, zero local CPU; violates offline-local promise without explicit opt-in and privacy review. F6.2 candidate.
4. **Cut `redemptionMs: 600 → 200`, finals only.** Cheapest. Doesn't help 5–10 s monologues; fragments natural pauses. See fallback section.
5. **Fixed 1 s chunks.** Word-boundary stutter; no benefit over tail-window.

## What v1 ships if partials prove infeasible

If integration uncovers a blocker (worker fatality too high, encode budget blown on target hardware, pre-roll splice degrades final accuracy), F6 ships a non-streaming fallback rather than nothing:

- Tighten `redemptionMs: 600 → 350`. Speeds finalisation on natural ends ~250 ms; risks fragmenting paused-mid-sentence speech, mitigated by leaving `minSpeechMs` unchanged.
- Keep `voice.statusPill` separation (strict UX improvement regardless).
- Drop `lastPartial`, `onPartial`, pre-roll ring, partial worker opcode, budget tiers.
- Telemetry simplifies to `final.encode_ms` and `final.first_byte_ms`.
- Streaming partials deferred to F6.1 (Distil-Whisper chunked) or F6.2 (cloud opt-in).

Trapdoor, not the plan. v2 expects partials to ship.

## Open Questions

- Is `MIN_PARTIAL_INTERVAL_MS = 400` the right floor, or should it scale with measured encode time?
- Partial + final same DOM node or siblings? Lean siblings with `aria-live="polite"` on final, `aria-hidden="true"` on partial.
- "Machine struggling" indicator threshold? Tentative: surface inline after 1500 ms tier hits twice in a segment.
- Expose `window.__partials` for e2e parity, gated behind `process.env.E2E === '1'`.
- Pre-roll length: 300 ms matches `preSpeechPadMs`; widen to 500 ms? Defer; measure first.

## Sources

- [HuggingFace Transformers — Moonshine model](https://huggingface.co/docs/transformers/main/en/model_doc/moonshine)
- [moonshine-ai/moonshine GitHub](https://github.com/moonshine-ai/moonshine)
- [ricky0123/vad Issue #13 — onFrameProcessed audio frame request](https://github.com/ricky0123/vad/issues/13)
- [ricky0123/vad Issue #186 — concatenating frames from onFrameProcessed](https://github.com/ricky0123/vad/issues/186)
- [@ricky0123/vad-web frame-processor typings](https://app.unpkg.com/@ricky0123/vad-web@0.0.30/files/dist/real-time-vad.d.ts)
- [AssemblyAI — Best real-time speech APIs 2026](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)
- [Gladia — Best open-source STT models 2026](https://www.gladia.io/blog/best-open-source-speech-to-text-models)
