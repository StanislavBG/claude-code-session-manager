# F2 — Disable mic button until model is ready (v2)

Status: Draft v2
Owner: Voice
Last updated: 2026-05-02

## Changes from v1

Folds in `F2-mic-gate.critique.md`:

- **A11y model inverted.** Native `disabled` only for permanently unactionable states (`unsupported`); `aria-disabled` for transient busy/error/idle/permission states. Per MDN `aria-disabled` and Giraudel "On disabled and aria-disabled attributes" (2024-03-29), native `disabled` strips a control from tab order — wrong for a *temporarily* unavailable control.
- **Predicate split.** Pure `selectCanRecord(state) -> { canRecord, reason }` (reused by F1) plus view-layer `useMicGateView()`; copy in `voiceCopy.ts`.
- **Permission slice** via `navigator.permissions.query({name: 'microphone'})` + `change`; surfaces as `'permission-denied'`.
- **No-progress watchdog** (90s since last `progress` event), not 30s wallclock; trips to `error` with `errorKind: 'timeout'`.
- **Retry path** uses new `resetModel()` in `speechRecognition.ts` then `clearError()` then `initModel()`.
- **F1** ships in F1's PRD; imports our `selectCanRecord`.
- **Unsupported** shown disabled with tooltip, not hidden.
- **Click handler** uses `useVoice.getState()` for a fresh read.
- **Click-rejected log** is `debug`, throttled 1/sec.
- **Tooltip and aria-label** use identical wording.

## Problem & Motivation

The mic button (`VoiceButton.tsx:36`) accepts clicks while `modelStatus` is `idle` or `error`. `createRecognition()` spins up `MicVAD` and streams audio, but the worker's Whisper pipeline is not warm — the user sees the recording ring, speaks, gets nothing; audio is dropped silently. The load also kicks off only when `<VoiceButton>` first mounts (`VoiceButton.tsx:16`), fragile if the button is conditionally rendered.

Goals: mic un-clickable until ready (visually and semantically); clear reason copy; eager preload from `<App>`, independent of the button's mount.

## Scope

In: pure `selectCanRecord` + view hook; reasons `idle | loading | error | ready | unsupported | permission-denied | load-timeout`; copy in `voiceCopy.ts`; move eager `initModel()` to `<App>`; `permissionState` slice; no-progress watchdog; throttled debug logging.

