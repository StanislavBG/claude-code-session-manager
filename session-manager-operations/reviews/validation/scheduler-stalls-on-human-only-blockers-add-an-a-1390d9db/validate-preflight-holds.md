# Validation: preflight holds plan (base c9779c65, HEAD 820d247e)

Gates re-run in the foreground, all green:
- Batch 1 (preflightCheck, src/main/lib/prd, ipcSchemas, mcpToolCatalog, repairPlanParkAutoResolve, needsHumanVerdict, starveRootBlocker, preflightHoldNotice, reviewNotice): 29 files / 251 tests pass.
- Batch 2 (preflightDispatchHold, scheduler-deferral-worktree-cleanup, preflightParkReroute, starveRootAndHoldNotice): 4 files / 19 tests pass.
- `npm run lint:docs`: ok (26 junctions, 50 files).

## preflight-check-primitive — VERIFIED
- `src/main/lib/scheduler/preflightCheck.cjs` exports normalizePreflight, preflightDelayMs (10/20/40/60 min ladder, attempt<1 → 1), runPreflight (reuses runIsolatedSequence, no shell, outputTail 500 chars), armPreflightHold. `scripts/lib-layout.json:119` registers it. Test file passes.

## preflight-prd-field — VERIFIED
- `prdCreate.cjs` normalizePreflightField wraps normalizePreflight, and the create and update paths emit `preflight:`. `prdFrontmatter.cjs` parses it back. `prdPreflightField.test.cjs` passes (round-trip, absent, multi-line refused).

## preflight-api-schemas — VERIFIED
- `ipcSchemas.cjs` and `mcpToolCatalog.cjs` gained `preflight`. `ipcSchemas-preflight.test.cjs` and `mcpToolCatalog-preflight.test.cjs` pass.

## repair-plan-park-auto-resolve — VERIFIED
- `reviewLadder.cjs:453` isFixPlanParkWithoutAutoFix, OR-ed into eligibility at `:479`, exported at `:1141`. The test uses slug `852-fix-ios-asc-profile` (test line 19, selected at line 52). Passes. needsHumanVerdict passes unchanged.

## starve-root-blocker-helper — VERIFIED
- `starvation.cjs` gained findRootBlocker and rootBlockersForProject. `starveRootBlocker.test.cjs` passes.

## preflight-hold-notice-builder — VERIFIED
- `reviewNotice.cjs` gained buildPreflightHoldNotice and preflightHoldNoticeKey. `preflightHoldNotice.test.cjs` passes (no '?', empty failText, key stability).

## preflight-dispatch-hold — VERIFIED
- `prdParser.cjs:156-158` parses frontmatter preflight for the reconcile copy. `scheduler.cjs:6924` computePreflightHolds feeds the picker skip, and `:3222` resetJobFields clears the hold. spawnJob runs runPreflightGate before the worktree and the 'running' transition (`:7095`), and the audit kinds preflight_hold and preflight_pass are present. `preflightDispatchHold.test.cjs` passes.
- Deviation (Minor): `dispatchLoop.cjs` is unchanged. The picker skip lives in scheduler.cjs computePreflightHolds, in the same shape as computeLaunchHolds. The behavior is covered by the tests.

## preflight-park-reroute — VERIFIED
- `scheduler.cjs:8205` reroutes via resetJobFields with source `scheduler:preflight-hold` and audits at `:8469`. `hasActivePreflightHold` (`reviewLadder.cjs:528`) blocks spawnInvestigation (`scheduler.cjs:6226` and `:6407`) and the dead-fix-plan reopen (`reviewLadder.cjs:519` and `scheduler.cjs:6553`). No NEEDS_HUMAN verdict or new job status in the diff. Tests pass, including needsHumanVerdict.

## wire-root-blocker-and-hold-notice — VERIFIED
- `scheduler.cjs:9381` rootBlockingFields is on both starve events (`:9410`, `:9443`). `knownWait` suppression is at `:9376`. The hold notice has a once-per-key sender (`:6978-7018`). `:12686-12707` adds heldReason and waitingOn to the list_prds output, with the MCP server `scripts/scheduler-mcp-server.cjs` touched. `starveRootAndHoldNotice.test.cjs` passes.

## doc-preflight-holds — VERIFIED
- `PRD_AUTHORING.md` v24 has a `preflight` section and a checklist line. `scheduler-operations.md` has §4b plus a rung-6 update. `develop/SKILL.md` has the PRECONDITION HOLD rule. Names match the code: preflightHold, `waiting on precondition:` heldReason, preflight_hold, preflight_pass, scheduler:preflight-hold, computePreflightHolds, runPreflightGate, starveRootFor. lint:docs passes.

## Findings
Critical: none.
Important: none.
Minor:
- `dispatchLoop.cjs` was listed in the dispatch-hold PRD's Files but not changed; the picker skip is in `scheduler.cjs:6924`. Functionally equivalent.
- The diff base..HEAD also includes unrelated release commits (manual 2.6.0, builder gate timeouts, load-gate test fix). They were not reviewed as plan work.

Review tooling: /code-review and /security-review were not run; I self-reviewed the new code. Checked: preflight runs without a shell, the command passes the gate validator (one line, at most 500 chars), the cwd is the project cwd, and no secrets or path handling were added.
