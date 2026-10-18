# Validation: ops-retention knobs fix wave (PRD 2034)

Base: 7d237eecb636cb8a82fa67c8b1d668efdc8a46de (HEAD 0ff44973). One commit in range: `0ff44973` touching auditLog.cjs, prdParser.cjs and the new test file (exactly the PRD's `# Files`).
Gate re-run (foreground, scratch TMPDIR): `vitest run` over the 4 gate files = 4 files / 23 tests passed. `/code-review` and `/security-review` not run as tools; diff self-reviewed.

## 2034 ops-retention-wire-inert-knobs — REFUTED (narrow: extra consumer check fails for one key)

PRD acceptance criteria — all met:
- auditLog.cjs: `maxRolled()` (L48-53) reads `opsRetentionSettings.read().auditLogMonths`, falls back to 6 on throw or non-finite/<1; used in rotation prune (L72). `MAX_ROLLED` constant removed.
- prdParser.cjs L403-410: `keep` defaults 100, set from `read().reservedMarkersKeep` (try/catch), passed as `pruneStaleReservations(prdsDir, { keep })`; still inside the outer try/catch, so allocation never fails on it.
- Hot path: no cache module added; one `read()` per rotation / per allocation; lazy `require` avoids a cycle. Rotation is monthly, so negligible.
- opsRetentionKnobsWired.test.cjs: auditLogMonths:2 → 2 rolled files; reservedMarkersKeep:10 → 10–11 markers (one fresh marker is never pruned, assertion accounts for it); corrupt file → 6 rolled / 31 markers. All pass.

Additional check — every `DEFAULTS` key has a consumer outside opsRetentionSettings.cjs and the UI (grep of src, excluding tests):
- runLogs.maxAgeDays / keepPerSlug → runLogRetention.cjs L353-356 (`readStored().runLogs`) — OK
- runsArchiveDays → staleTmpSweep.cjs L77-81 — OK
- auditLogMonths → auditLog.cjs L50 — OK (this fix)
- reservedMarkersKeep → prdParser.cjs L405 — OK (this fix)
- **archivedTranscripts → NO consumer.** Only hits are opsRetentionSettings.cjs and the type in src/preload/api.d.ts:9. The UI (SettingsOpsRetention.tsx) does not reference it either. Its sole allowed value is `mode: 'forever'` (= keep everything), so behavior is correct today, but the key is inert and the criterion is not met literally.

## Findings

### Critical
- none

### Important
- none

### Minor
- src/main/lib/opsRetentionSettings.cjs:25 — `archivedTranscripts` is persisted and validated but read by nothing; either wire it when a non-`forever` mode exists (the 2024 sidecar primitive is the likely consumer) or note it as a reserved key in the module header.
- src/main/lib/telemetry/auditLog.cjs:50 / src/main/scheduler/prdParser.cjs:405 — the fallback constants (6, 100) duplicate `DEFAULTS` rather than reading them; acceptable (the fallback exists for when the module itself can't load) but they can drift.
- src/main/lib/opsRetentionSettings.cjs BOUNDS — `reservedMarkersKeep` min is 1 while prdParser accepts `k >= 0`; harmless, the bound wins on any stored value.
