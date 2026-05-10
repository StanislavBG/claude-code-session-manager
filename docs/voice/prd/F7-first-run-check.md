# F7 — First-run mic check (record-and-play calibration flow)

Status: Draft
Owner: Voice
Last updated: 2026-05-02

## Problem & Motivation

Today, the user's first interaction with voice is clicking the mic in `src/renderer/components/VoiceButton.tsx` and hoping. Three classes of failure happen silently and cost the user real time mid-task:

1. **Permission denied** — on macOS we trigger consent at boot (`src/main/index.cjs:215`), but on Linux/Windows the prompt only surfaces when `MicVAD.new()` invokes `getUserMedia()` inside `src/renderer/lib/speechRecognition.ts:158`. A "Don't Allow" surfaces as a generic `NotAllowedError` with no recovery path.
2. **Wrong device selected** — OS default may be a lid mic or an unworn Bluetooth headset; no picker today (F5).
3. **Levels wrong / mic muted in hardware** — VAD never fires `onSpeechEnd`, the user sees "Listening…" forever, indistinguishable from a model bug.

A guided check the first time the user enables voice catches these pre-emptively, mirrors the pattern users already know from Discord ("Let's Check") and Slack (pre-call A/V test), and meets 2026 voice-UX guidance to explain local processing and give an early "win" by letting users hear themselves transcribed.

## Scope

**Triggers** (any one is sufficient):

- First mic-button click OR first open of Settings → Voice when `voiceWizard.completedAt` is missing from `~/.config/session-manager/voice-prefs.json`. We do NOT auto-open on cold start — the app's primary value is terminals, not voice.
- User invokes "Re-run mic check" from Settings → Voice (always available).
- Schema bump: persisted `voiceWizard.schemaVersion < CURRENT_WIZARD_SCHEMA`. Only bumped on a substantive change (new step, new permission, ASR swap). App-version bumps alone do NOT re-trigger.

**Out of scope:** ongoing in-session level monitoring (F3), language pick, hotword training, TTS voice.

**Hard dependencies** (degrade or block):

- F2 (mic gating) — record step depends on `modelStatus === 'ready'`; if F2 ships late, wizard shows a "Loading model {pct}%" sub-state.
- F5 (device picker) — wizard step 2 *is* F5. Without F5, ship a read-only "Default system mic" placeholder and a deep-link to OS settings.
- F3 (level meter) — wizard reuses F3's meter. Without F3, fall back to a binary "speech detected / not detected" driven off VAD `onSpeechStart`.

## UX Flow

Modal, centered, focus-trapped, dim backdrop. Persistent `Skip` link in header; `Esc` dismisses. Five screens:

1. **Welcome** — *"Set up voice input. 30 seconds. Audio stays on your device — nothing is uploaded."* `[Get started] [Skip for now]`. Skip writes `{skippedAt, schemaVersion}` only.
2. **Permission** — read state via `navigator.permissions.query({name:'microphone'})`. `granted` → auto-advance with a green check. `prompt` → fire a tiny `getUserMedia({audio:true})` probe whose track is immediately stopped, with hint copy. `denied` → terminal screen with platform-specific deep-link button (`x-apple.systempreferences:…Privacy_Microphone` on macOS, `ms-settings:privacy-microphone` on Windows, copy-pasteable instructions on Linux).
3. **Device picker** — F5 `<DeviceSelect>` populated from `navigator.mediaDevices.enumerateDevices()` filtered to `audioinput`. Default = OS default. User's choice persists to `voicePrefs.preferredInputDeviceId`. "I don't see my mic" link expands a help block.
4. **Record sample** — auto-start with a 5-second countdown. Prompt: *"Say: 'testing one two three'."* F3 meter renders live. The buffer is held only as a `Float32Array` in renderer memory.
5. **Playback + transcription** — pipe the buffer into a transient `AudioBuffer` → `AudioBufferSourceNode` for playback through default output, AND post the same buffer to the existing whisper worker (`worker.postMessage({type:'transcribe', audio}, [audio.buffer])`) — exercising the *real* model, not a mock. Three checkpoints flip from spinner → check or X: "Audio captured", "Playback works" (`onended` + a "Did you hear it?" yes/no), "Transcription works" (non-empty + not in `ASR_HALLUCINATIONS`). Show transcript verbatim.
6. **Confirm** — *"You're all set. Mic: {label}. Heard: '{transcript}'."* `[Done] [Run again]`. Done writes `voiceWizard = {completedAt, schemaVersion, deviceId, deviceLabel}`.

Skip in any step writes `skippedAt` only with a 7-day cool-down before re-prompting on mic clicks. Settings → Voice always exposes "Run mic check now".

## Technical Design

**Persistence.** New file `~/.config/session-manager/voice-prefs.json`, separate from `tabs.json` (single-responsibility, mirrors `src/main/sessionsStore.cjs:19`). Shape:

