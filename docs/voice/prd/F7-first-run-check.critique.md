# F7 First-Run Mic Check — Adversarial Critique

## Verdict

Reject as drafted. The persistence path matches `sessionsStore.cjs:20` and `ASR_HALLUCINATIONS` at `voice.ts:32` is a real hook, but the trigger model is hostile, the playback design is incoherent against actual VAD output, and the PRD smuggles in new infrastructure (Modal primitive, `isE2E()` IPC, prefs store, `permissions.query` shim) under "30-second wizard" framing.

## Severe issues

**S1. "First mic-click" trigger is hostile.** The user pressed Record, not Settings. They are mid-task and a focus-trapped modal is the wrong response. Edge Case 9 papers over this with "if `isRecording === true`, do NOT auto-open" — but `isRecording` is false at the moment of the *first* click; that is the entire premise. Discord/Slack wizards open from a settings entry-point or explicit "test" CTA, never from the user's first attempt to use the feature in anger. Better: open on first visit to Settings → Voice, surface a small "Run mic check" affordance next to the mic, and auto-open only after the *first observable failure* (NotAllowedError, NotFoundError, 10s of `Listening…` with no `onSpeechStart`).

**S2. `AudioBufferSourceNode` reasoning is half-right.** The PRD cites "VAD output is already 16kHz Float32 PCM" at `speechRecognition.ts:176` — but that is `onSpeechEnd`, which fires per VAD-detected segment, not for a 5-second free-form sample. The wizard wants the full 5s including silence padding so the user hears themselves; `onSpeechEnd` returns only the post-`positiveSpeechThreshold`/pre-redemption segment and may fire multiple times or not at all. v2 must either bypass VAD and capture raw 16kHz from a `MediaStreamAudioSourceNode` + `AudioWorkletNode`, or explicitly accept "playback is only the last detected utterance." Step 4 and Step 5 are incoherent as written.

**S3. `SM_E2E=1` auto-skip is presented as existing; it is not.** Edge Case 8: "Existing `e2e/mic.spec.mjs:52` already sets this env." True, the env is set, but `grep -rn SM_E2E src/` returns zero hits. The `window.api.app.isE2E()` getter, preload binding, and renderer guard are all new surface — own that scope.

**S4. F5 is a hard dependency masquerading as a soft one.** PRD says "without F5, ship a read-only 'Default system mic' placeholder." But the wizard claims to fix wrong-device problems — one of the three failure classes. Without F5 it catches permission + silent-recording, can't fix wrong device, and tells the user "everything is fine" while locking them to the OS default. Either F5 is a v1 blocker, or the value prop shrinks to ~60%. Decide.

## Moderate issues

**M1. Schema-bump has no governance.** `CURRENT_WIZARD_SCHEMA` is bumped "only on a substantive change" — no PR-template gate, no failing test, no runbook for an accidental bump that re-shows the wizard for every user. Mirror `parseScopedJson.ts` / `mergeScopes.ts`: require a `WIZARD_MIGRATIONS` row plus a migrate-up function, with bump-detection in CI.

**M2. macOS permission-grant after deep-link unspecified.** `askForMediaAccess` fires at boot (`index.cjs:215`); if denied long ago, the wizard hits `denied` with a deep-link to System Settings — but what happens after the user grants? Electron caches per-session. Spec a `navigator.permissions.query` `change` listener so the wizard advances without relaunch.

**M3. Real-Moonshine + model-load race.** Edge Case 12 auto-advances on `modelStatus === 'ready'`. `VoiceButton` calls `initModel()` only on mount (line 16); Moonshine Base is ~75MB cold (`mic.spec.mjs:74-75`). Fresh install: user opens wizard, hits Step 5, waits 90s on a "Loading model {pct}%" spinner with no deferred-completion path. Either preload at app boot (every user pays 75MB) or add a "still downloading, finish later?" state.

