# Validation: release-workflow-test-draft-flow

Base: 5faaea25. Commit: af2dcb16 (only change: scripts/package/__tests__/release-workflow.test.cjs, +10/-1).

## release-workflow-test-draft-flow — VERIFIED

- AC1: test.cjs:27-30 expects `-c.publish.releaseType=draft` and `.not.toContain('...=release')`.
- AC2: new test 'creates one draft release before the matrix and publishes it after' (test.cjs:32-39) asserts `create-release:`, `needs: create-release`, `gh release create "$TAG"`, `--draft`, and indexOf(`--draft=false --latest`) > indexOf(`--publish always`). release.yml has these at lines 16, 35, 31, 31, 158 (after 142).
- AC3: `git diff 5faaea25..HEAD --stat -- .github` is empty; release.yml not edited.
- AC4: `timeout 120 npx vitest run scripts/package/__tests__/release-workflow.test.cjs` → 1 file, 11 passed, 0 failed.
- Gate re-run: green (above).

## Diff review
Test-only, plain toContain/indexOf matching existing style. No secrets, no input handling, no duplicated helper. Self-review (no separate tool run).

## Findings
- Critical: none. Important: none.
- Minor: none. (PRD file found in prds-archived.)
