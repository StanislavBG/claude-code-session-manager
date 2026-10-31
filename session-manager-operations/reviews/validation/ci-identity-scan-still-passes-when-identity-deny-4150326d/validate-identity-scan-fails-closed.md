# Validation: ci-identity-scan-still-passes-when-identity-deny-4150326d

Base: e2ea9734 (given). PRD 2426 file found in `prds-archived/`. Landed commit: `cc88433a` (touches exactly the 3 listed files; `git diff base..HEAD` also holds other plans' commits, not reviewed here).
Reviews: `/code-review` and `/security-review` not run separately; self-reviewed the 3-file diff (no secrets, no real identity strings, no path traversal; sandbox uses mkdtemp).

## identity-scan-fails-closed-on-main — VERIFIED

| Criterion | Evidence |
| --- | --- |
| push + empty → exit 1, `::error::` naming secret and doc | ci.yml step: empty-check branch ends `echo "::error::IDENTITY_DENYLIST secret not set; … identity-boundary.md)"; exit 1`; test `push + empty secret…` passes |
| pull_request + empty → exit 0, `::warning::` | ci.yml `[ "$GITHUB_EVENT_NAME" = pull_request ]` branch warns, `exit 0`; test passes |
| comment/blank-only → exit 1 `::error::` on both events | ci.yml `case "$out" in *"entries checked"*)` else `::error::… no usable entries` `exit 1`; tests for push, pull_request, whitespace-only pass |
| one clean entry → pass line `(1 entries checked)`; tracked hit → exit 1, `deny-list entry #1`, entry text absent | tests at ci-identity-scan.test.cjs:99-113 pass (asserts `not.toContain(ENTRY)`) |
| Test lifts `run:` block as text, bash -e, throwaway repo, synthetic strings | test.cjs:15-27 (text slicing, no YAML dep), :38 `spawnSync('bash',['-e',bodyFile])`, :48 mkdtemp, :12 synthetic `zz-synthetic-entry` |
| identity-boundary.md updated | diff replaces the paragraph with the PRD's exact text: push fails, PR warns and why, no-usable-entries fails, Dependabot self-merge fails |
| No pipe to tee (pipefail hazard) | step captures via `out=$(… ) \|\| status=$?` then `printf` and `exit "$status"` |

Gate re-run (SM_* unset):
- `npx vitest run` three files: 3 files, 26 tests passed.
- `npm run lint`: exit 0 (page-stewards clean, e2e budget 18/19).
- `scripts/identity-guard.sh`, release.yml, dependabot.yml untouched by `cc88433a`.

## Findings

Critical: none.
Important: none.
Minor:
- ci-identity-scan.test.cjs:1-3 mixes `'use strict'` with ESM `import` and `require`; works under vitest, stylistically inconsistent with the neighbouring tests.
- ci.yml pass-line check is a substring match on `entries checked` over the full output; a guard report that happened to contain that phrase alongside exit 0 would be accepted. Exit 0 from the guard already implies no hit, so impact is nil.
