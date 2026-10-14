# Validation: needs-review reduction plan

Base: `6302bc945acb10d999621387fb752fabe2206293` (known; `git log base..HEAD` used per PRD paths).
Gates re-run in a scratch-TMPDIR worktree (node_modules symlinked temporarily, then removed; SM_CHAT_CONCURRENCY unset):
`vitest run` of all 12 gate test files → 12 files / 199 tests passed; `npm run typecheck` → exit 0; `npm run lint:docs` → ok.
`/code-review` and `/security-review` were not run as separate tools; the combined diff was self-reviewed (see Findings).

## baseline-gate-authority-primitive — VERIFIED
- `outputTail` (64 KiB ring) on every `runOneGateCommand` result incl. the `unavailable` path: definitionOfDone.cjs:761-817.
- `parseFailingTests` pytest/vitest/jest/tsc + null: baselineGate.cjs:34-76.
- `decideBaselineAuthority` complete-only-when conditions (kill switch, needs_review, sentinel_fail, landedCommit, four proofs, head red, base red, same step index, subset): baselineGate.cjs:95-125.
- Distinct reasons: kill-switch, verdict-not-eligible, no-landed-commit, base-green, different-failing-step, unparseable-output, new-failures (+ proof reasons); `preexisting` returned on success.
- Test file baselineGate.test.cjs present; passes with runVerify.test.cjs; typecheck green.

## worktree-dependency-dirs-provision — VERIFIED
- `linkDependencyDirs`, `DEFAULT_DEP_DIRS = ['node_modules','.venv','venv']`, returns `{linked, skipped}`, never throws: worktreeDeps.cjs:53-77.
- `check-ignore` gate on name: worktreeDeps.cjs:28-33,66. Existing dest left alone: line 66.
- `/<name>` appended to `<git-common-dir>/info/exclude` only if absent: worktreeDeps.cjs:36-47.
- `createWorktree` calls it after add, try/catch, kill switch `SM_WORKTREE_DEP_LINK_DISABLE`: gitWorktree.cjs:897-903.
- worktreeDeps.test.cjs passes.

## baseline-gate-authority-wire — VERIFIED
- Selector widened (sentinel_fail + landedCommit + guardHeadBefore, kill switch): reviewLadder.cjs `baselineEligible` / `selectGateShadowTarget`.
- `runGateShadow` (scheduler.cjs ~8819-8864): detached scratch worktree under `os.tmpdir()` at `guardHeadBefore`, `linkDependencyDirs`, `runGateSequence` sequentially after HEAD run, memoized by `gateShadow.baseline.head`.
- Scratch cleanup on every path: the `finally` block runs `git worktree remove --force` (when added), then `fs.rmSync(scratch,{recursive,force})` unconditionally (covers a failed/partial add), then `git worktree prune`. Verified by reading; each step is individually try/caught so a failure cannot skip the next.
- Completion: `transitionJob(..., source 'gateAuthority:baseline')`, `verifierVerdict='pass_preexisting_gate_red'`, `preexistingGateFailures`; refusal stores decision on `gateShadow.baseline` only.
- `classifyLadderRung` maps `gateAuthority:baseline` → `reverify`: needsReviewLedger.cjs:63.
- baselineGateWiring.test.cjs, gateAuthority and needsReviewLedger tests pass.

## needs-human-verdict — VERIFIED
- `buildFinishTail` lists NEEDS_HUMAN with the use-only-when rule: scheduler.cjs ~352-363.
- `scanSentinel` regex + `scanHumanQuestion` (trim, 300 cap) + `needs_human` branch → outcome needs_review with `humanQuestion`: runVerify.cjs.
- Park path stamps/clears `humanQuestion`; `resetJobFields` deletes it: scheduler.cjs.
- `isNeedsHuman` excluded in selectResumeRecoveryTarget, selectMechanicalRecoveryTarget, selectExhaustedNeedsReviewTargets, selectAutoFixTargets. `isEligibleForImmediateAutoFix`: no direct guard, but it delegates (verified by needsHumanVerdict.test.cjs, which passes, covering each selector).

## review-notice-self-contained — VERIFIED
- `buildReviewNotice` stores title, goalLine (first sentence, ≤200), reason (≤300; humanQuestion for needs_human), blockingPaths: reviewNotice.cjs.
- `selectDueReviewNotices`: needs_human due immediately.
- `formatReviewNotice` renders slug — title / Goal / Why it stopped / Answer needed with the three variants; `HUMAN_CAUSE` gained the six entries.
- reviewNotice.test.cjs + reviewNoticeWiring.test.cjs pass.

## review-notice-delivery-any-epic-status — VERIFIED
- `allowInactive === true` skips only `not-active`: promptSessionEvents.cjs:87. Other refusals unchanged.
- Only `flushDueReviewNotices` passes it: scheduler.cjs (one call site added).
- `notifyOriginatingTab` text for `pass_preexisting_gate_red` includes "completed; the gate was already red before this PRD", ≤10 ids, "(+N more)".
- reviewNoticeDelivery.test.cjs passes.

## develop-gate-baseline-authoring-rule — VERIFIED
- SKILL.md gate rules 10 and 11 (each with `Why:`), Phase 2 needs_human relay line; PRD_AUTHORING.md §15 two checkbox lines. `lint:docs` ok.

## scheduler-ops-doc-needs-review-reduction — VERIFIED
- §2 `linkDependencyDirs` bullet, §4 baseline extension + `needs_human` paragraphs, §7 table row, §8 notice paragraph all present.
- Doc matches code: reasons in the §7 row (`baseline-identical`, `new-failures`, `different-failing-step`, `base-green`, `unparseable-output`, `base-unavailable`, `kill-switch`) all exist in baselineGate.cjs; `isNeedsHuman` / `selectDueReviewNotices` / `allowInactive` names match.

## Findings

### Critical
- none

### Important
- scheduler.cjs (`runGateShadow`, `gateShadow = { ...outcome, ... }` and `gateShadow.baseline = { outcome: baseOutcome }`): each gate step's new `outputTail` (up to 64 KiB) is persisted into `queue.json` for the HEAD run and again for the base run, so one sentinel_fail row can add ~hundreds of KiB to a file rewritten on every mutate. Suggest trimming `results[*].outputTail` once the decision is made (keep only the parsed ids).

### Minor
- scheduler.cjs `runGateShadow`: a base run that ends `unavailable` (busy / worktree-add error) is memoized per HEAD and never retried for that HEAD; the doc tells the human to re-run by hand.
- reviewLadder.cjs `isEligibleForImmediateAutoFix` has no direct `isNeedsHuman` guard; it is safe only through its delegation to `selectAutoFixTargets`.
- A stray 0-byte `<path>` file exists in the tree (sqlite MCP placeholder, known; not from this plan).
- Plan PRD `1971-validate-macro-inputs` and macro commits share the base..HEAD range; out of scope here.
