# F5 — Device Picker PRD: Adversarial Review

## Verdict

Conceptually solid, factually broken in two places that block implementation as written. Recommendation (A) — `additionalAudioConstraints` — is invented; the package exposes `getStream` instead, so v1 must ship Recommendation (B) or it will not compile. The "atomic write pattern from `logs.cjs`" reference is also wrong: `logs.cjs` uses `fs.appendFileSync`, not temp+rename. The right reference is `sessionsStore.cjs` (`writeFile` to `${p}.tmp-${pid}-${ts}` then `rename`). Several edge cases are present but under-specified, and the persistence path conflicts with project convention. Substantial rewrite needed before engineering picks this up.

## Severe issues

**1. `additionalAudioConstraints` does not exist in `@ricky0123/vad-web`.** The d.ts at `node_modules/@ricky0123/vad-web/dist/real-time-vad.d.ts` lists exactly these stream-related options on `RealTimeVADOptions`: `audioContext?`, `getStream`, `pauseStream`, `resumeStream`. There is no `additionalAudioConstraints` field, and grep across `dist/` finds zero references. The library's default `getStream` (real-time-vad.js:59) hard-codes `{ channelCount: 1, echoCancellation, autoGainControl, noiseSuppression }` and offers no merge hook. Recommendation (A) is therefore not "smallest change" — it's "doesn't compile". The PRD's open question "Is `additionalAudioConstraints` a stable MicVAD API?" should have been answered before listing it as the v1 plan. **Fix:** v1 must own the stream — pass `getStream: () => navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } })` (and a matching `resumeStream`) in `MicVAD.new` options. Note that you must also override `resumeStream` or the device pin is lost the first time VAD pauses/resumes.

**2. Atomic-write reference is wrong.** PRD §"Settings file write race" says "Use the write-temp-then-rename pattern from `logs.cjs`". `logs.cjs` does `fs.appendFileSync(todayPath(), line + '\n')` (line 54) — not atomic, not even temp-and-rename. The actual pattern lives in `sessionsStore.cjs:46-48` (`writeFile` to `${p}.tmp-${pid}-${ts}` then `rename`). Engineers copy-pasting from the cited file will produce a non-atomic implementation.

**3. Persistence path is wrong-looking and inconsistent with the codebase.** PRD says `~/.claude/session-manager/voice.json`. But (a) `~/.claude/` is Claude Code's directory — the PRD itself argues against polluting it for `settings.json`, then proceeds to write a sibling there; (b) `sessionsStore.cjs` writes to `~/.config/session-manager/tabs.json` (line 20); (c) `logs.cjs` writes to `app.getPath('userData')`. Three different roots already exist for our state. Pick one and justify. The natural choice is `~/.config/session-manager/voice.json` to colocate with `tabs.json`, or extend `sessionsStore` itself with a `prefs` key — which the PRD dismisses without addressing the colocation argument.

**4. `devicechange` listener placement and cleanup are hand-waved.** PRD says "Attach once at app startup (alongside `installConfigChangeListener` in `App.tsx`)." `App.tsx:77` shows that listener returned via `useEffect` cleanup. The PRD does not say whether `devicechange` is bound inside that same effect, never unbound (process-lifetime), or attached in `voice.ts`. With React StrictMode dev double-mounting, an un-cleaned listener doubles per HMR cycle. Also: who owns the store update — does the React component dispatch into Zustand, or does `voice.ts` self-attach on module import? Pick one explicitly.

## Moderate issues

**5. Label-fallback is unsafe with duplicate labels.** Two built-in mics on a Mac, or "Microphone" + "Microphone" (built-in array + cheap USB), are routine on Linux. PRD §"Two devices with identical labels" does propose `groupId` disambiguation in the dropdown, but `pickDeviceFromList(savedId, savedLabel, devices)` rebinds on label match alone. If saved was "Microphone" with USB groupId X, and on rebind there are two "Microphone" entries (X gone, built-in present with groupId Y), label match succeeds and silently rebinds to the wrong mic. Spec must add: "fall back only when label match is unique; otherwise treat as unavailable."

