# Validation: epic-get-by-id-alone, contract-additive-version-rule

Base: a290af28. Commits: 2c364c1b (epic-get-by-id-alone), d5d79546 (contract-additive-version-rule). Other commits in the range were not attributed.
Gates re-run: vitest (epicOutsideRead, epicAdminRoutes-id-only, externalContract.shape) 37/37 pass; `npm run typecheck` ok; `npm run lint:docs` ok.

## epic-get-by-id-alone — VERIFIED
- ipcSchemas.cjs:638-658: cwd optional; refine "externalRef requires cwd" added; id-xor-externalRef refine untouched.
- epicOutsideRead.cjs `findEpicProject`: returns {cwd} / {ambiguous} / null, whole body in try/catch (never throws).
- Unsafe-id refusal first: `if (!isSafeEpicId(epicId)) return null;` is the first statement, before `registeredRoots` or any path join.
- Only registered roots: roots come from `registeredRoots(projectRoots)` (default `defaultProjectRoots`, TTL-cached); no allProjectCwds/activeProjectCwds. Reads only `readActiveIndex(root)` and `archivedEntry(root, ...)` (prompt-sessions).
- epicAdminRoutes.cjs: parseQuery skips projectProblem only when cwd absent and id given; 409 `ambiguous epic id` + cwds, 404 `not found`, found cwd feeds getEpicRecord; cwd-given path unchanged.
- Tests present: epicOutsideRead.test.cjs (+57 lines) and new epicAdminRoutes-id-only.test.cjs; pass.
- Contract fingerprint unchanged; shape test passes unedited by this commit (it was edited only by the sibling PRD).

## contract-additive-version-rule — VERIFIED
- externalContract.cjs:17 `CONTRACT_VERSION = 1`; line 125-128 `1: Object.freeze(['5a56abbb…04101'])`; comment states the additive-append / breaking-bump rule.
- Shape test compares contractFingerprint() with last array entry; failure message names additive (append) and breaking (bump); passes.
- Only readers of CONTRACT_FINGERPRINTS in src/main and scripts are the module itself and the test; health reports CONTRACT_VERSION (1).
- external-contract.md: version rule records a new fingerprint under the same version; GET /admin/epic row says cwd optional with id; bullet documents 404 and 409 ambiguous and that externalRef needs cwd.
- lint:docs passes.

## Findings
- Critical: none. Important: none.
- Minor: external-contract.md (GET /admin/epic table row, Answer column) lists only 404, not the 409; the 409 is in the bullet below. Also, `CONTRACT_FINGERPRINTS[1]` still holds one entry, as the PRD's route change left the manifest unchanged, so the append path is untested by a real additive change.
- Review tools: self-reviewed diff (no unsafe input handling, secrets, or path traversal found; id validated before use).
