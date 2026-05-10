# F7 — First-run mic check (record-and-play calibration flow) v2

Status: Draft v2
Owner: Voice
Last updated: 2026-05-02

## Changes from v1

- **E2E plumbing is owned, not assumed.** `SM_E2E=1` had no `src/` consumer in v1. v2 adds `window.api.app.isE2E()` to preload + main as new surface.
- **Record/playback uses `MediaRecorder`, not VAD output.** v1's `onSpeechEnd` → `AudioBufferSourceNode` was incoherent — VAD returns a clipped utterance, not a 5s free-form sample. v2 captures via `MediaRecorder`, decodes via `decodeAudioData` for playback, and feeds Float32 PCM directly to the existing whisper worker for transcription.
- **First mic-click trigger retained but reframed.** Click with `wizardPending` opens the wizard *instead* of starting recording; the welcome screen shows a prominent "Skip & record" CTA.
- **Hallucination filter dropped from wizard-path.** `ASR_HALLUCINATIONS` (`voice.ts:32`) is for runtime command suppression; wizard checks "any text returned" and shows the transcript verbatim.
- **Modal primitive is in scope.** v2 ships `src/renderer/components/ui/Modal.tsx` with `<Modal open onClose>` API, focus trap, ESC handling.
- **Model-load race has a pre-step.** "Preparing speech model…" gates Step 5 with existing `loadingProgress` UI.
- **Skip is a primary action on every step.** Not buried in a header X.
- **Empty-device list is a dedicated screen.** Not a Step 3 trap.
- **macOS-denied path uses OS Settings deep link.** No retry of `askForMediaAccess`.
- **Wizard-failure recovery offers Retry / Skip / Report-issue.**
- **F2/F3/F5 are soft deps.** v2 ships independently with documented degradations.
- **Schema-version bump policy is explicit.** Single hardcoded constant; bumping invalidates all completed wizards. Accepted.
- **Storage-root inconsistency acknowledged.** `~/.config/session-manager/voice-prefs.json` matches `sessionsStore.cjs:20`; `userData` stays for Electron-owned state. Direction: consolidate session-manager-owned data under `~/.config/session-manager/`.

## Problem & Motivation

A user's first voice interaction is clicking the mic in `src/renderer/components/VoiceButton.tsx` and hoping. Three failures happen silently mid-task: permission denied (macOS prompts at boot via `src/main/index.cjs:215`; Linux/Windows surface only on `getUserMedia` in `speechRecognition.ts:158`), wrong device selected (lid mic, unworn Bluetooth headset), and levels-wrong / hardware-muted (VAD never fires `onSpeechEnd`; "Listening…" shows forever). A guided 30-second check on first use catches all three pre-emptively, mirrors Discord/Slack patterns, and supplies the early "win" of hearing yourself transcribed locally.

## Scope

**Triggers** (any sufficient):

- First mic click when `voiceWizard.completedAt` is missing from `~/.config/session-manager/voice-prefs.json`. Wizard opens *instead of* recording; Welcome offers "Skip & record now" prominently.
- First Settings → Voice open with `completedAt` missing.
- "Re-run mic check" from Settings → Voice (always available).
- Persisted `voiceWizard.schemaVersion < CURRENT_WIZARD_SCHEMA`. Hardcoded constant in `src/renderer/lib/voiceWizard.ts`; bumping requires a code change. Trade-off: bumps invalidate all completed wizards globally. Accepted — bumps are rare.

**Out of scope:** in-session level monitoring, language picker, hotword training, TTS voice.

**Soft dependencies (degradations, not blockers).** v2 ships independently of F2/F3/F5:

- F2 (mic gating): if `modelStatus !== 'ready'` at Step 5, insert "Preparing speech model…" using existing `loadingProgress`.
- F3 (level meter): without F3, binary "speech detected / not" from a one-shot `AnalyserNode.getByteFrequencyData()` peak.
- F5 (device picker): without F5, Step 3 shows a read-only "Default system mic — {label}" with an OS deep link. Wizard still catches permission and silent-recording; "wrong device" detection defers to F5.

