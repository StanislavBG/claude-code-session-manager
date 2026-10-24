# Validation: create-prd latency / retry plan

Base: f209df220b0edb02a87733b1a4855970d3cbc2b4. Commits: ee14808c (2191), 5c2211e0 (2192), 7bd50e88 (2193), a2100b50 (2194). SM_* env unset before gates. All four PRD files found in `prds-archived/`.

## list-prds-cwd-scoped-scan — VERIFIED
- `listPrdsInternal({ cwd } = {})` scoped to prdsRoot + prdDirForCwd + listEpicPrdDirs (live) and listArchivedPrdDirs (archived), de-duplicated: scheduler.cjs:10361, 10413-10428.
- No cwd falls back to candidatePrdsDirs()/candidateArchivedPrdsDirs(); folding/sort code untouched (diff touches only the dir lists).
- `remote.listPrds` passes `{ cwd: filter.cwd }` (scheduler.cjs:10670); post-filter/paging unchanged. IPC and webRemote callers still use the unscoped form.
- New test listPrdsCwdScoped.test.cjs covers A/B isolation, readdir spy, and no-cwd.
- Gate re-run: `vitest run listPrdsCwdScoped` → 2 passed.

## mcp-admin-busy-not-down — VERIFIED
- ECONNREFUSED → NOT_RUNNING_ERROR; any other fetch rejection → `busyError(code)` (scheduler-mcp-server.cjs:127-130), text starts as specified and advises list-with-no-filter or same slug, never a new slug (:83-91). Non-JSON body → "admin API answered HTTP <status> with a non-JSON body" (:131-135). Missing/invalid admin-api.json path untouched.
- Catalog: hand-authoring fallback removed; not-running vs did-not-answer guidance and recipe now lists gate/files, no estimateMinutes (mcpToolCatalog.cjs:113-117, :401).
- Gate re-run (4 files): 4 passed, 103 tests.

## create-prd-same-slug-retry — VERIFIED
- Same title → `{ok:true, alreadyExisted:true, nn, filename, prdPath, epicId, enqueued, note, warnings:[]}` returned before allocateParallelGroup/writePrd (prdCreate.cjs:~484-505). Different title still reaches the unchanged 409.
- In-flight Set keyed sourcePromptId+slug, 409 text as specified, cleared in `finally` of the createPrd wrapper (:228-238, :465-474).
- Admin route spreads `alreadyExisted: true` only when set (:767).
- SKILL.md Preflight line (c) added (SKILL.md:72).
- Gate re-run (DuplicateSlug, prdCreate, prdCreateAdoption): 3 files, 60 passed.

## create-prd-estimate-optional-test — VERIFIED
- New createPrdEstimateOptional.test.cjs (56 lines) covers schema optional/0/2.5/20, buildPrdBody no estimateMinutes line, 45-min floor.
- Gate re-run (with ipcSchemas-dependsOn): 2 files, 7 passed.

## Combined-diff review
Texts agree: busyError and the catalog both say "check with scheduler_list_prds (no status filter) or retry the same slug"; prdCreate returns the existing PRD with alreadyExisted:true for the same slug+title, and the SKILL.md line says the same. The cwd-scoped scan is used by remote.listPrds, which the create path relies on, with unchanged post-filter semantics. No secrets, no new path-traversal surface (dup filename comes from readdir of the Epic's own dir).

## Findings
- Critical: none.
- Important: none.
- Minor: prdCreate.cjs dedupe is in-process only (module-level Set); fine for a single app process. The in-flight key is registered before the dup scan, so the slug is held for the whole create — intended.
- Minor: mcpToolCatalog.test.cjs was listed in the 2192 Files but unchanged; it passes, so no pin to the old sentence existed.
- Minor: SKILL.md labels the new bullet "(c)" placed between (a) and (b); cosmetic ordering.
