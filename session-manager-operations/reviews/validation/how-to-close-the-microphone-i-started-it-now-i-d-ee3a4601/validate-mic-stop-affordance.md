# Validation: mic stop affordance (PRDs 1619, 1620)

Base: 76cee274. Commits: f9a36d45 (1619), be2c5f4a + merge c6bf3559 (1620). PRD files read from `prds-archived/` in the main checkout.
Gates re-run (node_modules symlinked from main checkout, scratch TMPDIR): both new test files 6/6 pass; `npm run typecheck` exit 0; `npm run lint` exit 0.

## live-transcript-stop-button — VERIFIED
- Button type=button, testid `live-transcript-stop`, aria-label/title "Stop microphone", glyph ×, gated on `isRecording`: `src/renderer/components/LiveTranscript.tsx:77-88`.
- onClick `useVoice.getState().stopRecording()`; `pointer-events-auto` in className; outer wrapper untouched: LiveTranscript.tsx:83-85.
- Last child of inner flex row, after SubmitCountdown block; classes `text-fg-dim hover:text-fg rounded px-1.5` only, no color literals: LiveTranscript.tsx:74-86.
- Tests cover present / absent-when-fading-partial / click once: `__tests__/LiveTranscript.stop.test.tsx:46-65`.
- Gate: vitest + typecheck + lint green.

## recording-banner-stop-button — VERIFIED
- Button testid `recording-status-stop`, aria-label, text "Stop ×", `ml-auto`, gated on `storeRecording`: `RecordingStatus.tsx:31-41`.
- External-only: banner renders via `isRecording || externalRecording` (line 16-18), button gated on `s.isRecording` only; test `RecordingStatus.stop.test.tsx:46-50`.
- Click calls `useVoice.getState().stopRecording()`; test asserts once (lines 52-58).
- Selector hook declared above early return (line 17); testid/role/Z.recording/copy unchanged in diff; styling `border-red-700 hover:bg-red-900 text-red-100`.
- Gate: vitest + typecheck + lint green.

## Findings
### Critical
- none
### Important
- none
### Minor
- `RecordingStatus.stop.test.tsx` afterEach resets only `isRecording`/`externalRecording`, leaving the stubbed `stopRecording` in the store (harmless across this file; other files in same worker are isolated by vitest).
- 1620 dev report noted no captured red run (implementation preceded test); not a landed-behavior defect.
- Combined diff reviewed by hand (no secrets, no path/input handling, no duplicated helper); changes confined to the four listed files.
