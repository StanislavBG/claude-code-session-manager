# Validation: Project Home never blank

Base: 08597cfd. Commits: 972fc621 (2786), 5a481052 (2787), 9c55a014 (2788). Gates re-run with SM_* unset; all exit 0.
Full `npm run test:unit`: 935 files passed, 8671 tests passed, 1 skipped, 0 red.

## derive-cwds-reads-drop-roots-once — VERIFIED
- activeSessions.cjs:451-453 reads `prefixDropRoots`/`exactDropCwds` once into locals above `addCwd`; used at :477-478. TMP_DROP_ROOTS and its getter are unchanged (diff touches only deriveCwds).
- Filtering rules unchanged (diff is 8 lines, locals only).
- activeSessions-drop-roots-once.test.cjs covers the counting getter, nested drop, exact drop and kept dir. Gate (that file plus single-scan): 8 tests passed. Typecheck and lint green.

## prompt-sessions-registered-roots-cache — VERIFIED
- promptSessionsIpc.cjs:44-66 `makeRegisteredRootsCache(source,{ttlMs=10000,missRefreshMs=1000,now})` builds a Set of norm(r) and norm(projectRootOf(r)||r). It rebuilds on TTL expiry, and on a miss at most once per missRefreshMs.
- :72-80 `assertRegistered` uses the default cache only when `projectRoots === defaultProjectRoots`. An injected function keeps the uncached loop. The absolute-path validation is unchanged. The cache throws the same 'cwd is not a registered project root'.
- The cache holds only roots from source(), never caller strings. A removed root stays accepted for at most ttlMs.
- Exports at :169. Gate (promptSessionsIpc.test plus roots-cache.test): 10 tests passed, including the refusal test.

## project-home-loading-and-error-states — VERIFIED
- ProjectPagesSection.tsx: the `if (!loaded) return null` is removed. The body is a total switch: error, then loading (`project-home-loading`, 'Loading pages…'), then empty, then grid, so no branch renders nothing. The page MacroButton is gated on `loaded && !failed` (:418). The error branch has `project-home-load-error` and `project-home-retry`.
- useProjectPagesOutput.ts: `error` and `reload` are added. A rejected get sets error and loaded and keeps the toast. The `cancelled` guard blocks stale cwd responses. onChanged clears error.
- ProjectHome.tsx:34,53-54 passes error and `onRetry={reload}`.
- Tests added in ProjectPagesSection.test.tsx and useProjectPagesOutput.test.ts. Gate: 39 tests passed. Typecheck and lint green.

## Findings
### Critical
- none
### Important
- none
### Minor
- useProjectPagesOutput.ts: when `cwd` is null the effect returns early and `loaded` stays false, so the section shows "Loading pages…" indefinitely. In practice ProjectHome only mounts with a tab cwd, so this is low risk.
- 2789 PRD tree check: the three PRD files were found in prds-archived/, so no missing-file finding.
- Self-review of the diff found no secrets, path traversal or injection issues. The cache is a fence-hardening change and keeps refusal for never-registered cwds.
