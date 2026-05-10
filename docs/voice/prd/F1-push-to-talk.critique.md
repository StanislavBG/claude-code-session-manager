# F1 Push-to-Talk PRD — Adversarial Critique

## Verdict

The PRD has the right shape — modes, state machine, edge-case enumeration, telemetry — but it overstates how solid the Wayland story is, hand-waves the macOS default's *actual* collision (Cmd+Shift+Space is the system "Select previous input source" hotkey, not free), introduces a triple-redundant key-capture stack that will fight itself in dev, and quietly grafts on `requestSingleInstanceLock` and a tray-icon mandate as "in scope" without re-scoping the work. Several edge cases are answered with one-liners that paper over real ambiguity (modifier-release timing, blur-during-armed, model-error during armed). It is *draftable* into v2 but should not be implemented as written.

## Severe issues

- **Wayland claim is aspirational, not viable today (lines 70, 160-164).** The cited issues #45607 / #49806 / #15863 plus PR #45171 describe `GlobalShortcutsPortal` as *experimental and gated by a runtime feature flag that not all distros / portal versions support*. The PRD says "set `app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')` so the XDG portal handles Wayland" as if that is sufficient. It isn't: it requires a recent `xdg-desktop-portal` (>=1.17) with the GlobalShortcuts interface, GNOME 45+/KDE 6+, and even then the user must approve the binding through a portal dialog every session in some configurations. The PRD also never specifies which Electron version is in use — the regression in #49806 is in 40.x, and if this codebase is on a 40.x release the proposed flag does not even fix the local-window case. **Action required:** specify Electron version, gate `voice.hotkey.global` behind a runtime portal-availability probe, document the user-visible "binding lost on logout" behavior, and demote global-on-Wayland to "experimental, opt-in, no SLA."

- **Three-layer key capture will double-fire (lines 66-71).** Layer 1 (`before-input-event`) and Layer 2 (document `keydown`) both fire in the renderer for the same physical keystroke when DevTools is *not* open; the `data-voice-hotkey-host` flag is described as preventing double-fire, but `before-input-event` is in the *main* process — it cannot read a renderer DOM attribute synchronously. The only way to dedupe is an in-renderer guard that ignores the next document keydown after an IPC `voice:hotkey down`, which is racy under window-blur. Worse: when `globalShortcut` is also registered, focused-window presses fire *both* `globalShortcut` and `before-input-event`. The PRD acknowledges `source: 'window'|'global'` in the IPC payload but never says which one wins. **Action required:** pick one path per focus state (global if registered AND window not focused; window-local otherwise) and unregister/re-register `globalShortcut` on `browser-window-focus`/`blur`, *or* drop the renderer-document layer entirely and only fall back when `before-input-event` is provably broken.

