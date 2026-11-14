# Validation: demo-video narration plan (PRDs 3089-3094)

Base: a53d5fc35e62fc0dac9801f88aedcc5fc64a058f. Commits 78fc0b6e, 7b43d90b, 712c26ae, 79477880, 90d06994, 5205b2c8. All six PRD files found in prds-archived/.

Gates (SM_*/CLAUDECODE unset), all six PRDs' gate files run together: 11 files, 205 tests, all green.

## demo-video-bed-nan-guard — VERIFIED
- sound.cjs:109 `Math.max(0, Math.sin(...)) ** 0.5`; sound.cjs:278 replaces non-finite bed samples with 0.
- seedKit.cjs:20 `KIT_VERSION = '2'`.
- Probe: 60 s Professional bed decoded, all 2,646,000 samples finite. Gate green.

## demo-video-check-decodes-audio — VERIFIED
- checks.cjs:131 `speechModulationShare`, :177 `checkAudioHasSpeech` (id `audio-speech`), :213 added to `runChecks` when html is a string; sound.cjs:302 exports runFfmpeg/decodeWavF32.
- Probe: real mix output share 0.86 ok:true; 131+196 Hz hum share 0.00 ok:false. Gate green.

## demo-video-kit-playwright-npx-loader — VERIFIED
- playwrightLoader.cjs new (67 lines); capture/frames use it; KIT_FILES includes it (seedKit.cjs:21). Gate green.

## demo-video-kit-character-standalone — REFUTED (regression elsewhere)
- character.cjs no longer requires `../opsOwnership.cjs`; probe: every seeded KIT_FILES entry loads via `node -e require()` from the seeded folder, exit 0. Own gate green.
- BUT character.cjs:12 adds the literal `'session-manager-operations'`, which fails the repo-wide `scripts/__tests__/check-ops-path-literals.test.cjs > the real repo tree is clean`. Passes at Base, fails at HEAD, alone: regression (not a load flake). The PRD's gate did not include this test.

## demo-video-persona-stop-on-kit-failure — VERIFIED
- demo-video-builder.md: seedVersion 11; `<kit>` and `<when_things_fail>` say the soundtrack comes only from sound.cjs's mix, a failed kit tool stops the run, saves nothing, and hand-written ffmpeg mixing is forbidden. shippedPersonaSeeds.cjs gained the entry. Gate green.

## demo-video-prompt-character-truthful — VERIFIED
- builtinMacros.cjs:54 builtinVersion 8; line 70 opens "Generate a cute animated JavaScript video with an original mascot character unless a Character: off line says otherwise"; previous prompt in priorPrompts. Gate green.

## Real-path probe — PASS
env -i, fresh HOME, real `seedDemoVideoKit` (installed v2, 7 files), mix Professional/60 s with a 4 Hz-modulated noise narration: mp3 480,461 bytes, finite bed, checkAudioHasSpeech passes it, fails hum, all kit files load from the seeded folder.

## Full unit suite
`npx vitest run`, SM_*/CLAUDECODE unset: 1053 files passed, 1 failed (10235 tests passed, 1 failed). The failure is `check-ops-path-literals` above: re-run alone at HEAD red, at Base green => regression from 3092.

## Findings
- **Important** — src/main/lib/demo-video-kit/character.cjs:12: replace the `'session-manager-operations'` literal (e.g. build from parts, or whatever the lint allows) so check-ops-path-literals is green; keep standalone loading.
- **Minor** — probe mix measured -15.5 LUFS against the -14 target (synthetic noise narration; not investigated).
- No security issues seen: temp files cleaned in finally, data URI decoded via ffmpeg args array (no shell).
