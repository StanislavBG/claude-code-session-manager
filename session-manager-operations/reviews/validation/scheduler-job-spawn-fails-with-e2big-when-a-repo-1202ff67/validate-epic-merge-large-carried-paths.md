# Validation: epic-merge-accepts-large-carried-paths

Base: 604bae39 (commit 82d30c0d touches exactly the two PRD files; 2 files, +38/-1).

## epic-merge-accepts-large-carried-paths — VERIFIED

- AC1: `src/main/ipcSchemas.cjs:258` is `z.array(z.string().min(1).max(4096)).max(100000).optional()`; comment at lines 255-257 gives the reason (uncapped carried diff, 3,306 paths on 2026-10-26).
- AC2: `src/main/__tests__/ipcSchemas-merge-carried-paths.test.cjs` covers 5,000 paths accepted, no carriedPaths accepted, empty-string path rejected, non-`sm-epic/` branch rejected.
- AC3: gate run with SM_* env unset: `npx vitest run` on the new test + ipcSchemas-dependsOn + ipcSchemasFirePolicy → 3 files, 9 tests passed.
- Gate re-run: green.

## Findings

- Critical: none.
- Important: none.
- Minor: the new test's `base.dir`/`cwd` are fake paths; fine for schema-only testing. Diff is tiny; no security concern (bound is still finite, per-path length capped).
