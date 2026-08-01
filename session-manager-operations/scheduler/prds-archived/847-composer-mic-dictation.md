---
title: Epic composer mic button — dictation into the composer input
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
dependsOn: [842-retire-legacy-tab-chat-rail]
---

# Goal

The mock's composer has a joined mic+attach button group; v0.40.0 shipped attach only
because state/voice.ts's submit path is SessionTab-coupled (voice.ts:~328-346 armSubmit
resolves tabs). Add a mic button to EpicComposer that dictates INTO the composer text state
(append transcript text) without the tab-coupled auto-submit: reuse the recognition pipeline
(VoiceButton.tsx / state/voice.ts recognition + RecordingStatus privacy invariant — the
App-level RecordingStatus MUST mount whenever isRecording, per CLAUDE.md) but target a
callback sink instead of armSubmit.

# Acceptance criteria

- [ ] Mic button in the composer's joined button group (mock Composer lines ~519-528);
  toggles recording; transcript text appends into the composer textarea state; no
  auto-submit; RecordingStatus mounts while recording (test asserts the store flag path).
- [ ] If voice.ts needs a sink abstraction, add the minimal one (e.g. an optional
  targetSink callback) without changing existing tab dictation behavior — its tests stay
  green.

# Implementation notes

Read state/voice.ts fully first; the recognition/permission preload in App.tsx (~line 185+)
already warms the model. Do NOT fork a second recognition pipeline.

# Out of scope

- Voice commands, auto-submit timers for Epics.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— every rule is mandatory, especially Execution discipline (bounded commands, verify before
done). All renderer PRDs: `timeout 300 npm run typecheck` + `npm run lint:selectors` +
targeted `timeout 300 npx vitest run <files>` must pass; add/extend vitest coverage for your
change.
