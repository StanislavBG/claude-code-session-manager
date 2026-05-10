# F2 — Disable mic button until model is ready

Status: Draft
Owner: Voice
Last updated: 2026-05-02

## Problem & Motivation

The mic button (`src/renderer/components/VoiceButton.tsx:36`) is currently always interactive when `modelStatus !== 'loading'`, but it accepts clicks while `modelStatus === 'idle'` and `'error'` too. The handle returned by `createRecognition()` will spin up `MicVAD`, request microphone permission, and start streaming frames — but `worker.postMessage({ type: 'transcribe' })` queues into a worker whose Whisper pipeline has not finished `pipeline()` warmup. The user sees the red recording ring, speaks, and gets nothing back. There is no toast, no error, no transcript. This is a silent failure path: the audio is captured, the VAD fires `onSpeechEnd`, the transcribe message is enqueued, but the worker's `load` flow hasn't completed so results never arrive (or arrive with severe delay tied to download throughput). In addition, today the load only kicks off when `<VoiceButton>` first mounts (`VoiceButton.tsx:16`), which is fine for the default layout but fragile if the button is ever conditionally rendered.

We want: (a) the mic visually and semantically un-clickable until `modelStatus === 'ready'`; (b) a clear textual explanation of *why* it is gated; (c) eager preload triggered from `<App>` so the model is warming the moment the renderer mounts.

## Scope

In scope:
- Gating predicate on the mic `<button>` and on `F1` keyboard hotkey.
- Visual states for `idle`, `loading`, `error`, `ready`, plus `unsupported`.
- Tooltip / aria copy for each state.
- Move the eager `initModel()` call from `<VoiceButton>` to `<App>` so the load is independent of the button's mount state.
- File logging when a click is rejected by the gate.

Out of scope (explicitly):
- Changing *when* the model load happens beyond moving from VoiceButton-mount to App-mount (i.e., we are NOT debating "load on app start vs. load on first user intent vs. load on idle callback" in this PRD — the current "eager on mount" behavior is preserved).
- Replacing Whisper / Moonshine, changing model size, or quantization decisions.
- Network-aware deferral, metered-connection prompts.
- Persisting "user has used mic before" so we could skip the load entirely on cold start.

## UX Flow

| modelStatus | Button enabled? | Visual | Tooltip | aria-label |
|---|---|---|---|---|
| `idle` (pre-init, brief) | no | dim, no pulse | "Speech model not started" | "Microphone — speech model not started" |
| `loading` | no | dim + `animate-pulse` + `cursor-wait` | "Loading speech model… {pct}%" | "Microphone — loading speech model, {pct} percent" |
| `ready` (not recording) | yes | normal `text-fg-dim hover:text-fg` | "Voice input (local Whisper, fully offline)" | "Start voice input" |
| `ready` (recording) | yes | red ring + pulse | "Stop recording" | "Stop voice input" |
| `error` | no, but focusable | dim red | "Speech model failed: {error}. Click to retry." | "Microphone — speech model error, press Enter to retry" |
| unsupported | no | hidden entirely | n/a | n/a |

`RecordingStatus` already renders the progress bar (`LeftNav.tsx:104`); we keep it. The button's own visual is intentionally minimal because the bar carries the percent.

Accessibility: we use `aria-disabled="true"` plus a click guard rather than the native `disabled` attribute for `idle`/`loading`/`error`, because (1) `disabled` removes the element from tab order, hurting discoverability of *why* the control is unavailable, and (2) `error` state needs to remain focusable so Enter can trigger a retry. We keep the native `disabled` only when `modelStatus === 'loading'` and there is no actionable retry — that matches the platform expectation for a non-actionable busy control. References: MDN aria-disabled and Kitty Giraudel's writeup (cited below).

## Technical Design

Predicate (single source of truth, lives in voice store):

