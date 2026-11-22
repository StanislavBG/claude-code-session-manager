# Validation: npm publish preflight plan

Base: 417a5fbd977fc48c09a3cbddaa40cd6ae13f2d26 (commits 006d9b23, e0c7c8ba, e5967d9b, ce15b347, 70e50074 on the plan's paths).
Gates re-run (all exit 0): `vitest run` on builder-publish-preflight, builder-skill-preflight-doc, release-workflow (3 files, 25 tests pass); `node --check publish-preflight.cjs`; `npm run lint:test-smells` (OK); js-yaml parse of release.yml; `npm run lint:docs` (ok). The preflight was exercised only via unit tests.
`/code-review` and `/security-review` not run; self-reviewed the diff (no secrets, no shell, no path traversal, no new helper duplication).

## builder-publish-preflight-script — VERIFIED
- Exports async `preflight`, `main()` only under `require.main === module`, one stdout line, exit 0/1: publish-preflight.cjs:196, 241-255.
- Local BLOCKs (whoami, revoked, expired, bypass_2fa, scope, owner) and 14-day WARN text: :125-175.
- CI mode only when `npm-publish:` job present (:77); blocks only when CI dead AND local blocked, naming both: :222-231.
- Token never printed: only compared to redacted field (:103-110); no path emits it.
- `spawnSync` with `shell: false`, 30 s timeout, cwd set (:33, :206); only Node built-ins (:22-24).
- Test covers all listed cases (test.cjs:68-175) and asserts no token/newline (:62-63).

## release-yml-drop-dead-npm-publish-job — VERIFIED
- `git diff` shows only the npm-publish job removed plus one header comment line; other jobs, triggers, concurrency, permissions untouched. No `npm-publish:`, `id-token: write`, `npm publish` remain (test asserts it).
- Describe block replaced by a single `it` (release-workflow.test.cjs:92-98); other tests unchanged; YAML parses.

## builder-skill-runs-publish-preflight — VERIFIED
- SKILL.md `## 3. Gate and publish preflight` with command, BLOCKED stop-before-step-4, verbatim report, no retries, OK/WARN copied (SKILL.md ~48-52).
- `**Preflight**` bullet first in step 6; step 4.7 mentions preflight and `npm token list --json` / `bypass_2fa`, `npm profile get` errors.
- No renumbering (steps 1-6). Net growth: 12 insertions / 4 deletions, ~1.1k chars (see Minor).
- Drift test asserts the four required properties (builder-skill-preflight-doc.test.cjs:16-30).

## npm-publish-docs-token-path — VERIFIED
- builder.md item 1 names `npm token list --json`/`bypass_2fa` and `npm profile get` caveat; items 4-5 state no CI path (2026-11-21, commit 9f7b2627), granular 'Bypass two-factor authentication' token, 90-day renewal, preflight BLOCKED line; item 3 carries the Jan 2027 note and changelog link.
- builder.md is 5354 chars (≤ 5800).
- build-target.md provenance paragraph fixed; 2FA section is 9 lines (≤ 10) and includes the `npm publish` Allowed-actions and 2-day first-publish facts.
- No npm username or token expiry date: grep for owner name/dates finds only pre-existing GitHub repo URLs and policy dates. `lint:docs` passes.

## Findings
### Critical
none
### Important
none
### Minor
- SKILL.md step 4.7: the added text produced one very long line (~190 chars); and net growth slightly exceeds the PRD's ~900-char target.
- builder.md: the old item 3 was also rewritten (as the new bridge note) rather than only items 4-5; consistent with the criteria's intent.
- publish-preflight.cjs:56: the 400-char cap truncates blindly and could cut a trailing `WARN:` on long details.