```json
{
  "schemaVersion": 1,
  "voiceWizard": { "schemaVersion": 1, "completedAt": 0, "skippedAt": null,
                   "deviceId": "default", "deviceLabel": "" },
  "preferredInputDeviceId": "default"
}
```

New main module `src/main/voicePrefsStore.cjs` reuses the atomic-write pattern at `sessionsStore.cjs:40-50` (tmp + rename). IPC: `voicePrefs:load`, `voicePrefs:save`, validated through `src/main/ipcSchemas.cjs`.

**Re-trigger semantics.** `CURRENT_WIZARD_SCHEMA` constant lives in `src/renderer/lib/voiceWizard.ts`. On app mount, `useVoice` reads prefs; if persisted schema is lower OR `completedAt` is missing OR `skippedAt` was >7d ago, set `wizardPending: true`. Mic-button click consults this flag.

**Playback API.** `AudioBufferSourceNode`, not `MediaRecorder` + `<audio>`. The VAD output (`speechRecognition.ts:176`) is already 16kHz Float32 PCM; `MediaRecorder` would re-encode to Opus/WebM, add 50–200ms latency, and need Blob-URL cleanup. The existing AudioContext (alive for VAD) hosts playback; `source.onended` is our "playback done" hook.

**Transcription verification.** The wizard uses the production worker (`src/renderer/lib/whisperWorker.ts`) and the real Moonshine model. Same message shape as `speechRecognition.ts:108`. Certifies the actual end-to-end path; surfaces IndexedDB/cache issues here rather than mid-task.

**Integration points (file:line).**

- `src/main/index.cjs:215` — keep macOS `askForMediaAccess`; wizard reads state, doesn't re-prompt.
- `src/main/index.cjs:186` — register `voicePrefsStore.registerHandlers()`.
- `src/preload/index.cjs` — expose `window.api.voicePrefs.{load,save}` and `window.api.app.isE2E()`.
- `src/renderer/state/voice.ts:45` — extend store with `wizardPending`, `wizardOpen`, `openWizard()`, `closeWizard()`.
- `src/renderer/components/VoiceButton.tsx:18` — guard `toggle`: if `wizardPending && !wizardOpen`, call `openWizard()` instead of `startRecording`.
- `src/renderer/lib/speechRecognition.ts:84` — extract device-enumeration helper for F5 + wizard reuse.
- `src/renderer/components/VoiceWizard.tsx` (new) — modal; introduce `src/renderer/components/ui/Modal.tsx` (no primitive today) styled with existing Panel tokens.
- `src/main/voicePrefsStore.cjs` (new).

## Edge Cases & Failure Modes

1. **Permission denied at step 1** — terminal "denied" screen with OS-deep-link; persist `permissionDeniedAt`. Mic button thereafter shows "Permission denied — click for help" and re-opens wizard at step 1.
2. **No mic devices** — step 2 shows "No microphones detected. Plug one in and click Refresh." Wizard not marked complete; hardware gate.
3. **Dead-silent recording** — VAD never fires `onSpeechStart` in 5s. Show "We didn't hear anything. Try again or pick a different mic." with back-to-step-2.
4. **Empty / hallucinated transcription** — apply `ASR_HALLUCINATIONS` filter from `voice.ts:32`. Show "Heard sound but couldn't transcribe — check the model loaded correctly", offer retry; do NOT mark complete.
5. **User skips** — write `{skippedAt, schemaVersion}` only. 7-day cool-down before re-prompt; Settings entry always works.
6. **App restarted mid-flow** — wizard state is renderer-memory only; restart drops it. Prefs untouched. Next launch behaves as if user closed the modal.
7. **Wizard re-shown after upgrade** — only when schema version bumped, NOT app version. Bump rationale documented in PR.
8. **Headless tests (xvfb + fake audio)** — wizard auto-skips when `process.env.SM_E2E === '1'`. Renderer reads `window.api.app.isE2E()`; treats as `wizardPending: false`. Existing `e2e/mic.spec.mjs:52` already sets this env. Dedicated wizard test sets `SM_E2E_VOICE_WIZARD=1` to override.
9. **Mid-task timing** — wizard is modal but doesn't pause PTYs. If `useVoice.getState().isRecording === true`, the wizard does NOT auto-open on mic clicks; user must invoke from Settings — avoids competing for the mic.
10. **macOS first-run prompt timing** — `askForMediaAccess` fires at boot. By the time the user reaches the wizard, the OS prompt is usually answered. Step 1 reads state via `navigator.permissions.query`; only probes `getUserMedia` if still `prompt`.
11. **Device unplugged mid-wizard** — `devicechange` listener on `navigator.mediaDevices` resets the list and bounces back to step 2 with a toast.
12. **Model not yet loaded at step 4** — sub-state "Loading model {pct}%" using F2's `loadingProgress`; auto-advance on `modelStatus === 'ready'`.