**M4. AudioBuffer / Blob lifecycle not specified.** `audio = null` on close handles the Float32Array, but `AudioBuffer`s held by source nodes survive until GC if re-using VAD's AudioContext. State explicitly: `source.disconnect()` after `onended`, null the AudioBuffer ref, no `URL.createObjectURL` (and if any Blob URL is added as fallback, mandatory `revokeObjectURL`).

**M5. No-mic detection is punitive.** Edge Case 2: "hardware gate." User over SSH+X-forwarding, in a VM with no PulseAudio, or with no mic plugged is trapped on Step 2 with no Skip. Zero `audioinput` devices → set `noDeviceAt`, suppress auto-open, surface a non-modal "No mic detected — voice disabled" banner with manual retry.

**M6. Hallucination filter is the wrong calibration check.** `ASR_HALLUCINATIONS` at `voice.ts:32` is tuned for runtime command false-positives ("you", "thanks for watching"). Moonshine on a clean 5s sample sometimes returns short tokens legitimately. Add Levenshtein ≤ 3 fuzzy-match against the prompt phrase OR a length-floor (≥ 3 words), and a "Continue anyway" escape hatch after one retry.

**M7. Skip placement.** "Persistent Skip link in header" is punitive — reads as "are you sure?" Equal visual weight on every step, not chrome.

**M8. "Run again" semantics undefined.** Does it wipe `completedAt`? Re-write `deviceId`? Three runs = three `voice.wizard.completed` events skewing aggregates? Spec it.

**M9. Two storage roots.** `~/.config/session-manager/voice-prefs.json` is correct per `sessionsStore.cjs:20`, but `mic.spec.mjs:19-20` shows the app already uses both `userData` AND `~/.config/session-manager/tabs.json`. Acknowledge the smell; pick a unification target.

**M10. `permissions.query({name:'microphone'})` not universally supported.** Spec a fallback to a `getUserMedia` probe when query throws or returns undefined.

## Minor / nits

- `schemaVersion: 1` at top level AND `voiceWizard.schemaVersion: 1` — document both or drop one.
- §UX Flow numbers screens 1-6 but the lede says "Five screens."
- §Integration points cites `voice.ts:45` — file has churned; line 32 is `ASR_HALLUCINATIONS`, line 86 is its consumer. Verify.
- `deviceLabel` in telemetry can include `vendor:product` IDs ("USB Audio Device (1234:5678)") — PII-adjacent; hash or truncate.
- Testing Plan reuses `e2e/fixtures/speech.wav` (48kHz stereo s16 per `mic.spec.mjs:7-8`); wizard expects 16kHz Float32 from VAD — capture a wizard-specific fixture or document resampling.
- §Open Questions item 3 ("Does `preferredInputDeviceId` affect non-wizard recordings?") is the actual product question — if no, Step 3 is theatre. Resolve before F5 merges.
- §Problem and §Alternatives invoke "2026 voice-onboarding research" without citations in §Sources. Drop or cite.

## Suggestions for PRD v2

1. Move auto-open from "first mic-click" to (a) first Settings → Voice visit + (b) first observed failure. Keep the user's first click as a recording attempt.
2. Resolve VAD-vs-raw-capture: capture raw 16kHz for a 5s free-form sample; don't pretend `onSpeechEnd` gives it to you.
3. Acknowledge `window.api.app.isE2E()`, `Modal.tsx`, `voicePrefsStore.cjs`, SM_E2E renderer guard are all new surface — estimate accordingly.
4. Make F5 a hard v1 blocker OR drop "wrong device" from the value prop.
5. Define a model-loading deferred-completion path so the wizard never blocks on the 75MB download.
6. Add Levenshtein ≤ 3 fuzzy-match against the prompt phrase + a "Continue anyway" escape after one retry.
7. Equal-weight Skip on every step.
8. Spec a `permissions.query` `change` listener for post-deep-link grant.
9. Hash/truncate `deviceLabel` in telemetry.
10. Document `voice-prefs.json` as the second storage root with a unification plan.
