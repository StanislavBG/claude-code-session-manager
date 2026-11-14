# Validation: settings-general-card-area (PRD 3045)

Base 4c3750cf; landed commit cc826ffd (Settings.tsx, frame-integrity.mjs, Settings.tabs.test.tsx).

## settings-general-card-area — VERIFIED

- Header holds only scope note, error banner, toolbar; SourceChip + OwnedSummaries are first children of PageShell content above EffectiveCardsSections (`git show cc826ffd`, Settings.tsx ~L214-226). Testids unchanged. Rail/`scrollToAnchor` untouched by the diff.
- frame-integrity.mjs measures content vs shell clientHeight for General at each viewport, prints both on the PASS line, and FAILs under 60% (diff, ~L277-290).
- Settings.tabs.test.tsx asserts summaries inside page-shell-content and not in page-shell-header.
- Gate: vitest (3 files, 11 tests) passed; `npm run typecheck` exit 0; `node scripts/frame-integrity.mjs` exit 0, 12/12.
- Measurements: 1400x900 content 523px / shell 612px = 85%; 900x650 content 220px / shell 330px = 67% (both ≥ 60%). Script runs only these two viewports.
- Revert check (local, uncommitted, file restored byte-identical): old header composition gave 1400x900 380/612 = 62% PASS, 900x650 77/330 = 23% FAIL ("usable area too small"), exit 1, 11/12.

## Findings

- Critical: none. Important: none.
- Minor: the script covers only 1400x900 and 900x650, so the PRD's 1280x720 and 1100x700 figures are not guarded. At 1400x900 the old layout still passes the 60% bar (62%), so that viewport does not catch a regression; 900x650 does.
- Minor: Hooks scenario still logs a non-fatal page error (declared out of scope).
- Code/security review: self-reviewed; diff is a JSX move plus a measurement, with no input handling, secrets or paths.
