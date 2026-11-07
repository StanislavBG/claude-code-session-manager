# Validation: md-network final fixes (Base 110d6945)

Commits: c448ed12 (2766), 85bc058d/a6fd0e09 (2765), f3f6e94f/9f140811 (2767), 54a19e91 (2768).

## shipped-seed-manifest-validator-demo-video — VERIFIED
- Gate: seedAgentPersonas + agentModelResolve: 2 files, 65 tests passed.
- `git diff 110d6945..HEAD -- src/seed`: only `seedVersion: 9→10` (validator.md) and `4→5` (demo-video-builder.md); no body text change.
- shippedPersonaSeeds.cjs gained 22 lines (the two manifest entries).

## retire-font-data-and-web-project-pages-mentions — VERIFIED
- Gate: drift-check links,paths on both files → findings [], counts {}; `npm run lint:docs` ok (21 junctions, 35 files).
- project-partition.md:51 and :74 call generate-font-data.mjs / fontData.ts retired, "removed in 536d7ed4, no replacement".
- `git ls-files | grep -Ei 'generate-font-data|fontData'` → empty.

## drift-check-gitignored-link-targets — VERIFIED
- Gate: md-network-drift-check + dev-plugin-skillset: 25 tests passed.
- Temp repo: a.md links to a gitignored missing `ignored.md` and a missing `tracked-missing.md`; the check emitted exactly one broken-link, for tracked-missing.md (line 2). The ignored target was silent.

## drift-check-ignored-links-doc-and-version — VERIFIED
- Gate: both test files pass; drift-check on drift-check.md (links,limits,contents) → findings [], counts {}.
- plugin.json:4 version 0.3.5; marketplace.json:17 plugin entry version 0.3.5 (line 10 "0.1.0" is the marketplace metadata version, not the plugin entry).

## Contract evidence
Full `npx vitest run` with SM_* unset: 5 files failed / 925 passed (11 tests failed, 8613 passed). Failing files: page-surface, apiSurface, TelemetryNotice, remoteApi, zLayers. All are on the allowed pre-existing list. No other file failed.

## Real-path evidence
Command: drift-check --root . with the three excludes (reviews, design-mocks, content/blog). Full counts: `{"no-contents-list": 32}`. missing-path 0, broken-link 0 (neither kind appears).

## Findings
- Critical: none.
- Important: none.
- Minor: 32 no-contents-list findings on long docs (e.g. tests/README.md, web/promo-video/script/API.md). They are outside this plan's scope.
