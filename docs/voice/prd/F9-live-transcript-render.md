# F9 — Live Transcript Render (Streaming Captions)

**Status:** v1 — ready to implement
**Owner:** voice
**Depends on:** F6 (streaming partials, backend-complete), F1 (push-to-talk), F2 (mic gate)

---

## Problem

The user perceives mic input as "all at once." Symptom: they speak, see nothing, then 1.2 s after they stop speaking the entire utterance lands in the terminal in a single `pty.write`. They expect the dictation pattern they know from macOS Dictation, Google Docs voice typing, and ChatGPT voice mode: **provisional text appears within ~500 ms of speaking and updates as they continue, then commits cleanly when the turn ends.**

## Root cause

F6 backend is complete: `whisperWorker.ts` runs `transcribe-partial` on a 6 s tail window every ~500 ms, posts back `{type:'partial', text, seq}`, and the host writes it to `voice.lastPartial`. **But `lastPartial` is never rendered.** `grep -rn lastPartial src/` returns zero hits outside `state/voice.ts` and `lib/speechRecognition.ts`. The store slice was wired in F6 with a deferred-render note ("kept as a slice so a follow-up render lands without another store migration") and the follow-up never landed.

Secondary: even when rendered, raw partials would flicker — successive encodings of the same audio re-tokenize from scratch and small early-frame disagreements ripple through the whole string. Industry solution is **LocalAgreement-2** (Macháček, Dabre & Bojar 2023, "Turning Whisper into Real-Time Transcription System"): emit only the longest common prefix between the last two partial outputs. Used by `whisper_streaming` and downstream by Riva, AssemblyAI Universal-Streaming, et al.

## Goals

1. **Visible streaming text within ≤700 ms of voice onset.** (Today: ∞ — never visible until final.)
2. **Stable, non-jittery prefix.** New characters only ever append at the right edge during a turn — they don't rewrite earlier words. (Achieved via LocalAgreement-2.)
3. **Clean commit semantics.** Final still goes to pty exactly once; overlay clears immediately on `onFinal`/`onMisfire`/`stopRecording`. F6 invariant preserved: **partials never call `pty.write`**.
4. **Privacy parity.** While the overlay is mounted, `RecordingStatus` is mounted (existing invariant). Partials don't leak to logs (existing F6 PRD §Security).
5. **A11y.** `aria-live="polite"` on the overlay; final commit announced via existing pty path.

## Non-goals

- Writing partials into the terminal/pty itself. Bracketed-paste preview was considered and rejected: it bleeds tentative text into shell readline state, fights with user typing, and risks corrupting input on misfire. The overlay is positioned over the terminal so it *feels* in-line.
- Multi-language partials. Moonshine Base is English-only (existing F6 constraint).
- Word-level fade/slide animations. Out of scope for v1; the prefix-locking already gives a clean left-to-right reveal because LocalAgreement-2 only ever appends.

## Design

### Render layer

New component `src/renderer/components/LiveTranscript.tsx`:

- Mounts inside `MainPane` (terminal pane), positioned absolute, anchored to bottom-center of the terminal viewport, ~70% width, max two lines.
- Subscribes via `useShallow` to `{ isRecording, statusPill, lastPartial, lastTranscript, submitCountdownStartAt }`. Hidden when `!isRecording && !lastPartial && !lastTranscript`.
- Three visual zones:
  - **Status chip** (left): icon + tiny label from `statusPill` (`listening` / `transcribing` / `restarting`). Reuses existing `RecordingStatus` palette.
  - **Provisional text** (center): `lastPartial`, italic, opacity 0.85, monospace font matching xterm. Wraps to two lines max; tail-truncates from the LEFT with a leading "…" if longer (so the most recent words are always visible).
  - **Submit countdown** (right): existing `<SubmitCountdown />` already exists; reuse if active.
- Fades out (300 ms) when `isRecording` flips false AND `submitCountdownStartAt === null`.
- A11y: `role="status"` `aria-live="polite"` `aria-atomic="false"`. The `aria-label` includes the prefix "Dictation preview:" so screen readers don't confuse it with terminal output.
- Click target: clicking the overlay is a no-op in v1. Future: tap-to-edit before commit.

### Engine layer — LocalAgreement-2 (LA-2)

In `src/renderer/lib/speechRecognition.ts`, add a per-handle stabilizer between worker `partial` arrival and `opts.onPartial(text)`:

```ts
let prevPartial = ''
let stablePrefix = ''

function stabilize(curr: string): string {
  // O(min(|prev|, |curr|)).
  const lcp = longestCommonPrefix(prevPartial, curr)
  prevPartial = curr
  // Only grow stablePrefix; never shrink mid-turn.
  if (lcp.length > stablePrefix.length) stablePrefix = lcp
  return stablePrefix
}
```