## UX Flow

Modal, centered, focus-trapped, dim backdrop. Every step renders a primary "Continue" and an equal-weight "Skip mic check" button; ESC also dismisses. Six steps:

1. **Welcome** — *"Set up voice input. 30 seconds. Audio stays on your device — nothing is uploaded."* Buttons: `[Get started] [Skip & record now]`. Skip writes `{skippedAt, schemaVersion}` and, if the wizard was opened by a mic-click, immediately starts recording.
2. **Permission** — read `navigator.permissions.query({name:'microphone'})` (with `getUserMedia` probe fallback if `query` throws). `granted` auto-advances. `prompt` fires a one-track probe and stops it. `denied` is terminal with the OS Settings deep link (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`, `ms-settings:privacy-microphone`, copy-pasteable instructions on Linux). On macOS, if `askForMediaAccess` already returned false at boot, surface the deep link rather than re-calling it (Electron caches per-session). A `permissions.query` `change` listener auto-advances after the user grants.
3. **Device picker** — F5 `<DeviceSelect>` populated from `enumerateDevices()` filtered to `audioinput`. If the filtered list is empty, render a dedicated "No microphones detected" screen explaining likely causes (unplugged USB, VM without audio passthrough, X-forwarded session) with a Refresh bound to `devicechange`. Wizard is not marked complete from this screen; Skip is allowed.
4. **Record sample** — wizard opens its own `getUserMedia({audio:{deviceId}})` stream and creates `MediaRecorder({mimeType:'audio/webm;codecs=opus'})`. 5-second countdown; prompt *"Say: 'testing one two three'."* Live level via a parallel `AnalyserNode` on the same stream. On stop, the Blob is held in memory and stream tracks stop immediately.
5. **Playback + transcription** — Blob → `AudioBuffer` via `audioCtx.decodeAudioData(await blob.arrayBuffer())`. Playback via `AudioBufferSourceNode`; `onended` flips the "Playback works" check. In parallel, channel-0 Float32 PCM is posted to the existing whisper worker (`src/renderer/lib/whisperWorker.ts`) using the same `transcribe` message shape as `speechRecognition.ts:108`. Verification is a "did we get any text" check (trimmed length > 0); the transcript is shown verbatim for user confirmation. `ASR_HALLUCINATIONS` is **not** applied — that filter targets runtime command false-positives and would fail legitimate short test phrases. If the model isn't ready, render "Preparing speech model… {pct}%" using the existing `loadingProgress` UI; advance on `modelStatus === 'ready'`. On worker error or empty-after-retry, surface `[Retry] [Skip] [Report issue]`. Report-issue logs non-PII telemetry only (model version, error code).
6. **Confirm** — *"You're all set. Mic: {label}. Heard: '{transcript}'."* Buttons: `[Done] [Run again]`. Done writes `voiceWizard = {completedAt, schemaVersion, deviceId, deviceLabel}`. "Run again" returns to Step 4 without clearing `completedAt`; only Done overwrites.

Skip on any step writes `{skippedAt, schemaVersion}`; mic clicks no longer auto-open for 7 days. Settings → Voice always works.

## Technical Design

**Persistence.** New file `~/.config/session-manager/voice-prefs.json`, matching `src/main/sessionsStore.cjs:20`. Chosen over `app.getPath('userData')` to consolidate session-manager-owned config under one root; `userData` continues to host Electron-managed state (cache, GPU shaders, IndexedDB). Shape:

```json
{
  "schemaVersion": 1,
  "voiceWizard": { "schemaVersion": 1, "completedAt": 0, "skippedAt": null,
                   "deviceId": "default", "deviceLabel": "" },
  "preferredInputDeviceId": "default"
}
```

`src/main/voicePrefsStore.cjs` (new) reuses the atomic-write pattern at `sessionsStore.cjs:40-50`. IPC: `voicePrefs:load`, `voicePrefs:save`, validated via `src/main/ipcSchemas.cjs`.

**E2E auto-skip (NEW surface).** `window.api.app.isE2E()` is added to preload and main; returns `process.env.SM_E2E === '1'`. The wizard checks this on mount and treats `wizardPending` as false. `e2e/mic.spec.mjs:52` already sets the env; existing tests need no change. A dedicated test sets `SM_E2E_VOICE_WIZARD=1` to override.

**Modal primitive (NEW).** `src/renderer/components/ui/Modal.tsx` ships as part of F7. API: `<Modal open onClose>{children}</Modal>`. Implements focus trap (first focusable on open, restore on close), ESC handler, `role="dialog"` + `aria-modal="true"`, dim backdrop. No new dependency.

**Capture and playback.** `MediaRecorder({mimeType:'audio/webm;codecs=opus'})`; the wizard owns the `getUserMedia` stream and stops all tracks on stop. Blob → `AudioBuffer` via `audioCtx.decodeAudioData`. Playback via `AudioBufferSourceNode` → `audioCtx.destination`; `onended` triggers cleanup (`source.disconnect()`, buffer ref nulled). No `URL.createObjectURL` is used; if any future fallback adds one, `revokeObjectURL` must run in the same tick that `decodeAudioData` returns. The wizard does not reuse VAD's stream or `onSpeechEnd` — VAD returns clipped utterances, not a 5s free-form sample.

**Transcription verification.** Channel-0 Float32 PCM is posted to the existing `whisperWorker` via the same `transcribe` message shape as `speechRecognition.ts:108`. Result checked for `text.trim().length > 0`, displayed verbatim. Transfer `audio.buffer` to avoid a copy.

**Integration points.**

- `src/main/index.cjs:215` — keep macOS `askForMediaAccess`; wizard reads state, never re-prompts.
- `src/main/index.cjs:186` — register `voicePrefsStore.registerHandlers()`.
- `src/preload/index.cjs` — expose `window.api.voicePrefs.{load,save}` and **new** `window.api.app.isE2E()`.
- `src/renderer/state/voice.ts` — extend store with `wizardPending`, `wizardOpen`, `openWizard()`, `closeWizard()`. (`ASR_HALLUCINATIONS` at line 32 is unrelated to wizard path.)
- `src/renderer/components/VoiceButton.tsx` — guard: if `wizardPending && !wizardOpen && !isE2E`, call `openWizard()` instead of `startRecording()`.
- `src/renderer/lib/speechRecognition.ts:84` — extract device-enumeration helper.
- New files: `src/renderer/components/VoiceWizard.tsx`, `src/renderer/components/ui/Modal.tsx`, `src/main/voicePrefsStore.cjs`.

## Edge Cases & Failure Modes

1. **Permission denied** — terminal screen with OS deep link; `permissions.query` `change` listener auto-advances on grant. Mic button thereafter re-opens wizard at Step 2.
2. **Empty device list** — dedicated screen explaining causes; Refresh bound to `devicechange`; Skip allowed.
3. **Dead-silent recording** — no level activity for 5s → "We didn't hear anything" → back to Step 3.
4. **Empty transcription** — worker returned `''`. `[Retry] [Skip] [Report issue]`; not marked complete unless user skips.
5. **User skips** — `{skippedAt, schemaVersion}` only; 7-day cool-down on click triggers; Settings always available.
6. **App restarted mid-flow** — wizard state is renderer memory; drops on restart. Prefs untouched.
7. **Schema bump** — single hardcoded `CURRENT_WIZARD_SCHEMA`. Bumps invalidate all completed wizards globally; bumps are rare by design.
8. **Headless E2E** — `window.api.app.isE2E()` returns true → `wizardPending = false`. `SM_E2E_VOICE_WIZARD=1` opts in.
9. **Mic click while wizard open** — no-op; debounced by `wizardOpen`.
10. **macOS denied at boot** — `askForMediaAccess` already returned false; deep-link only.
11. **Device unplugged mid-wizard** — `devicechange` listener bounces to Step 3.
12. **Model not ready at Step 5** — "Preparing speech model… {pct}%" using existing `loadingProgress`; auto-advance on ready.

## Security & Privacy

The recorded sample lives only as a Blob and derived `AudioBuffer` in renderer memory. Never written to disk, never logged, never sent over IPC to main, and explicitly released (`source.disconnect()`, buffer + Blob refs nulled) on wizard close or advance past Step 5. UI states *"Audio stays on your device — nothing is uploaded."* on Step 1 and again above the record button. The Whisper model runs offline.

## Telemetry & Logging

Renderer logger only (`src/renderer/lib/logger.ts` → `src/main/logs.cjs:43`). No PII, no audio, no transcript text. `deviceLabel` is hashed (SHA-256, first 8 hex chars) before logging.

- `voice.wizard.opened` `{trigger}`, `voice.wizard.step.completed` `{step, durationMs}`, `voice.wizard.skipped` `{atStep}` (info)
- `voice.wizard.permission_denied`, `voice.wizard.no_devices`, `voice.wizard.silent_recording`, `voice.wizard.transcription_failed` `{reason}` (warn)
- `voice.wizard.completed` `{durationMs, deviceLabelHash}` (info)

## Testing Plan

**Playwright e2e** (`e2e/voice-wizard.spec.mjs`, new):

- Default `SM_E2E=1` skips wizard; `e2e/mic.spec.mjs` passes unchanged.
- `SM_E2E_VOICE_WIZARD=1` overrides skip; reuses `e2e/fixtures/speech.wav` (resampled inline to 16kHz Float32); drives end-to-end and asserts `voice-prefs.json` has `voiceWizard.completedAt`.
- Skip path; permission-denied (stub `permissions.query`); empty-device (stub `enumerateDevices` to `[]`); transcription-failure (stub worker to post `{type:'error'}`, assert `[Retry] [Skip] [Report issue]`).

**Unit** (`voiceWizard.test.ts`): schema-version comparison; transcript-empty detection; device-enumeration helper.

**Manual matrix:** macOS 15, Windows 11, Ubuntu 24.04 (PulseAudio + PipeWire) × first-launch / denied / re-run / schema-bump / no-mic.

## Alternatives Considered

1. **No wizard, inline help link.** Rejected: doesn't catch problems pre-emptively.
2. **Settings tab only, no auto-open.** Rejected: low first-timer discoverability.
3. **Passive auto-detection.** Rejected for v1: remediation, not calibration; kicks in after the bad experience.
4. **OS-native permission UI only.** Rejected: doesn't solve wrong-device or hardware-mute.
5. **Reuse VAD `onSpeechEnd`.** Rejected — clipped utterance, not a 5s free-form sample (v1's broken design).
6. **`MediaRecorder` + `<audio>` element for playback.** Rejected: we already need the Float32 PCM for transcription; `decodeAudioData` + `AudioBufferSourceNode` keeps capture and verification on one buffer.

## Open Questions

- 14-day reminder after `skippedAt`, or stay silent? Lean silent.
- Waveform during recording vs. binary pip? Lean pip for v1.
- Does `preferredInputDeviceId` affect non-wizard recordings? F5's call.
- Future PWA build: pref file becomes `localStorage`. Defer.

## Sources

- [Discord — Mic Testing](https://support.discord.com/hc/en-us/articles/360020641332-Mic-Testing)
- [Slack Video and Audio Test — TechSolutions](https://www.techsolutions.support.com/how-to/how-to-test-slack-video-and-audio-13314)
- [Electron camera/mic permission — BigBinary](https://www.bigbinary.com/blog/request-camera-micophone-permission-electron)
- [Electron Web API Permissions — Doyensec](https://blog.doyensec.com/2022/09/27/electron-api-default-permissions.html)
- [Electron systemPreferences API](https://www.electronjs.org/docs/latest/api/system-preferences)
- [MDN — MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [MDN — decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)