```ts
// in src/renderer/state/voice.ts — derived selector helper
export const selectMicGate = (s: VoiceState): {
  canRecord: boolean
  reason: 'ready' | 'idle' | 'loading' | 'error' | 'unsupported'
  message: string
} => {
  if (!isRecognitionSupported()) return { canRecord: false, reason: 'unsupported', message: 'Audio worklet unavailable' }
  if (s.modelStatus === 'ready') return { canRecord: true, reason: 'ready', message: '' }
  if (s.modelStatus === 'loading') return { canRecord: false, reason: 'loading', message: `Loading speech model… ${s.loadingProgress}%` }
  if (s.modelStatus === 'error') return { canRecord: false, reason: 'error', message: s.error ?? 'Model failed to load' }
  return { canRecord: false, reason: 'idle', message: 'Speech model not started' }
}
```

Eager preload moves to `<App>`:
- Remove `useEffect(() => { initModel() }, [initModel])` from `VoiceButton.tsx:16`.
- Add the same effect in `App.tsx` adjacent to `useVoiceTTS(activeTabId)` at line 24. `initModel()` is already idempotent — it short-circuits on `modelStatus !== 'idle'` (`voice.ts:55`) and `preloadModel()` further guards via `modelReady || modelLoading` (`speechRecognition.ts:60`).

Click handler in `VoiceButton.tsx`:

```ts
const gate = useVoice(selectMicGate)
const onClick = () => {
  if (isRecording) { stopRecording(); return }
  if (gate.reason === 'error') { initModel(); return }   // retry path
  if (!gate.canRecord) {
    window.api.logs.write('voice', 'info', 'mic click rejected', { reason: gate.reason })
    return
  }
  if (activeTabId) startRecording(activeTabId)
}
```

Render:

```tsx
<button
  onClick={onClick}
  aria-disabled={!gate.canRecord && gate.reason !== 'error'}
  disabled={gate.reason === 'loading'}
  aria-label={ariaLabelFor(gate, isRecording)}
  title={gate.message || titleFor(isRecording)}
  data-testid="mic-button"
  data-state={gate.reason}     // for e2e selectors
  className={…}
/>
```

Integration points:
- `src/renderer/components/VoiceButton.tsx:18` — replace `toggle` with the gated handler.
- `src/renderer/components/VoiceButton.tsx:38` — split `disabled` from `aria-disabled`.
- `src/renderer/components/VoiceButton.tsx:16` — delete; move to App.
- `src/renderer/App.tsx:24` — add `useEffect(() => { useVoice.getState().initModel() }, [])`.
- `src/renderer/state/voice.ts` — export `selectMicGate`.
- F1 hotkey (search `keydown` listeners; if none for F1 yet, this PRD adds nothing — F2 ships only the button gate. If/when F1 lands it MUST consult `selectMicGate`.).

## Edge Cases & Failure Modes

1. **`modelStatus === 'error'`** — keep the button focusable, show red dim styling, and treat the click as `initModel()` retry. `initModel` early-returns on non-`idle`, so we additionally `set({ modelStatus: 'idle' })` before calling it on the retry path.
2. **Loading stuck >30s** — start a timer in `initModel` when transitioning to `loading`; if no `progress` event arrives within 30s, set `modelStatus: 'error'` with `"Model load timed out — check network"`. Progress events reset the timer.
3. **Permission revoked between ready and click** — `MicVAD.new()` rejects with a `NotAllowedError`; current `try/catch` at `speechRecognition.ts:188` already feeds `opts.onError`. We add a separate gate state when `error` includes `Permission` so the button shows "Microphone permission denied — open OS settings". No model retry on this path.
4. **User holds F1 while model not ready** — gate predicate returns `canRecord: false`; hotkey handler logs once per keydown (not on auto-repeat: check `e.repeat`).
5. **Error during preload** — `preloadModel` posts `{type: 'error'}` from the worker; voice store transitions to `error` and surfaces in tooltip. Retry resets to `idle` and re-posts `load`. Worker is reused, so the second attempt does not respawn it.
6. **Simultaneous tab switches while loading** — model is global state, not per-tab. Tab switches are no-ops against the gate. `startRecording(tabId)` captures the *current* `activeTabId` at click time; switching tabs after recording starts continues to write to the original tab — this is preserved behavior, not regressed.
7. **`isRecognitionSupported() === false`** — we hide the button entirely (return `null`) rather than showing a permanently-disabled control. Rationale: it can never become true within a session.
8. **`preloadModel` called twice** — guarded at `speechRecognition.ts:60` (`if (modelReady || modelLoading) return`) AND at `voice.ts:55` (`if (get().modelStatus !== 'idle') return`). We verify both still fire under React 18 StrictMode double-invoke by adding a unit test.
9. **Race: click lands in the same frame `modelStatus` flips to ready** — Zustand subscription is synchronous; the gate read inside `onClick` sees the latest state. No issue.