Out: F1 hotkey (lives in F1's PRD, consumes our predicate); changing *when* load happens; replacing Whisper/Moonshine; network-aware deferral; persisting "user has used mic before".

## UX Flow

Columns: `aria-disabled` / native `disabled` / visual / tooltip-and-aria-label (identical wording).

| reason | a-d | dis | Visual | Copy |
|---|---|---|---|---|
| `idle` | T | F | dim | "Microphone — speech model not started" |
| `loading` | T | F | dim + pulse + `cursor-wait` | "Microphone — loading speech model, {pct} percent" |
| `ready` idle | F | F | normal | "Start voice input (local Whisper, offline)" |
| `ready` rec | F | F | red ring + pulse | "Stop voice input" |
| `error` | T | F | dim red | "Microphone — speech model error: {error}. Activate to retry." |
| `load-timeout` | T | F | dim red | "Microphone — model load timed out. Activate to retry." |
| `permission-denied` | T | F | dim amber | "Microphone — permission denied. Open OS settings." |
| `unsupported` | T | T | dim | "Microphone — voice input not supported in this build." |

Native `disabled` is set only for `unsupported` since that state cannot flip within a session. Other gated states stay focusable so users can tab to them and (for `error`/`load-timeout`) activate retry. The load progress bar at `LeftNav.tsx:104` is unchanged.

## Technical Design

Predicate in `src/renderer/state/voice.ts`:

```ts
export type GateReason =
  | 'ready' | 'idle' | 'loading' | 'error' | 'load-timeout'
  | 'permission-denied' | 'unsupported'

export const selectCanRecord = (s: VoiceState): { canRecord: boolean; reason: GateReason } => {
  if (!isRecognitionSupported()) return { canRecord: false, reason: 'unsupported' }
  if (s.permissionState === 'denied') return { canRecord: false, reason: 'permission-denied' }
  if (s.modelStatus === 'ready') return { canRecord: true, reason: 'ready' }
  if (s.modelStatus === 'loading') return { canRecord: false, reason: 'loading' }
  if (s.modelStatus === 'error')
    return { canRecord: false, reason: s.errorKind === 'timeout' ? 'load-timeout' : 'error' }
  return { canRecord: false, reason: 'idle' }
}
```

`useMicGateView()` in `VoiceButton.tsx` derives the label via `copyFor(reason, …)` from `voiceCopy.ts`; same string for both `title` and `aria-label`. F1 imports `selectCanRecord` only.

Permission slice (`permissionState: 'granted' | 'denied' | 'prompt' | 'unknown'`) is hydrated at App mount via `navigator.permissions.query({name: 'microphone'})`, with a `change` listener writing back to the store.

Eager preload moves to `<App>`: remove the `useEffect` from `VoiceButton.tsx:16`; add `useEffect(() => { useVoice.getState().initModel() }, [])` near `App.tsx:24`, with the permissions subscription in the same effect. `initModel()` is idempotent (`voice.ts:55`); `preloadModel()` guards via `modelReady || modelLoading` (`speechRecognition.ts:60`).

No-progress watchdog inside `initModel`: on entering `loading`, start a 90s timer; each `progress` event resets it; terminal status clears it; on expiry, set `modelStatus: 'error'`, `errorKind: 'timeout'`.

New export `resetModel()` in `speechRecognition.ts` clears module-level `modelLoading` and `modelReady`; the worker is preserved and the next `preloadModel()` re-posts `load`.

Click handler reads fresh state inline via `useVoice.getState()`:

```ts
const onClick = () => {
  const s = useVoice.getState()
  const { canRecord, reason } = selectCanRecord(s)
  if (s.isRecording) return s.stopRecording()
  if (reason === 'error' || reason === 'load-timeout') {
    resetModel(); s.clearError(); s.initModel(); return
  }
  if (!canRecord) return logRejectedThrottled(reason)
  if (s.activeTabId) s.startRecording(s.activeTabId)
}
```

Render attributes: `aria-disabled={!canRecord}`, `disabled={reason === 'unsupported'}`, `aria-label={label}`, `title={label}`, plus `data-state={reason}` for e2e.

`logRejectedThrottled` holds a module-level `lastLog`; if `performance.now() - lastLog < 1000` the call is dropped, else it logs `mic.gate.click_rejected` at `debug`.

## Edge Cases & Failure Modes

1. **`error`** — focusable; click runs `resetModel()` + `clearError()` + `initModel()`.
2. **No-progress timeout** — 90s since last progress → `error` with `errorKind: 'timeout'`.
3. **Permission revoked mid-session** — `change` flips slice to `'denied'`; gate returns `'permission-denied'`; `modelStatus` stays `'ready'`.
4. **F1 hotkey while gated** — F1 imports `selectCanRecord` and short-circuits identically.
5. **Preload error** — retry resets worker flags and re-posts `load`.
6. **Tab switch while loading** — model is global; `startRecording(tabId)` captures `activeTabId` at click time.
7. **`unsupported`** — disabled+tooltip, not hidden, so users on older Electron / headless CI know why it's off.
8. **Double init under StrictMode / HMR / reload** — guarded at `voice.ts:55` and `speechRecognition.ts:60`; StrictMode unit test covers it.
9. **Click in same frame as ready flip** — handler reads `useVoice.getState()` inline.

## Security & Privacy

Gating prevents `getUserMedia()` before the worker can consume frames, so the OS mic indicator never turns on for audio that will be dropped. Audio never leaves the device (`speechRecognition.ts:1-10`). No new IPC surface.

## Telemetry & Logging

Via `window.api.logs.write('voice', level, event, data)`:

- `mic.gate.click_rejected` — debug, throttled 1/sec.
- `mic.gate.retry` — info on user-triggered error→idle.
- `mic.gate.timeout` — warn on no-progress watchdog.
- `mic.gate.unsupported` — warn once at App mount.
- `mic.gate.permission_changed` — info on `permissions` change.

## Testing Plan

Unit (`voice.test.ts`): `selectCanRecord` returns expected shape for all seven reasons; `initModel` idempotent across rapid double-invoke and StrictMode double-mount; retry from `error` resets `error`, `errorKind`, worker flags, then re-enters `loading`; fake-timer no-progress watchdog trips after 90s.

Playwright (`tests/e2e/mic.spec.ts`): mount cycles `data-state` `loading` → `ready`; click during `loading` calls neither `startRecording` (spied via `__voice`) nor flips `isRecording`; forced worker error + retry cycles `error` → `loading` → `ready`; flipping `permissionState` shows `data-state="permission-denied"`; only `unsupported` carries native `disabled`; tab order includes the button in every non-unsupported state.

## Alternatives Considered

- **Queue the click and auto-start on ready** — rejected; cold download can be 10s+, surprise-recording is worse than a no-op.
- **Modal on click during `loading`** — rejected; the `LeftNav.tsx:104` progress bar already conveys it.
- **Auto-retry with backoff** — rejected for v1; most preload errors are deterministic and silent retries mask them.
- **Hide on `unsupported`** — rejected; discoverability beats visual cleanliness.

## Open Questions

- Should App-level `initModel()` defer until first user interaction to avoid contention with terminal hydration on slow disks?
- Should `error` expose a "Reset cache" affordance for corrupted IndexedDB blobs?
- Is 90s the right no-progress budget, or should it scale with throughput?

## Sources

- [MDN: aria-disabled](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-disabled) — focusable, announceable alternative to native `disabled`.
- [Kitty Giraudel — On disabled and aria-disabled (2024-03-29)](https://kittygiraudel.com/2024/03/29/on-disabled-and-aria-disabled-attributes/) — basis for the inverted mapping.
- [MDN: Permissions.query()](https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query) — basis for `permissionState`.
- [Carbon Design System — Loading pattern](https://carbondesignsystem.com/patterns/loading-pattern/)
