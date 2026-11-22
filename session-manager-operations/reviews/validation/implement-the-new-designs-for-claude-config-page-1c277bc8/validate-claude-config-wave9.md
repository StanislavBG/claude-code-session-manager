# Validation: wave 9 — config-band-scope-path

Base: 905b98d3 (commit under review: f3580abf, the only commit touching the PRD's paths). PRD file: prds-archived/3459-config-band-scope-path.md.

## config-band-scope-path — VERIFIED

- AC1: `ConfigBand.tsx:44` exports `compactScopePath(path, max = 32)`. It returns the path unchanged when `path.length <= max`. Otherwise it returns `…/` plus trailing segments, keeping the last segment whole (loop breaks only on `2 + next.length > max`).
- AC2: `ConfigBand.tsx` renders `compactScopePath(scopePath)` in a span with `data-testid="config-band-path"` and `title={scopePath}`. Its class is `inline-block font-mono text-xs text-rhythm`, with no `truncate`. The title group is `min-w-[236px] shrink-0`. The tablist is `min-w-0 overflow-x-auto`, so the tab strip yields first.
- AC3: `ConfigBand.test.tsx` covers:
  - `~/Projects/Self` and `~/.claude` unchanged;
  - a long nested path starting with `…/` and ending with its last folder (`…/monorepo/packages/web-frontend`);
  - an overlong single segment kept whole;
  - `title` equal to the full path, with no `truncate` class.
- AC4: `claude-config-shots.spec.ts` (+6 lines) asserts `toHaveText(spec.scope)`, the `title` attribute, and `scrollWidth <= clientWidth`. The spec passed.
- AC5 / gate, all run at HEAD:
  - `npm run typecheck`: clean.
  - `npm run lint`: OK (the last lines shown were the scroll-into-view check and `lint:readme`).
  - `npx vitest run src/renderer`: 361 files, 3467 tests passed.
  - `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots`: 1 passed.
- Screenshot: I opened `test-results/claude-config/project-memory.png`. The band reads "Claude config ~/Projects/Self" in full, with no ellipsis.

## Review of combined diff (3 files, +68/-4)

I self-reviewed. `/code-review` and `/security-review` were not run. The diff has no input handling, secrets, paths or I/O. The helper is a pure string function.

## Findings

Critical: none.
Important: none.

Minor:
1. `ConfigBand.tsx:~188`: `compactScopePath` splits on `/` only, so a Windows `\` path would not elide. This is acceptable, since the band path is `~`-style, but it is unhandled.
2. `ConfigBand.tsx:~200`: the tablist now has `overflow-x-auto`. In a narrow window the tabs scroll horizontally, which clips the active tab's shadow/focus ring. This is not covered by any test.
3. Design deviation: the design mock shows `~/Self` but the band shows `~/Projects/Self`. This follows the PRD's "show the whole path" intent, but DESIGN_SPEC section 5 (commit 943fa133) was not re-read to confirm it lists this deviation.
4. `ConfigBand.tsx:44`: `max = 32` is a magic number with no tie to the actual 236px title-column width.

New findings: none beyond the four Minors above.