## Security & Privacy

The recorded sample lives only as a `Float32Array` in renderer memory for the duration of the wizard. It is **never** written to disk, **never** logged (the `whisperWorker.ts` log forwarder at `speechRecognition.ts:44` is meta-only), **never** sent over IPC to main, and explicitly released (`audio = null`) when the wizard closes. UI states *"Audio stays on your device — nothing is uploaded."* on Step 0 and again above the record button. The Whisper model itself runs offline (`speechRecognition.ts:1-10`).

## Telemetry & Logging

Existing renderer logger (`src/renderer/lib/logger.ts` → `src/main/logs.cjs:43`). Anonymous, no PII, no audio:

- `voice.wizard.opened` `{trigger}` info
- `voice.wizard.step.completed` `{step, durationMs}` info
- `voice.wizard.skipped` `{atStep}` info
- `voice.wizard.permission_denied` warn
- `voice.wizard.no_devices` warn
- `voice.wizard.silent_recording` warn
- `voice.wizard.transcription_failed` `{reason}` warn
- `voice.wizard.completed` `{durationMs, deviceLabel}` info

Transcript text and audio are NOT logged. `deviceLabel` is logged because it's user-visible and aids support; future privacy toggle can redact.

## Testing Plan

**Playwright e2e** (`e2e/voice-wizard.spec.mjs`, new):

- Default `SM_E2E=1` skips wizard so `e2e/mic.spec.mjs` keeps passing without modification.
- Dedicated test sets `SM_E2E_VOICE_WIZARD=1` to override the skip; reuses `e2e/fixtures/speech.wav`; drives end-to-end and asserts `voice-prefs.json` contains `voiceWizard.completedAt`.
- Skip path: open wizard, click Skip, assert `skippedAt` set and `completedAt` absent.
- Permission-denied path: stub `navigator.permissions.query` via `win.evaluate` to return `denied`; assert terminal screen.

**Unit** (`src/renderer/lib/__tests__/voiceWizard.test.ts`): schema-version comparison; `ASR_HALLUCINATIONS` applied to verify result.

**Manual matrix:** macOS 15, Windows 11, Ubuntu 24.04 (PulseAudio + PipeWire) × first-launch / permission-denied / re-run-from-Settings / schema-bump.

## Alternatives Considered

1. **No wizard, inline help link** — "Mic not working? Click here" below the button. Rejected: doesn't catch problems pre-emptively. Discord, Slack, Zoom, Teams all moved past this.
2. **Settings tab only, no auto-open** — bury inside Settings → Voice. Rejected: low discoverability for first-timers. We still keep the Settings entry as the durable re-run point.
3. **Auto-detect issues passively** — surface a help banner after N failures. Rejected for v1: it's remediation, not calibration; kicks in *after* the bad experience. Possible follow-up.
4. **OS-native permission UI only** — ship without a wizard, lean on the OS prompt. Rejected: doesn't solve wrong-device or hardware-mute, and skips the early-win moment 2026 voice-onboarding research emphasizes.

## Open Questions

- "Test again" reminder 14 days after a `skippedAt`, or stay silent? Lean: silent; respect the skip.
- Show waveform during recording (showy, adds dep) vs F3 meter only (utilitarian)? Lean: F3 only for v1.
- Does `preferredInputDeviceId` affect non-wizard recordings? An F5 question, but F7 writes the value — agree consumer semantics in F5 PRD.
- Future Web/PWA build (no Electron main) — pref file becomes `localStorage`; renderer code unchanged. Defer.

## Sources

- [Voice User Interface Design Best Practices 2026 — TheFinch Design](https://thefinch.design/voice-user-interface-design-best-practices-2026/)
- [Voice UI Design Guide 2026 — Fuselab Creative](https://fuselabcreative.com/voice-user-interface-design-guide-2026/)
- [Discord — Mic Testing](https://support.discord.com/hc/en-us/articles/360020641332-Mic-Testing)
- [How to Test Slack Video and Audio — TechSolutions](https://www.techsolutions.support.com/how-to/how-to-test-slack-video-and-audio-13314)
- [Online Mic Test: Record & Playback Tool — The Podcast Host](https://www.thepodcasthost.com/recording-skills/online-mic-test/)
- [Requesting camera and microphone permission in an Electron app — BigBinary](https://www.bigbinary.com/blog/request-camera-micophone-permission-electron)
- [Diving Into Electron Web API Permissions — Doyensec](https://blog.doyensec.com/2022/09/27/electron-api-default-permissions.html)
- [Electron systemPreferences API](https://www.electronjs.org/docs/latest/api/system-preferences)
