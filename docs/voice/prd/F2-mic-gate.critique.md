# F2 Mic Gate — Adversarial Critique

## Verdict

Conditional approval. Direction is right, but several technical claims are wrong, the predicate shape is over-fit to v1 and will need rework when F1 (hotkey) lands, and at least three edge cases are silently mis-specified. Treat this as a v1 draft that needs another pass before implementation.

## Severe issues

1. **`disabled` semantics are inverted from the cited guidance.** The PRD says use native `disabled` only during `loading` and `aria-disabled` for `idle`/`error`. The MDN/Giraudel guidance the PRD cites argues the opposite for *busy* states: a control mid-load is exactly the case for `aria-disabled` (announceable, focusable, discoverable) — not native `disabled`, which strips it from the tab order while progress is happening. Native `disabled` is appropriate for *permanently* unactionable states (e.g., `unsupported`, except the PRD hides those entirely). Recommend: `aria-disabled` for all four non-ready states, drop native `disabled` everywhere, click-guard in JS.

2. **`selectMicGate` shape is wrong for F1 reuse.** F1 is a global keydown listener; it has no DOM context, so `message` (a localized UI string) is dead weight to it. F1 needs `canRecord` plus a `reason` enum to log/toast — nothing more. Conversely the button needs the styling class and aria-label, which the predicate doesn't provide. Both consumers will end up with dead fields. Split it: a pure `selectCanRecord(s) -> { canRecord, reason }` (consumed by both) and a `useMicGateView()` hook that derives `{message, ariaLabel, className}` from that plus `isRecording`. Also: `reason` should be a TS string-literal union (it is in the PRD draft) — call that out as the SoR enum, and add `'permission-denied'` (see issue 5).

3. **`message` is not localizable.** Strings are hard-coded in the predicate. If the app ever ships i18n the strings live in store code, not a translation catalog. Move all user-facing copy out of the store; predicate returns `reason` only, view layer maps `reason -> i18n key`.

4. **Eager init at `App.tsx:24` runs every renderer mount including reload.** The PRD explicitly preserves "eager on mount" — fine — but doesn't acknowledge that StrictMode double-invoke + dev HMR + window reload all re-fire the effect. `initModel` short-circuits on `modelStatus !== 'idle'`, but `preloadModel`'s module-level `modelLoading`/`modelReady` flags survive HMR module replacement *only sometimes* (depends on Vite cache invalidation rules). PRD should explicitly assert: predicate idempotency under (a) StrictMode, (b) HMR module replacement, (c) explicit `location.reload()`. Add a unit test for at least (a); document (b)/(c) as known dev-only quirks.

5. **Permission revocation between `ready` and click is unhandled.** The predicate has no input for `PermissionStatus`. If the user revokes mic access in OS settings while the app is open, `gate.canRecord === true` until `MicVAD.new()` rejects with `NotAllowedError` — at which point we land in `error` state, but `modelStatus` is still `ready`, so the UI will be in a contradictory state (model ready, but a recording attempt failed). The PRD waves at this in edge case 3 but doesn't specify how `error` interacts with `modelStatus === 'ready'`. The voice store conflates "model error" and "recording error" into the same `error: string | null` field today (`voice.ts:50`); F2 inherits that bug. Recommend: add `permissionStatus` to the store via `navigator.permissions.query({name: 'microphone'})` + `change` listener, surface as a distinct `reason: 'permission-denied'`, and stop calling that an `error`.

6. **30s loading timeout is asserted in scope but never specified concretely in the design.** Edge case 2 mentions "30s" but `initModel` in the PRD's pseudocode doesn't show the timer. Specify: `setTimeout(30_000)` cleared on every progress event and on terminal status, fired action sets `{modelStatus: 'error', error: 'Model load timed out — check network'}`. Also: 30s is wrong for a cold model download on a slow connection — Whisper-tiny is ~40MB, that's a hard fail at 1.5MB/s. Either base it on bytes/no-progress (e.g., "no progress for 15s") or raise to 90s wallclock.

## Moderate issues

7. **Retry path mutates state unsafely.** PRD says retry calls `set({ modelStatus: 'idle' })` then `initModel()`. `initModel` doesn't clear `error` — so the next render shows red dim styling with `modelStatus === 'loading'`, which doesn't match any row in the UX flow table. Also, the worker may already hold a transcribe queue; reposting `load` without resetting worker-side flags can race. Spec needed: retry must call `clearError()` and reset worker flags `modelLoading = false` (currently set to `false` only on `error`, but a stuck-loading state never clears them).

