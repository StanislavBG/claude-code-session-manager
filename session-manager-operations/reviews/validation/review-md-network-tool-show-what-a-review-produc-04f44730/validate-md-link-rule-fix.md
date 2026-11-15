# Validation: md-plugin-marketplace-version-sync + md-skill-link-convention re-check

Base: 6ca5d9f0af48ac9901b46f54f4d415a57a72d381; HEAD checked: worktree HEAD (includes 325dfba9).

## md-plugin-marketplace-version-sync (PRD 3161) — VERIFIED
- Commit 325dfba9 changes only `.claude-plugin/marketplace.json` (1 line): `git diff 6ca5d9f0 HEAD -- .claude-plugin` shows 0.4.0 -> 0.4.1 on the session-manager-dev entry (line 17); metadata.version (line 10) still 0.1.0.
- plugin.json:4 is 0.4.1 and was not touched (`git diff --stat` on plugins/session-manager-dev shows nothing).
- Gate `timeout 300 npx vitest run scripts/__tests__/dev-plugin-skillset.test.cjs scripts/__tests__/md-network-drift-check.test.cjs`: 2 files, 33 tests passed.

## md-skill-link-convention (PRD 3140) — VERIFIED
- SKILL.md:26-33 has '## What counts as a link' (8 lines incl. heading) listing markdown link, backticked repo-root .md path, @path.md import, reachability in link map + orphans check, markdown preferred.
- `git grep -n -F 'What counts as a link' -- plugins/` finds exactly one heading (SKILL.md:26).
- drift-check.md:69 Path conventions first paragraph: backticked path claims existence and, for .md, counts as a link per SKILL.md; no link to another reference file.
- drift-check.md:145 `- Session: <Epic id of the session that ran the review>` directly after Scope (144); Rules line at :176 says it lets Project Home link the record to its session and validation record.
- plugin.json:4 = 0.4.1 and marketplace entry :17 = 0.4.1 — the parity failure that refuted it is gone (parity test passes).
- Gate md-network-drift-check.test.cjs passes (above).

## Suite and lint at HEAD
- `timeout 900 npm run test:unit`: 1070 files passed, 10451 tests passed, 1 skipped. Green; no flakes seen.
- `timeout 300 npm run lint`: RED at `lint:test-smells`: `src/main/lib/packs/__tests__/packCatalog.test.cjs: new no-assert smell`. That file came from `6ca5d9f0 feat(packs): add packCatalog.cjs context-pack loader` (the context-packs plan), not from either PRD here; both PRDs touch no test or src files. Earlier lint stages passed. Lint criterion is therefore not met at HEAD.

## Findings
### Critical
- none
### Important
- `src/main/lib/packs/__tests__/packCatalog.test.cjs` (whole file): the test-smells lint reports a new no-assert smell, so `npm run lint` exits 1 at HEAD. Owner is the context-packs plan; needs a fix PRD (add assertions; do not allowlist). Out of scope for the two PRDs validated here, which are VERIFIED.
### Minor
- Working tree shows `session-manager-operations/project-pages/{home,demo-video/index}.html` as deleted in this worktree; they are foreign WIP and were not touched.

Review commands: /code-review and /security-review were not run; the plan diff is a one-line JSON version change plus docs, self-reviewed: no code, input handling, secrets or paths involved.