## Security & Privacy

Gating prevents `getUserMedia()` from being invoked before the model can consume frames. Even though no audio leaves the device (Whisper runs locally per `speechRecognition.ts:1-10`), starting capture under `loading` would mean the OS mic indicator turns on, the user speaks, and the audio is silently dropped — a privacy-perception bug. Holding capture until `ready` keeps the mic-on indicator and the user's expectation aligned. No new IPC surface is introduced.

## Telemetry & Logging

Use the existing renderer logger (`src/renderer/lib/logger.ts` → `window.api.logs.write` from `src/main/logs.cjs`). Events:

- `voice.gate.click_rejected` — `{reason, loadingProgress}` at info.
- `voice.gate.retry` — when error→idle transition triggered by user click.
- `voice.gate.timeout` — at warn when 30s loading timeout fires.
- `voice.gate.unsupported` — at warn at App mount if `isRecognitionSupported() === false`.

No new metrics counters; we lean on log scraping for now.

## Testing Plan

Unit (`src/renderer/state/__tests__/voice.test.ts`):
- `selectMicGate` returns the correct shape for each of the five `modelStatus` values plus the unsupported branch (mock `isRecognitionSupported`).
- `initModel` is idempotent across rapid double-invoke.

Playwright e2e (extends `tests/e2e/mic.spec.ts` per project's e2e infra):
- App mount → mic button has `data-state="loading"` then `"ready"` within model-load budget.
- Click during `loading` does not call `startRecording` (assert via `__transcripts` stays empty and `isRecording === false`).
- Forced error path: stub worker to post `{type:'error'}`; verify retry click resets to `idle` and re-posts.
- `aria-disabled` attribute matches expected per state; tab order includes the button when in `error`/`idle`.

## Alternatives Considered

1. **Queue the click**: capture the intent during `loading` and auto-start when `ready` fires. Rejected: can be a long delay (10s+ for cold download), user has likely moved on, surprise-recording is worse than a no-op click. Could be a follow-up if metrics show users repeatedly clicking during load.
2. **Modal on click during `loading`**: blocking dialog explaining the wait. Rejected: heavyweight for a sidebar control; the inline progress bar at `LeftNav.tsx:104` already conveys the same info ambiently.
3. **Auto-retry on error**: exponential backoff on preload errors. Rejected for v1: most preload errors are deterministic (offline, corrupted cache, OOM) and silent retries mask them. We surface error and let the user click retry.

## Open Questions

- Should the App-level `initModel()` defer until first user interaction to avoid contending with terminal hydration on slow disks? (Current PRD says no — preserve eager.)
- Do we want a "Skip voice setup" preference that suppresses preload entirely for users who never use the mic? Out of scope, file as F-future.
- Should `error` state expose a "Reset cache" affordance? Many preload failures are corrupted IndexedDB blobs.

## Sources

- [MDN: aria-disabled attribute](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled)
- [Kitty Giraudel — On disabled and aria-disabled attributes](https://kittygiraudel.com/2024/03/29/on-disabled-and-aria-disabled-attributes/)
- [CSS-Tricks — Making Disabled Buttons More Inclusive](https://css-tricks.com/making-disabled-buttons-more-inclusive/)
- [UXPin — Button States Explained: The Complete Design Guide for 2026](https://www.uxpin.com/studio/blog/button-states/)
- [Smart Interface Design Patterns — Designing Better Loading and Progress UX](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/)
- [Carbon Design System — Loading pattern](https://carbondesignsystem.com/patterns/loading-pattern/)