- **Default chord on macOS is not free (line 36).** Cmd+Shift+Space is bound to "Select the previous input source" in System Settings → Keyboard → Keyboard Shortcuts → Input Sources. It is enabled by default on every Mac that has ever had more than one input source added (and it's enabled-by-default in fresh installs in some recent macOS releases regardless). The PRD's rationale "Cmd+Space is Spotlight" sidesteps this. It will silently steal focus, switch keyboard layout, and *also* maybe trigger our hotkey. **Action required:** change macOS default to something genuinely uncontested (e.g. `Cmd+Option+V` or `F19` if available) or document the conflict explicitly in the Settings UI.

- **Modifier-release timing is hand-waved (line 100).** "Listen for `keyup` on the *non-modifier* only" does not survive `Ctrl+Shift+Space` where the user releases Ctrl first: at that instant, `Ctrl+Shift+Space` is no longer the "active chord" — `before-input-event` reports `Shift+Space` as a *new* chord on the next OS-level event boundary. Some platforms suppress the keyup of `Space` entirely once a modifier is released first; on Wayland under XWayland this is reproducible. Hold-to-talk under that release order will appear to never stop. The state machine has no rule for it.

- **Scope creep: single-instance lock and tray icon (lines 98, 105).** `app.requestSingleInstanceLock()` is *not* currently in `src/main/index.cjs` (verified). The PRD says "Add" it as a one-liner under edge case #11, but the implications (second-launch handling, focus-existing-window UX, dock/taskbar behavior on macOS, dev workflow with `SM_DEV=1`) are non-trivial and unspecified. Same for the tray icon under Security & Privacy: it is described as a hard requirement ("MUST keep the recording indicator visible … the OS tray icon turns red") yet listed under Open Questions #6 as "split? Recommend split." Either the tray is a blocker for the privacy invariant (then F1 cannot ship without it) or it is not (then the privacy section is wrong). Pick one.

## Moderate issues

- **State machine is incomplete (lines 57-64).** No `error` state (model crashed mid-recording), no `destroyed` state (window closed during `recording`), no transition for `armed + window blur`, no transition for `armed + model -> error`. The `stopping --(transcribe drained)--> idle` edge silently absorbs a worker timeout — what if drain never completes? `stopRecording()` in `voice.ts:117` already has a comment about awaiting drain, but with no timeout. Add an `aborted` terminal state and a 10s drain watchdog.

- **8-second arm-window is arbitrary and not "push to talk" (line 70).** When `global && mode=hold` degrades to "press-arms-for-8s," that is functionally a toggle with auto-stop — not push-to-talk in any sense the user expects. Either label it "press-and-hold not supported in global mode, falling back to toggle" in the UI, or use VAD `redemptionMs` for natural termination and drop the fixed window. Open Question #4 admits this is unresolved; that means hold-mode-global is not actually designed yet.

- **Auto-repeat handling is wrong on the renderer side (line 99).** The PRD says "discard `event.isAutoRepeat`" — that property exists on Electron's `Input` event (main process), but the *DOM* `KeyboardEvent` uses `event.repeat`. The fallback layer (#2) will leak repeats. Also: macOS does not auto-repeat modifier-only or modifier+space chords by default for most users, but it *does* if "Press and hold" is disabled and `ApplePressAndHoldEnabled` is false — the PRD does not handle this.

- **Telemetry rule "no transcript content" is a new invariant (line 122).** Spot-check `voice.ts` and `speechRecognition.ts`: existing logging via `log.info('voice', …)` and `log.error('voice', 'recognition error', { err })` already passes structured `meta` objects, but `lastTranscript` is settable from interim text and there is no enforced lint/test that prevents a future contributor from logging it. The PRD asserts the rule but does not specify enforcement (e.g. a `voice-hotkey` logger wrapper that strips known transcript fields, or a typecheck). Without enforcement it's a comment, not a control.

- **`preSpeechPadMs: 300` claim (line 84, 97) is misleading.** That pad is *internal to the VAD ring buffer* — it backfills 300 ms before the VAD detected speech, which only helps if the mic has been *open and feeding the VAD* for >=300 ms before the user spoke. On a fresh hotkey press, `getUserMedia` + worker spawn + VAD `start()` takes far longer than 300 ms (cold path), so the first phoneme will still be clipped on the first press of the session. The PRD treats this as solved.

- **Settings UI capture-the-next-chord (line 51) has no spec.** What counts as a valid chord? `globalShortcut.register` accepts a different grammar than `before-input-event` (e.g., `CommandOrControl+Alt+0`); the renderer fallback uses DOM `KeyboardEvent.code`. The capture widget needs to validate against all three grammars and surface the lowest common denominator. Not mentioned.

- **Edge case #5 (line 92) "chord schema forbids plain alphanumerics"** — schema not specified anywhere. Where is the schema? Open Question #2 implies it doesn't exist yet.

## Minor / nits

- Line 41: "Minimum hold of 150 ms before activation" conflicts with the goal of catching the first phoneme; 150 ms is well into the first syllable of a fast utterance. Consider 80-100 ms or making it configurable.
- Line 49: "Cooldown after toggle stop: 250 ms grey check" — why? No rationale.
- Line 96: "30 s hard-stop watchdog" — unrelated to the 5-min toggle auto-stop on line 42; pick consistent terminology.
- Line 138: "Concurrent global Discord PTT bound to same chord" — Discord defaults vary, this is an underspecified manual test.
- The PRD references `src/renderer/components/VoiceButton.tsx:36`, `:18`, `:45`, and `LeftNav.tsx:89` without verifying those line numbers haven't drifted. `LeftNav.tsx:89` does point at `RecordingStatus` (verified). The others are unverified in this critique.
- Edge case #4 (line 91) "Key held during app launch — listeners don't exist before `ready-to-show`; pre-init keydowns are ignored" — fine for window-local, but `globalShortcut.register` is called inside `app.whenReady().then(...)` which is *after* `ready-to-show` in this codebase's flow (verified at `index.cjs:192`+). A user holding the chord during cold start will get a delayed global trigger when the registration completes, then a missed keyup. Not addressed.
- Line 165-169: the "Voice UI Design Guide 2026 — Fuselab Creative" and "Voice AI & Voice Agents" sources contribute nothing technical; remove or replace with citations that justify a specific decision.

## Three weakest edge cases

1. **#9 Lost focus mid-hold** — "30 s hard-stop watchdog plus `window.blur` -> force-stop" assumes blur fires. On Wayland with `globalShortcut`, the chord can be pressed *while the window is unfocused*, so there is no blur to react to, and the watchdog becomes the only stop path. That means hold-mode-global silently records for 30s.
2. **#13 Modifier release timing** — see Severe issues; the proposed solution is wrong on Wayland/XWayland.
3. **#11 Multiple windows / instances** — defers to a single-instance lock that doesn't exist yet, then says "only focused window receives `voice:hotkey`" — but in single-instance mode the second launch attempt is supposed to focus the existing window, which itself fires a `browser-window-focus` event that the PRD plans to use for re-registering shortcuts. Race risk.

## Anything missing entirely

- **Threat model for the global hotkey.** A keylogger-like surface in main needs an explicit non-goal: "we never log raw key codes outside the configured chord."
- **macOS Accessibility / Input Monitoring permission.** `globalShortcut` on macOS does NOT need Accessibility for most chords, but if the team ever wants `Fn` or media keys it does. State the boundary.
- **Linux X11 vs Wayland detection at runtime** (`process.env.XDG_SESSION_TYPE`) — the PRD treats "Linux" as one platform.
- **Headless / CI behavior.** The e2e harness (`xvfb` + Playwright Electron, per project memory) needs a deterministic way to inject hotkey events; "send synthetic keydown" (line 128) is one line and does not address whether `before-input-event` fires under xvfb.
- **Migration / defaults rollout.** If a user already has a `voice.json` from a future build, what's the precedence vs. defaults? No schema versioning mentioned.
- **Interaction with the existing `CmdOrCtrl+Shift+S` "Reboot Session" accelerator** (`index.cjs:239`). `Ctrl+Shift+Space` doesn't collide, but the PRD claim "Defaults don't overlap with existing accelerators (`src/main/index.cjs:225-244`)" should cite the specific entries it checked — currently it just gestures at a line range.
- **Disable while typing in Settings hotkey-capture field** — capturing the chord must not also fire it. Not specified.

## Suggestions for PRD v2 (concrete edits)

- Replace macOS default `Cmd+Shift+Space` with `Cmd+Option+V` (or surface a first-run picker that lists three uncontested options and validates against `globalShortcut.isRegistered`).
- Pin Electron version in the doc; add a "Minimum Electron version" row to the platform-default table.
- Demote global-mode-on-Wayland to an explicit "Experimental" label in the Settings UI; add a portal-capability probe (`xdg-desktop-portal --version` or DBus introspection of `org.freedesktop.portal.GlobalShortcuts`) and disable the toggle if absent.
- Drop the document-keydown fallback. Keep two layers only: `before-input-event` (always) and `globalShortcut` (when global). Specify deterministic precedence: when window is focused, `before-input-event` wins and `globalShortcut` is unregistered; on blur, re-register.
- Add states `error` and `aborted` to the state machine; add transitions for `armed + blur`, `armed + model->error`, `recording + window destroyed`, `stopping + drain timeout (>=10s)`.
- Replace "press-arms-for-8s" with "global mode forces toggle" and remove the arbitrary timeout, OR document that hold mode is unsupported when global is on and disable the radio button accordingly.
- Specify chord schema (allowed modifiers, forbidden bare keys, max chord length) as a JSON-schema snippet in the PRD.
- Move tray-icon work into F1 *or* state explicitly that F1 ships without it and the privacy invariant is satisfied by a less-strong control (mounted banner only). Pick.
- Move `requestSingleInstanceLock` into its own line item with sub-bullets for second-instance focus, dev-mode interaction, and macOS dock click behavior — or split into a separate ticket.
- Add a Logging section sub-bullet: "voice-hotkey logger wraps `logs.write` and refuses any meta key matching `/transcript|interim|final|text/i`." That makes the rule enforceable.
- Replace `event.isAutoRepeat` (Electron Input) with explicit guidance: main uses `input.isAutoRepeat`; renderer fallback (if kept) uses `event.repeat`.
- Clarify "first phoneme" claim: state that the *first chord-press of a session* may clip and that subsequent presses benefit from a kept-warm mic stream — or mandate keeping `getUserMedia` open in a paused VAD between presses.
- Tighten edge case #9: enumerate Wayland-global, Wayland-window, X11-global, X11-window, macOS-global, macOS-window, Windows-global, Windows-window — each with its own keyup-loss strategy.
- Add a non-goal: "We never log raw key codes outside the configured chord."
- Add an explicit test for `XDG_SESSION_TYPE=wayland` paths in the e2e plan.

Sources for macOS shortcut conflict claim:
- [Mac keyboard shortcuts — Apple Support](https://support.apple.com/en-us/102650)
- [What does the Cmd + Shift + Space keyboard shortcut? — DefKey](https://defkey.com/what-means/command-shift-space)
- [Cannot switch input language with CMD Space — Apple Community](https://discussions.apple.com/thread/255233761)
