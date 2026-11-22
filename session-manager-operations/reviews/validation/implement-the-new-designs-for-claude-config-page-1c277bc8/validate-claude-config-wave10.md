# Validation: wave 10 — config-band-path-tabs-polish

Base: 481afa57. Commit: 6101b158 (touches only the 3 PRD files: ConfigBand.tsx, ConfigBand.test.tsx, claude-config-shots.spec.ts). No PNG changed.

## config-band-path-tabs-polish — VERIFIED

- AC1 compactScopePath splits on both separators and keeps its own: `ConfigBand.tsx:62` `split(/[\\/]/)`, `:66-68` sep chosen by first separator, `:74` returns `…${sep}${tail}`. Test `ConfigBand.test.tsx` expects `…\monorepo\web-frontend`.
- AC2 `export const SCOPE_PATH_MAX_CHARS = Math.floor(BAND_TITLE_MIN_W_PX / 7.2)` (`ConfigBand.tsx:~50`) beside `export const BAND_TITLE_MIN_W_PX = 236` (`:~42`), with a 12px mono 0.6em derivation comment; default arg uses it; the title group still carries the literal `min-w-[236px]` and a test asserts the class matches the constant.
- AC3 tablist className `… overflow-x-auto p-1 -m-1` (`ConfigBand.tsx:~222`) with a comment explaining the clip at the padding box.
- AC4 Tests added: Windows path, constant default (=32), padded scroller classes, title min-w. Spec `narrowTabStrip` (`claude-config-shots.spec.ts:~268-289`, called at `:~366`) sets 1100px, keyboard-focuses the active tab, asserts scroll and tab box ±2px inside tablist client box. Runs after the PNG loop; writes none.
- AC5 Gate re-run at HEAD:
  - `npm run typecheck` → exit 0
  - `npm run lint` → exit 0 (all checks OK)
  - `npx vitest run src/renderer` → 361 files, 3471 tests passed
  - `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots` → 1 passed

## Wave-9 Minors

- Minor 1 (Windows path, no elision): CLOSED — AC1 evidence; Windows test passes.
- Minor 2 (tab scroller clips shadow/focus ring, untested): CLOSED — `p-1 -m-1` plus class test plus Playwright geometry check.
- Minor 3 (design shows `~/Self`, band shows `~/Projects/Self`): NOT in scope, still open as noted. It is sample data (DESIGN_SPEC §5 item 7: "Sample-data differences … are never findings"); §5 "do not re-flag". Re-read from 943fa133: not a finding.
- Minor 4 (magic `max = 32`): CLOSED — named `SCOPE_PATH_MAX_CHARS`, derived from `BAND_TITLE_MIN_W_PX`.

## Combined diff review

Self-review (3 files, +103/−11): no unsafe input handling, secrets, or path access; pure string helper. No existing helper duplicated.

## Findings

Critical: none.
Important: none.
Minor:
1. `ConfigBand.tsx:~66-68`: separator detection uses the first of `/` or `\` found; a mixed-separator path (e.g. `C:\a/b`) would be joined with `\`. Cosmetic, unlikely. Not sample data, not a §5 deviation.
2. `ConfigBand.tsx:~50`: `BAND_TITLE_MIN_W_PX` and the literal `min-w-[236px]` are kept in step by hand (Tailwind literal requirement); guarded by a unit test, so the drift risk is covered. Not sample data, not a §5 deviation.

New findings beyond these: none. Sample-data items: none new (wave-9 Minor 3 only, per above). DESIGN_SPEC §5 deviations: none new.
Note: `git status` showed foreign deleted files (`project-pages/home.html`, `demo-video/index.html`) — not this job's, not staged.