8. **Edge case 7 (`unsupported` hides the button) is the wrong default.** Hiding a control with no explanation is a worse UX than a dim disabled control with a tooltip "Voice input not supported in this build". Users on older Electron, headless CI, or stripped Chromium have no signal that the feature exists. Counter-argument: discoverability matters more than visual cleanliness here, and the surface is a 16x16 sidebar icon. Reconsider.

9. **`data-testid="mic-button"` plus `data-state` is OK, but the e2e test for "Click during loading does not start recording" is weak.** Asserting `__transcripts` empty is a negative-after-N-seconds test, which is flaky. Better: assert `isRecording === false` *and* spy on `startRecording` calls (the test infra exposes `__voice` per `voice.ts:140`).

10. **F1 integration is hand-waved.** The PRD says "F2 ships only the button gate. If/when F1 lands it MUST consult `selectMicGate`" — but F1 is listed as in-scope at line 16 ("Gating predicate on the mic `<button>` and on `F1` keyboard hotkey"). Pick one: either ship F1 hooked to the same predicate now, or remove F1 from scope. As written it's both in and out of scope.

11. **Logging cardinality.** `voice.gate.click_rejected` will fire on every rejected click; users who don't realize the model is loading will spam clicks. Add throttling (e.g., dedupe within 1s) or move to `debug` level — info-level mic-spam in logs masks real events.

## Minor / nits

- Edge case 4 ("user holds F1") references `e.repeat` for hotkey logic that isn't shipped here; either move to the F1 PRD or scope it as a placeholder note.
- Edge case 9 ("race: click lands in same frame status flips") asserts "Zustand subscription is synchronous" — true, but the relevant guarantee is that `useVoice(selector)` reads via a React subscription which is *not* synchronous with state updates outside React batching. The cited safety actually comes from reading `getState()` inline in the click handler, which the pseudocode doesn't do (it uses `useVoice(selectMicGate)`). Either rewrite the click handler to use `useVoice.getState()` or weaken the claim.
- "References: MDN aria-disabled and Kitty Giraudel's writeup (cited below)" — the cited writeup explicitly says native `disabled` is rarely the right choice, contradicting the PRD's own design decision. Reread.
- `loadingProgress: 100` set by both `preloadModel` ready-handler and `voice.ts:62` is fine but redundant; nit.
- Tooltip copy `"Speech model failed: {error}. Click to retry."` plus `aria-label` `"...press Enter to retry"` — mouse users see "click", screenreader hears "Enter". Inconsistent. Use one verb across modalities or omit the affordance hint and rely on focus + role.
- Telemetry events are namespaced `voice.gate.*` but renderer logger is `log.info('voice', ...)` — pick one taxonomy.

## Suggestions for PRD v2

- **Restructure the predicate.** `selectCanRecord(state) -> { canRecord, reason }` lives in `voice.ts`. View concerns (className, message, ariaLabel) move to a `useMicGateView()` hook in `VoiceButton.tsx`. F1 imports `selectCanRecord` only.
- **Fix the a11y model.** `aria-disabled` for all gated states, no native `disabled`. Click guard in JS, never in markup. Add `role="button"` only if you change the underlying element.
- **Add a `permissionStatus` slice** to the store, watched via `navigator.permissions.query`. Distinguish "model not ready" from "permission denied" as separate gate reasons.
- **Specify timeout concretely.** No-progress watchdog (15s since last `progress` event) rather than wallclock budget. Surface as `error` reason `'load-timeout'`.
- **Pull copy out of the store.** All user-facing strings in a single `voiceCopy.ts` keyed by gate reason. Predicate returns reason only.
- **Decide F1 scope.** Either include the keydown listener wired to `selectCanRecord` in this PRD with tests, or strike F1 from the in-scope list entirely.
- **Reconsider hide-on-unsupported.** Default to disabled+tooltip; only hide if telemetry shows it's confusing.
- **Add tests for:** retry-after-error path with full state assertions (modelStatus, error, loadingProgress all reset); StrictMode double-invoke of App-level effect; permission revoke mid-session; no-progress timeout.

Files referenced:
- /home/bilko/Projects/session-manager/docs/voice/prd/F2-mic-gate.md
- /home/bilko/Projects/session-manager/src/renderer/state/voice.ts
- /home/bilko/Projects/session-manager/src/renderer/components/VoiceButton.tsx
- /home/bilko/Projects/session-manager/src/renderer/components/LeftNav.tsx
- /home/bilko/Projects/session-manager/src/renderer/App.tsx
- /home/bilko/Projects/session-manager/src/renderer/lib/speechRecognition.ts
