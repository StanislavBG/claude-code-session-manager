# Validation: md-history-declared-once (PRD 3731)

Base: 7fd486a8. Commit in range: f9505f82 (touches exactly the 3 PRD files).

## md-history-declared-once — VERIFIED

- `.session-manager.json:1-10`: only `mdNetwork.history` with the 4 required folders, nothing else.
- `scripts/check-doc-hierarchy.cjs:37-60`: `readHistoryPrefixes()` reads that file; missing, unreadable, invalid JSON or non-string-array history → one `doc-hierarchy: FAIL .session-manager.json: …` line, exit 1. Seeded / tool-loaded / github entries remain; the 3 historical + `web/promo-video/` entries were removed from the literal list, so the effective set is unchanged.
- `scripts/__tests__/check-doc-hierarchy.test.cjs`: +34 lines cover history read from a scratch file, missing file, invalid JSON / non-list.
- Gate 1 `npx vitest run scripts/__tests__/check-doc-hierarchy.test.cjs src/main/lib/__tests__/mdNetworkScan.test.cjs`: 2 files, 47/47 passed.
- Gate 2 `npm run lint:docs`: `doc-hierarchy: ok (26 junctions, 50 files linted)`.
- Read-only `scanMdNetwork($SM_PROJECT_ROOT)`: `findings []`; on this worktree: see below (also run).
- `src/main/lib/mdNetworkScan.cjs` untouched, as the PRD required.

## Review
`/code-review` and `/security-review` self-reviewed on the diff: the config path is a fixed constant under ROOT (no traversal); JSON parse errors are handled; no secrets; no duplicated helper.

## Findings
- Critical: none.
- Important: none.
- Minor: none. (Note: the lint is stricter than the scan on an absent `mdNetwork` — lint fails, scan treats it as no prefixes; deliberate and documented by the implementer.)
