# Validation — claude-config wave 6

Base: 4f8aec9d30e71bfcc731fd7ee7d9e576e528b02a. PRD: `prds-archived/3442-agents-editor-fills-pane.md`. Commit: `4254d5b6` (3 files, matches the PRD's # Files; later HEAD commits `fc3b7f69`, `ba70a3a4`, `fdc1f93e` are unrelated epic-intake work and touch none of its paths).

## agents-editor-fills-pane — VERIFIED

- Root is flex column + `min-h-full`: `AgentDetail.tsx:258` `className="flex-1 shrink-0 min-h-full flex flex-col"` (no `min-h-0`).
- Editor `flex-1 shrink-0 min-h-[320px]`: `AgentDetail.tsx` editor container (diff hunk @@ -459); `min-h-[480px]` gone.
- Comment rewritten to describe the new rule (`AgentDetail.tsx:254-257`). No new scrollers added (diff has only class and comment changes).
- Shots spec asserts detail `scrollTop === 0` and `editor-status-bar` bottom <= `VIEWPORT.height` on home-agents (`claude-config-shots.spec.ts` ~line 142-145).
- `AgentLibrary.test.tsx` asserts `flex`, `flex-col`, `min-h-full`, `shrink-0` on the root; `flex-1`, `min-h-[320px]` and not `min-h-[480px]` on the editor.
- Gates re-run at HEAD, foreground:
  - `npm run typecheck`: exit 0.
  - `npm run lint`: exit 0.
  - `npx vitest run src/renderer`: 361 files, 3441 tests passed.
  - `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots`: 1 passed.

## Wave-5 Minor 1 (editor status bar below the fold) — FIXED

Rendered `test-results/claude-config/home-agents.png` at 1592x1040: the status bar (Saved · matches the file on disk · 62 words · Save) sits at y≈975-995, inside the first view, with the detail column unscrolled. This matches `renders/15-home-agents.jpg` (224fe3ef), where the status bar is the last row of the pane. The editor stretches to fill the remaining height, as in the design. Remaining differences are sample data (tools set, effort, project overrides, model values) or app chrome the shot omits; none are findings.

## Findings

Critical: none.
Important: none.

Minor (each needs a cleanup PRD or an explicit close reason):
1. `tests/web-ui/claude-config-shots.spec.ts:~145` — the assertion is only an upper bound (`bottom <= 1040`). It would still pass if the editor shrank back to its floor and left empty space. A lower bound (bottom near the viewport bottom) would pin the "fills" half of the behavior.
2. `AgentDetail.tsx:258` — the short-pane case (the detail grows past the pane and the workbench column scrolls) is covered only by class assertions and code reading, not by a browser check at a short viewport. The dev-lead report admitted the same.

New findings beyond the two Minors: none. Missing PRD file: none (found in prds-archived). Code review / security review: self-reviewed; a CSS-class-only change, with no input handling, secrets or paths involved.
