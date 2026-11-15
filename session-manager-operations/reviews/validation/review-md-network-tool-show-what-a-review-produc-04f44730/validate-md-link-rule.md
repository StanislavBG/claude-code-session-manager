# Validation: md-link-rule plan (3139 / 3140 / 3141)

Base: 76fe982537e696b27ec812ca60fbe3bbef20d989 (from the PRD). HEAD: 7ae2223863453d6db1ce136992fb76db225722b9.
Commits: 2cb145db (scan), 7b2b4e91 (skill), 7ae22238 (drift-check).
Review tools: `/code-review` and `/security-review` not run as agents; self-reviewed the combined diff (no path traversal: `escapesRoot` guards on every resolved ref; no secrets; drift-check stays dependency-free).

## md-scan-follow-paths-imports — VERIFIED
- One function returns followed refs: `src/main/lib/mdNetworkScan.cjs` `refsOf` (links + imports via `importsOf` + `.md` backtick tokens, root-first then doc-relative); used by `buildMdNetwork` and the `scanMdNetwork` BFS (diff hunks at the `for (const link of refsOf(...))` sites).
- Path/import refs only edge when `isDoc`; broken test is `link.kind === 'link' && ...`, so no finding for them; unvouched probing is `link.kind === 'link'` only. Fences/comments handled by `backtickPaths`; non-.md tokens filtered by `endsWith('.md')`.
- Header 'Followed' paragraph rewritten and names the skill convention.
- Tests (a)-(d) added in `mdNetworkScan.test.cjs`.
- Gate: `vitest run mdNetworkScan.test.cjs` → 20 passed; `npm run typecheck` → exit 0.

## md-skill-link-convention — REFUTED — plugin.json bumped to 0.4.1 but `.claude-plugin/marketplace.json:17` still 0.4.0; `scripts/__tests__/dev-plugin-skillset.test.cjs:62` fails, so the plan's full suite is red
- SKILL.md:26 'What counts as a link', 7 lines, three forms; `git grep -F 'What counts as a link' -- plugins/` → exactly one heading (SKILL.md:26).
- drift-check.md 'Path conventions' sentence added, no cross-reference link; Session line after Scope and a Rules line added; plugin.json 0.4.0→0.4.1.
- Gate `vitest run scripts/__tests__/md-network-drift-check.test.cjs` → green (33 passed together with parity test).
- But the version-parity contract (plugin.json == marketplace entry) was not honoured; the PRD's Files list omitted marketplace.json.

## drift-check-orphans — VERIFIED
- `drift-check.cjs`: `ALL_CHECKS` includes `orphans`, `DEFAULT_CHECKS` is the four old ones (parseArgs and runDriftCheck default to it).
- `reachableDocs` BFS from `CLAUDE.md` over all `listDocs`; `docRefs` mirrors scanner order (links/autolinks, @-imports, backtick root-first then doc-relative); findings `{kind:'orphan', file}` for checked docs only; no root CLAUDE.md → note, no findings.
- drift-check.md has one flags row and one finding-kind row, opt-in stated.
- Tests added in `md-network-drift-check.test.cjs`; new `mdNetworkLinkParity.test.cjs` with temp git fixtures.
- Gate: both files → 2 files / 33 tests passed.

## Plan-level criteria
- Real-repo probe (`scanMdNetwork`): family-frame → 20 nodes, 37 links, 0 findings, so no orphans (CLAUDE.md-named docs reached). Bilko → `docs/map.md` is a node (linkedFrom 1), not in any orphan finding's paths. PASS.
- `npm run lint` → exit 0.
- `timeout 1200 npm run test:unit`: run 1 had 2 failing files (9 tests; `EpicDetailPrdsRuns.test.tsx` flaked under load and passes alone, 9/9). Run 2 failed only `dev-plugin-skillset.test.cjs > plugin.json version equals the marketplace entry version` (expected '0.4.1' to be '0.4.0'). Deterministic. FAIL.

## Findings
### Critical
- none
### Important
- `.claude-plugin/marketplace.json:17` is 0.4.0 while `plugins/session-manager-dev/.claude-plugin/plugin.json:4` is 0.4.1; the suite is red at plan HEAD. Fix: bump the marketplace entry to 0.4.1 (and any other place that test checks).
### Minor
- `EpicDetailPrdsRuns.test.tsx` (Runs tab empty state) flaked once in the full run under load; unrelated to this plan.
- drift-check.md's orphan rows restate the reference rule in detail (links SKILL.md anchor); acceptable but a second place to keep in step.
- `drift-check.cjs` `docRefs` duplicates the scanner's rule by design (vendored, dependency-free); the parity test is the guard.