**6. PulseAudio/PipeWire labels often change too.** PRD claims label is the durable key; in practice PulseAudio appends `Foo Headset` vs `Foo Headset (USB-1)` based on enumeration order, and PipeWire's `node.description` can include port suffixes. Label-equality fallback will miss the device anyway. Need a normalized comparison (strip trailing `(*)`, collapse whitespace) — at minimum acknowledge the limit.

**7. PipeWire monitor sources.** §"Edge cases #7" punts ("Don't filter… tag with a loopback badge"). On many Linux desktops Chromium DOES expose monitor sources as `audioinput` (e.g. through PipeWire's `default-source` if user set it that way). Selecting one will record speakers and is almost never what the user wants. A badge is decoration; the picker needs to either hide them by default with a "show loopback sources" toggle, or warn at selection time. "Letting users accidentally record speaker output" is a privacy footgun, not a UI nit.

**8. Bluetooth A2DP/HFP path is just "catch the rejection".** Real behavior: on Linux, opening the HFP mic forces all clients off A2DP, killing music playback for several seconds. The error-toast UX is fine; the PRD should state explicitly that we accept this transient (and surface it: "Switching Bluetooth profile…").

**9. Empty-label priming is likely a 2018 artifact.** Modern Chromium (≥ 81 with `media-permissions-from-shell` paths set) exposes labels as soon as the origin has a granted permission, which `setPermissionCheckHandler` (`index.cjs:210-212`) already provides. The 50ms `getUserMedia` priming is plausibly unnecessary in current Electron and triggers the OS mic indicator briefly — exactly the UX wart called out in Open Question #4. PRD should TEST with permission already granted before committing to priming as the default; if labels populate without it, drop priming.

**10. UI placement is inconsistent with itself.** §"UX Flow" commits to Settings sub-panel + chevron quick-switch in LeftNav. §"Integration points" lists both `Settings.tsx` and `LeftNav.tsx:74` edits. Fine, but the chevron is implicitly v1 — the PRD scope line at the top says "picker UI" singular. Either explicitly mark the chevron as v1 (with what items it shows) or move it to v2.

## Minor / nits

**11. deviceId privacy claim is overstated.** PRD says "deviceId is already an opaque hash". In Chromium, the deviceId is salted per origin AND per profile, but is stable across renderer reloads within the same Electron user-data dir — so logging the *prefix* across sessions could in theory correlate "user with mic X" if logs are aggregated. Low risk for a local-only app, but don't claim it's anonymous; just say "stable per-install opaque token".

**12. "Pill" is undefined.** §"Hot-swap" introduces "stop and pill" without defining the term anywhere in the PRD. Presumably a status chip in LeftNav, but spell it out (component, copy, dismissibility, color token).

**13. Test plan can't actually verify the core flow.** Manual E2E lists "Plug USB while panel open" — the project's e2e harness is xvfb + fake-audio (per memory), which can't simulate hot-plug. Either add a unit test that synthesizes a `devicechange` event against a fake `navigator.mediaDevices`, or admit this is manual-only and label it.

**14. `groupId` storage is in the schema but unused.** The persisted JSON in §Persistence stores `groupId` but no later section reads it. Either drop it or use it (e.g., as a tiebreaker when label match is ambiguous, addressing issue #5).

## Suggestions for PRD v2

- Replace the entire "Switching device live" section with the `getStream`/`resumeStream` override approach. Show the actual code shape that would land in `speechRecognition.ts:158`.
- Fix the atomic-write reference to `sessionsStore.cjs:46-48`, or better, factor that pattern into a shared helper in `src/main/` and reference the helper.
- Reconcile the persistence path. Recommend `~/.config/session-manager/voice.json` or, simpler, add a `prefs: { inputDevice }` key to `tabs.json` via `sessionsStore`.
- Add a "label match must be unique" rule to the rebind algorithm; fall back to unavailable-pill otherwise.
- Decide on monitor-source filtering (default-hide with toggle is the safe call).
- Verify-then-decide on priming; document the test that informed the decision.
- Define "pill" once at the top of the UX section.
- Mark chevron quick-switch as in-or-out for v1 unambiguously.
- Add a unit test for `devicechange` handling using a stubbed `navigator.mediaDevices`.
