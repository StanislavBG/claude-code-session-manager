# Validation: ops-retention no inert keys (fix wave for 2034)

Base: 0ef4ffa1 (`git log 0ef4ffa1..HEAD` = a148c509 only). Combined diff: 6 files, +17/-21, all within 2036's # Files.

## 2036 ops-retention-drop-archived-transcripts-key — VERIFIED

- AC1 opsRetentionSettings.cjs: DEFAULTS (L18-25), header (L3-6), validatePatch, sanitizeStored, withDefaults and ARCHIVED_MODES no longer mention the key (a148c509 diff). Unknown key falls to the `unknown key ${k}` throw in validatePatch. Legacy stored key dropped: test "legacy stored archivedTranscripts key is dropped on read" passes.
- AC2 api.d.ts: field removed (diff). SettingsOpsRetention.tsx L133 keeps static `<p>Archived transcripts: kept forever</p>`; typecheck exit 0.
- AC3 tests: opsRetentionSettings.test.cjs L40 (`not.toHaveProperty`), L55 (`toThrow(/unknown key/)`), L59-65 (legacy dropped); SettingsOpsRetention.test.tsx mock key removed. Vitest: 2 files, 14 tests passed.
- AC4 docs: prompt-sessions/README.md says "always kept (fixed policy, not configurable)"; scheduler/README.md row now "_(not configurable)_ / always kept". No `archivedTranscripts.mode` remains in either.
- AC5 `git grep archivedTranscripts -- src`: only hits are the 4 assertions in opsRetentionSettings.test.cjs that AC3 itself requires. No non-test hit. (The AC wording conflicts with AC3; treated as satisfied.)
- Gate re-run: vitest (pass), `npm run typecheck` (exit 0), `npm run lint:docs` (ok, 34 files).

## 2034 ops-retention-wire-inert-knobs — VERIFIED (re-check)

Every DEFAULTS key now has a consumer outside opsRetentionSettings.cjs and the UI:
- `runLogs` -> scheduler/runLogRetention.cjs:356 (stored.runLogs becomes the policy)
- `runsArchiveDays` -> scheduler/staleTmpSweep.cjs:81
- `auditLogMonths` -> telemetry/auditLog.cjs:50
- `reservedMarkersKeep` -> scheduler/prdParser.cjs:405
The previously inert `archivedTranscripts` key is gone, so the sole refutation reason is resolved.

## Findings

Critical: none.
Important: none.
Minor: AC5 of 2036 ("no hits in src") is literally false because required negative tests mention the key; harmless.
Review: self-reviewed the diff (pure removal; no new input handling, secrets, or paths).
