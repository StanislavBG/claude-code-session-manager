# Validation: md-network drift-check fix wave

Base: 30e50d2df9274ba7bb3caf7d597f36ece9603f1c. PRD files found in prds-archived (2744-2747). Commits: 46144edc (path precision), 46bb21c8 (map/imports), 06cd6a7b (refs), 129ab00d (doc + version).

## drift-check-path-precision — VERIFIED
- Gate `vitest run md-network-drift-check + dev-plugin-skillset`: 2 files, 19 tests passed, exit 0.
- Temp git repo (README with `origin/main`, `deep/real.js`, `[r](/pricing)`, `docs/missing.md`; tracked src/deep/real.js): default run findings = only missing-path docs/missing.md. `origin/main` silent, unanchored path silent, `/pricing` silent.
- Same repo with --strict-paths: broken-link /pricing, unanchored-path deep/real.js with matches [src/deep/real.js], missing-path docs/missing.md.

## drift-check-map-and-imports — VERIFIED
- Same gate, green.
- Temp repo, CLAUDE.md = `See @docs/map.md`, docs/map.md = marker + 250 lines: `map` = docs/map.md; findings: over-line-limit CLAUDE.md lines 1, expandedLines 252, limit 200; over-line-limit docs/map.md limit 70.
- Null-map note observed in output ("no md-network-map comment found; the 70-line map limit was not applied"), findings empty for it.

## md-network-refs-eval-gaps — VERIFIED
- Gate (drift-check links,limits,contents on audit/placement/plan): exit 0, findings [].
- audit.md:62-66 hand machine-share commands, says the script does not compute it; audit.md:112 git grep -F for deleted names; audit.md:124 duplicate-fact git grep -F; audit.md:133 worked count example (registerTool vs README list).
- placement.md:11 row for structure/listings/feature tours. plan.md:68 step 5 has cross-file-type git grep and recording flags.
- Grep for markdown links between audit/placement/plan/drift-check: none.

## drift-check-doc-and-version — VERIFIED
- Gate (vitest + drift-check on drift-check.md): exit 0, findings [].
- Script parseArgs flags: --root --map --checks --file --exclude --strict-paths. drift-check.md flags: same six (extra tokens --is-ancestor, --name-only are git flags in prose, not script flags).
- plugin.json:4 version 0.3.2; marketplace.json:17 plugin entry version 0.3.2 (marketplace.json:10 is the marketplace metadata version 0.1.0, a separate field).

## Real-path evidence (read-only, with the three --exclude flags)
| Repo | Run B (eval) | Now |
| --- | --- | --- |
| Bilko | broken-link 4, missing-path 71, no-contents-list 12 | broken-link 3, missing-path 17, no-contents-list 12; map null |
| family-frame | missing-path 7, over-line-limit 1, no-contents-list 7 | over-line-limit 1, no-contents-list 7 (missing-path 0) |
| session-manager | missing-path 288, no-contents-list 32 | missing-path 117, no-contents-list 32; map null |

Bilko's map: NOT found. Bilko CLAUDE.md line 1 is `@docs/map.md`, but no .md file in Bilko contains an `md-network-map` comment, so map null is correct (the import is followed; the marker is absent). session-manager also map null.

## Findings
- Critical: none.
- Important: none.
- Minor: session-manager still shows 117 missing-path; not triaged here (some may be true positives). Bilko lacks the map marker in docs/map.md, so the 70-line limit is not applied there.
- Self-review of the diff: no unsafe input handling, secrets, or path traversal seen; imports are constrained to inside --root per the PRD. /code-review and /security-review were not run as separate tools; self-reviewed.
