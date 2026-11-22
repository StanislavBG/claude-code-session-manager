# Validation: md-scan-truth plan

Base: 81fda522 (known). Commits in range: f23d893b, ff65e1b0, 34a25ca4, b5e444de, cbfe0f93, c676f933, 1df8db92.
Gates re-run (foreground): one vitest run over all 11 plan test files — 11 files / 205 tests pass; `npm run typecheck` rc 0; `npm run lint:docs` ok (22 junctions, 38 files).
Real-repo check: scratch script under $TMPDIR required the landed `src/main/lib/mdNetworkScan.cjs` and called `scanMdNetwork('/home/bilko/Projects/session-manager')`, read-only.

## md-links-shared-parser — VERIFIED
- mdLinks.cjs exists in the skill's scripts/ (commit f23d893b); exports used by all callers: linksOf, rawLinksOf, followLink, visibleText, visibleLine, importsOf, backtickPaths, toRepoPath.
- scripts/__tests__/md-links.test.cjs passes. scripts/package/stage.cjs unchanged; package.json `files` lists `plugins/`, so the new file ships.

## md-links-wire-app — VERIFIED
- mdNetworkScan.cjs:64 requires mdLinks.cjs; grep finds no local definition of parseDestination/lineTargets/stripComments/visibleText/followLink/linksOf.
- mdDocCensus.cjs:31 takes importsOf from it; mdDocRefs.cjs:21 takes backtickPaths; no FENCE_RE/INLINE_CODE_RE/IMPORT_RE left in either (grep clean).
- Existing mdNetworkScan/mdDocCensus/mdDocRefs/LinkParity tests and typecheck green.

## md-links-wire-tools — VERIFIED
- drift-check.cjs:23 requires './mdLinks.cjs'; check-doc-hierarchy.cjs:23 and memoryMdNetwork.cjs:12 require it too; MD_LINK_RE gone from memoryMdNetwork (grep clean).
- drift-check, check-doc-hierarchy, memoryMdNetwork, LinkParity tests pass; lint:docs ok.

## md-scan-entry-points-history — VERIFIED
- mdNetworkScan.cjs:92-94 LOADED_BY_TOOLS = ['.claude/','.github/','plugins/','src/seed/'] + root files README/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/CHANGELOG; :215 also matches `/skills/`; `localOnly?: boolean` at api.d.ts:1917.
- Real scan: findings = 2 orphan groups only (session-manager-operations/design-mocks/* ×10, web/promo-video/script/* ×2) plus broken-link; no `.claude/`, `src/seed/`, `plugins/` or root README/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY doc is orphaned.
- New tests in mdNetworkScan.test.cjs pass; MdLinkMap and ToolsPane tests pass.

## md-scan-dead-refs — VERIFIED
- ambiguousRefs present in api.d.ts:2023 (MdDoc) and census; mdDocRefs tests (suffix, ambiguous, ignored, missing) pass.
- Real scan: root CLAUDE.md row deadRefs = [] (no suffix-resolvable file listed dead); ambiguousRefs = ["tasks"].

## md-duplicates-primitive — VERIFIED
- mdDuplicates.cjs exists in the skill's scripts/; scripts/__tests__/md-duplicates.test.cjs passes (in the 205).

## md-duplicates-wire — VERIFIED
- api.d.ts:1968 `duplicates?: MdDuplicatePair[]`; drift-check.cjs:26 ALL_CHECKS includes 'duplicates' (opt-in; header line 7/10), :398 emits findings.
- Real scan: network.duplicates has 28 pairs (top: src/seed/agents/demo-video-builder.md ↔ project-home-builder.md, 199 runs); 0 pairs touch session-manager-operations/reviews/.

## Combined diff review
Self-review (diff is large; /code-review not run as it is not for a read-only record): shared parser is dependency-free and in-package, no secrets, check-ignore invoked with args via execGit (no shell), no new path traversal surface seen.

## Findings
### Critical
- none
### Important
- none
### Minor
- Real-repo census: root CLAUDE.md has ambiguousRefs ["tasks"] — a bare folder token matching several paths; informational, not a defect of the scan.
- The `/code-review` and `/security-review` skills were not executed; self-review only.
