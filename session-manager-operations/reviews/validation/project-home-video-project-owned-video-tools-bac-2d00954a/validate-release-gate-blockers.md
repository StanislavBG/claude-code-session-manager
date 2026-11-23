# Validation: release gate blockers (base c9779c65)

## builder-per-gate-timeouts (PRD 3738, commit 0713012a) — VERIFIED
- AC1: build-target.json now has `"gateTimeoutSeconds": { "test:unit": 900 }`; typecheck has no entry (default 300) — `git show 0713012a`.
- AC2: SKILL.md step 3 and step 6 use `timeout <gateTimeoutSeconds[gate] or 300> npm run <gate>` and state the default is 300; the diff touches only those two spots.
- AC3: readers are `publish-preflight.cjs`, `lib/buildTarget.cjs`, and `buildTarget.test.cjs`. Neither reader file references `gateTimeoutSeconds`. `buildTarget.test.cjs` passes 4/4 against the file with the new key.
- Gate (node -e check): exit 0.

## load-gate-tick-test-deterministic (PRD 3739, commit b5f680cd) — VERIFIED
- AC1: loadavg, CPU, the gate clock (`now: FIXED_NOW` / `() => t`) and meminfo fixtures are injected, and launches go to an injected recorder via the new `_setSpawnJobForTests`. No real timer, `sleep` or `/proc` read remains in the test (grep).
- AC2: 6 `test(` cases before and after; alone it ran 6/6 in 2.16 s.
- AC3: the product change is minimal and named in the commit message. `dispatchSpawnJob` defaults to the real `spawnJob`; it adds the `_setSpawnJobForTests` export (scheduler.cjs ~2778, ~8904, ~13165).
- Gate `timeout 300 npx vitest run src/main/__tests__/scheduler-load-gate-tick.test.cjs`: exit 0, 6 passed.

## Findings
- Critical: none.
- Important: none.
- Minor: I did not re-run the full `test:unit` suite (460 s or more). The load-race fix is verified by determinism of inputs, not by a loaded run. `/code-review` and `/security-review` were replaced by self-review of the diff, which found no unsafe input, secrets or path handling; the test seam is test-only.