Reset `prevPartial`/`stablePrefix` on `onSpeechStart` and `resetPartialState()`. The exposed `onPartial(text)` payload to the host is the stabilized prefix. This eliminates the "word-substitution flicker" that plain Whisper streaming exhibits.

### Engine layer — first-partial floor + adaptive cadence

Currently `MIN_PARTIAL_AUDIO_MS = 800` and `PARTIAL_INTERVAL_MS_DEFAULT = 500`. With Moonshine-Base on a typical M-series / modern x86, encode latency for a 1-3 s tail is ~150-250 ms. We can tighten:

- `MIN_PARTIAL_AUDIO_MS`: 800 → **400 ms**. Rationale: the silence-prefix-hallucination concern from the F6 critique was empirically tied to <250 ms inputs (zero-padding-driven). 400 ms is comfortably above that floor and shaves a perceptible chunk off time-to-first-partial. LA-2 also kills any short-prefix wobble.
- `PARTIAL_INTERVAL_MS_DEFAULT`: 500 → **300 ms** initial; existing `PARTIAL_SLOWDOWN_MS=1500` / `PARTIAL_DISABLE_MS=3000` backoff stays. With LA-2 the host can render every arrival without flicker, so faster cadence is purely an upside on fast hosts and self-throttles on slow hosts.
- Add a one-time wallclock probe on the first partial of the session: if encode > 600 ms, bump `partialIntervalMs` to 500 ms for the rest of the session (preserves the existing backpressure ladder).

### Telemetry

In `whisperWorker.ts` `transcribe-partial`, emit a single info-level log on the first partial of each segment with `{ms, samples}` (already there at debug — promote to info, conditional on `seq===firstPartialSeq`). This gives us a single "time-to-first-partial" number we can chart later.

In `voice.ts`, when `onPartial` first fires for a segment, log `voice.partial.first` with `{tabId, msSinceSpeechStart}`. Single-shot per segment; reset on `onSpeechStart`.

## Files

| Path | Owner | Action |
|---|---|---|
| `src/renderer/components/LiveTranscript.tsx` | UI | NEW |
| `src/renderer/components/MainPane.tsx` | UI | mount `<LiveTranscript />` inside the terminal pane wrapper near line 198–215 |
| `src/renderer/state/voice.ts` | UI (read), Engine (no change) | export a `selectLiveTranscript` shallow selector |
| `src/renderer/lib/speechRecognition.ts` | Engine | LA-2 stabilizer + cadence constants + first-partial probe |
| `src/renderer/lib/whisperWorker.ts` | Engine | promote first-partial log to info (1 line) |
| `e2e/live-transcript.spec.mjs` | Tests | NEW — Playwright spec using the existing fake-audio fixture pattern from `e2e/mic.spec.mjs` |
| `docs/voice/prd/F9-live-transcript-render.md` | Docs | this file |

## Acceptance

1. Tab into terminal, hit mic, speak "hello world" with a normal cadence. Expected: provisional italic text appears within ~700 ms of "hel-", grows to "hello world" mid-utterance without rewriting earlier characters, and the final commits to the pty cleanly. Overlay clears within 300 ms.
2. Speak then pause silently for 5 s. Overlay text persists during VAD redemption (1.2 s) then clears as final commits.
3. Trigger a VAD misfire (cough). Overlay clears within 100 ms; nothing lands in pty.
4. Disable partials via `setPartialsEnabled(false)`. Overlay shows only the status chip (no provisional text); final still commits.
5. Worker death mid-segment. `statusPill` flips to `restarting`; overlay shows that label; partials silently stop for the rest of the session (existing finalOnlyMode); finals still commit.
6. Privacy: `RecordingStatus` is mounted whenever `<LiveTranscript />` shows provisional text. Verified by Playwright.
7. `npm run typecheck` passes. `npm run test:e2e` passes including the new spec.

## Out-of-band risks

- LA-2 can stall when the model legitimately wants to *correct* an earlier word it got wrong (e.g. "to" → "two"). Trade-off accepted: a rare wrong-word-locked-in is less bad than constant flicker, and the final encode (full segment) is what actually goes to pty — so any LA-2 lock-in is overlay-only and never poisons commit.
- Faster cadence on slow hosts: covered by the existing `PARTIAL_SLOWDOWN_MS`/`PARTIAL_DISABLE_MS` ladder + the new first-partial probe.

## Rollback

All three layers are independent and can be disabled separately:
- UI: feature flag the `<LiveTranscript />` mount on `voice.partialsEnabled` (already a kill switch).
- Engine LA-2: gate the stabilizer call on a const `LA2_ENABLED = true`; flip to false to revert to raw partials.
- Cadence: revert the four constant edits.
