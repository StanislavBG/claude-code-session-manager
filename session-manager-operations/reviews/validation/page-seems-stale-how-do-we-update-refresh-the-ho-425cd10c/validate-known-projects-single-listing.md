# Validation: known-projects-resolve-from-scan-listing (PRD 3690)

Base: d58913ddee662e64f88eb537677da98f9a6f4b5c. Commit: 29d9d4dd (touches only the two PRD files).

## known-projects-resolve-from-scan-listing — VERIFIED

- AC1: `useKnownProjects.ts:231` scan-local `jsonlByEncoded`; filled at :240 only after an actual `listDir` (cache-reuse branch returns at :236 with no entry); passed to `runEnrichment` at :292.
- AC2: stage 1 at :341-342 uses `resolveCwdFromJsonl(listedJsonl)` when an entry exists, else `resolveProjectCwd(row.path)`. Cache and unresolved-signature checks (:336-339) unchanged. `maxBytes: CWD_RESOLVE_MAX_BYTES` at :55.
- AC3: `resolveProjectCwd` still exported (:70), lists then delegates to the shared `resolveCwdFromJsonl` (:52); the parse rule exists once. Still used at :481.
- AC4: test.ts:170-181 — 3 folders, `listDir` called exactly 3+1 times, targets asserted, all cwds resolved. The existing failed-resolution test was rewritten to inject the failure at `readText` (the listing no longer happens twice); its intent is preserved.

Gate re-run: useKnownProjects/resolveProjectCwd/knownProjectAggregate vitest 46 passed; 5 component suites 147 passed; typecheck OK; lint:selectors OK; lint:any OK.

## Combined diff review
Two files only, +44/-17. No path handling, secrets, or input risks introduced; no duplicated helper. `/code-review` and `/security-review` were not run separately; self-reviewed.

## Findings
- Critical: none
- Important: none
- Minor: none
