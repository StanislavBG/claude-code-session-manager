# Validation: ci-npm-trusted-publish-job + builder-publish-step-ci-first

Base: 76fe982537e696b27ec812ca60fbe3bbef20d989. Commits: 9f7b2627 (ci), 8f58441b (docs). PRD files found in prds-archived/ (3136, 3137).

## ci-npm-trusted-publish-job — VERIFIED
- Job on ubuntu-24.04 with `id-token: write` + `contents: read`: release.yml npm-publish block; triggers `on: push tags v*` + workflow_dispatch at release.yml:4-7.
- checkout@v4, setup-node@v4 (node '22', registry-url, cache npm), `npm install -g npm@^11.5.1`, `npm ci`, `npm publish --access public`: present in diff; no NPM_TOKEN/NODE_AUTH_TOKEN/secrets reference in the job.
- Version-vs-tag check (`${GITHUB_REF_NAME#v}`, exit 1 on mismatch) and `npm view` skip with log line + `skip=true`; publish guarded by `skip != 'true'`.
- No `needs:` in the job (asserted by test).
- release-workflow.test.cjs gains 8 tests covering every required assertion.
- Gate `timeout 120 npx vitest run scripts/package/__tests__/release-workflow.test.cjs`: 19 passed.

## builder-publish-step-ci-first — VERIFIED
- SKILL.md CI-publish path after step 4: grep detection, skips steps 5-7/9, pushes main+tag, `timeout 1200 gh run watch ... --exit-status`, cache-busted packument poll (20 tries, 30 s).
- Failure path: `gh run view <run-id> --log-failed`, fallback exactly once, E409 still needs human approval.
- Local steps 5-11 kept intact, labelled "Local worktree path (fallback)"; skill stays project-agnostic.
- builder.md item 4 rewritten (OIDC job, one-time registration steps, local fallback); file shrank 5653 -> 5411 chars (limit +300).
- build-target.md contradicting paragraph updated (in Files list).
- Gate `npm run lint:docs`: ok (21 junctions, 35 files).

## Review
/code-review and /security-review were not run as separate tools; self-review of the diff: no secrets, OIDC-only permissions scoped to the job, tag name used only in quoted shell vars (no injection from `${{ }}` into run scripts; `VERSION` passed via env).

## Findings
- Critical: none.
- Important: none.
- Minor: SKILL.md CI-publish watch command — `gh run list --branch v<version> --limit 1` may return empty if the run has not been created yet right after the tag push (race); a short sleep/retry would harden it.
- Minor: workflow_dispatch from a branch ref fails the version==tag check by design (GITHUB_REF_NAME is a branch name); acceptable but undocumented.
- Minor: npm-publish only works after the human registers the trusted publisher on npmjs.com (out of scope; documented in YAML comment and builder.md).
