# Validation — Claude config wave 7

Base: f49db4ff. One commit in range: c223ba8a (only `tests/web-ui/claude-config-shots.spec.ts`, +27 lines, no product code).

## agents-editor-fill-assertions (PRD 3444) — VERIFIED

- AC1 (fill lower bound): `claude-config-shots.spec.ts:146-148` — after the `bottom <= 1040` check, `detail.bottom − status.bottom <= 48` against `config-workbench-detail`'s bounding box. Passes at 1592x1040.
- AC2 (short pane): `shortPane()` at `:224-245` sets the viewport to 1592x700 and asserts `scrollHeight > clientHeight`, `agent-detail-editor` height >= 320, then scrolls with `el.scrollTop = el.scrollHeight` (no `scrollIntoView`) and asserts the status bar's y and bottom lie within the column's client box. Called at `:313` after the home loop. Agents is the last home tab (home tabs end at `:152`; Memory belongs to the project face), so the Agents panel is the one open. Only the active tab is rendered (`HomeClaudeConfig.tsx:160-167`), so the check measures the real Agents editor.
- AC3 (no PNG): `shortPane` has no `screenshot`/`written.push`; the run produced 11 files in `test-results/claude-config/`; the screenshot loop runs before `shortPane` at 1592x1040.
- AC4 (gate), re-run at HEAD:
  - `npm run typecheck` exited 0.
  - `npm run lint` exited 0. I did not capture the full output (tail only showed `lint:readme`).
  - `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots` printed "1 passed (24.3s)".

## Wave-6 Minors

- Minor 1 (lower bound on fill): CLOSED by the 48px bound (`:146-148`). The dev-lead mutation proof (editor fixed at its floor failed with a gap of 89px) is credible; I did not repeat it.
- Minor 2 (short-pane browser check): CLOSED by `shortPane()`, a real browser check at 700px.

## Review

Self-review of the diff (a test-only change): no input handling, secrets or paths involved, and no existing helper duplicated. The skills `/code-review` and `/security-review` were not run; this is a 27-line test diff.

## Findings

Critical: none.
Important: none.
Minor:
1. `claude-config-shots.spec.ts:146-148` — the 48px tolerance is loose. The dev-lead's own report says that removing `flex-1` alone does not fail with the current sample data, because the editor content is already ~388px tall. The check catches a shrink toward the floor, not the loss of `flex-1` as such. Accepted limit, no PRD needed; close reason: documented in the commit and report, and a stricter bound would couple the test to sample-data height.

New findings beyond that: none. The PRD file was found in prds-archived.
