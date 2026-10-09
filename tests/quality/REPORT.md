# Test quality baseline

- Base commit: eec9b6144ba63180260e25baba6aee208168fd5d
- Date: 2026-10-09
- nproc: 14
- coverage-map wall time: ~1900 s (657 s + 318 + 254 + 254 + 263 + 154 s, six runs)
- Unmeasured files: 8 of 686 (1.2%)
- Method note: `coverage-map.cjs --all` only enumerated 210 files (list-pure-tests.cjs glob matcher needs >=1 directory under `**`, so tests/unit/*.spec.ts and src/main/__tests__/*.test.cjs are skipped). The other 454 files from `vitest list --filesOnly` were mapped by passing explicit paths in 5 batches, then the maps were merged before report.cjs ran. Fix the matcher in a follow-up.

## Unmeasured files

| file | reason |
| --- | --- |
| scripts/__tests__/check-doc-hierarchy.test.cjs | failed (92 s) |
| scripts/__tests__/ops-sweep-claude-md-fallback.test.cjs | timeout (120 s cap) (120 s) |
| scripts/__tests__/package-files.test.cjs | timeout (120 s cap) (120 s) |
| scripts/test-quality/__tests__/smells.test.cjs | failed (31 s) |
| src/main/lib/__tests__/agentPersonaSchema.test.cjs | timeout (120 s cap) (120 s) |
| src/main/lib/__tests__/appRuntime.test.cjs | timeout (120 s cap) (120 s) |
| src/main/lib/__tests__/buildIdentity.test.cjs | failed (116 s) |
| src/main/lib/__tests__/schedulerMcpServerGateFiles.test.cjs | failed (17 s) |

# Test quality report

Totals: files=686 tests=6043 loc=111732 | keep=417 review=62 merge=119 bloat=80 unmeasured=8 | bloat+merge: loc=22298 duration=3685.4s

Map HEAD: eec9b6144ba63180260e25baba6aee208168fd5d

## Top 40 bloat files by LOC

| file | loc | duration ms | reasons |
| --- | ---: | ---: | --- |
| src/renderer/lib/__tests__/navGroupsHome.test.ts | 329 | 25743 | zero-unique-coverage |
| src/main/__tests__/scheduler-commit-guard-noop.test.cjs | 244 | 16580 | zero-unique-coverage |
| src/main/__tests__/scheduler-needs-review-autoresolve.test.cjs | 219 | 18006 | zero-unique-coverage |
| src/main/__tests__/prdLocations.test.cjs | 195 | 18403 | zero-unique-coverage |
| scripts/__tests__/audit-ops-hygiene-pattern-f.test.cjs | 165 | 16639 | zero-unique-coverage |
| src/renderer/components/__tests__/ChatTranscriptTurn.turn-memo.test.tsx | 157 | 23099 | zero-unique-coverage |
| src/main/__tests__/scheduler-archived-twin-guard.test.cjs | 152 | 17601 | zero-unique-coverage |
| src/main/__tests__/scheduler-no-dead-end-status.test.cjs | 152 | 18026 | zero-unique-coverage |
| src/main/__tests__/queue-starvation-per-project.test.cjs | 147 | 16677 | zero-unique-coverage |
| src/main/__tests__/chat-exit-close-race.test.cjs | 146 | 17443 | zero-unique-coverage |
| scripts/__tests__/audit-ops-hygiene-pattern-e.test.cjs | 137 | 20508 | zero-unique-coverage |
| src/main/__tests__/prdFrontmatterDependsOn.test.cjs | 136 | 16242 | zero-unique-coverage |
| src/renderer/components/tabs/__tests__/Plugins.configWatch.test.tsx | 135 | 22579 | zero-unique-coverage |
| src/main/__tests__/seedValidatorPersona.test.cjs | 133 | 16362 | zero-unique-coverage |
| src/main/lib/__tests__/schedulerBatchProjectCap.test.cjs | 127 | 16527 | zero-unique-coverage |
| src/main/__tests__/chatRunner-epic-worktree-execcwd.test.cjs | 125 | 17229 | zero-unique-coverage |
| src/renderer/components/tabs/__tests__/Plugins.description.test.ts | 124 | 20755 | zero-unique-coverage |
| src/main/__tests__/broadcastCoalescer.test.cjs | 122 | 17136 | zero-unique-coverage |
| src/main/__tests__/exchanges.test.cjs | 122 | 17685 | zero-unique-coverage |
| src/main/__tests__/scheduler-reset-job-fields-guard.test.cjs | 122 | 17730 | zero-unique-coverage |
| src/main/__tests__/scheduler-worktree-exec-cwd.test.cjs | 120 | 18924 | zero-unique-coverage |
| src/main/__tests__/reconcileFlatPrdSweep.test.cjs | 119 | 17155 | zero-unique-coverage |
| src/main/__tests__/scheduler-fix-plan-path.test.cjs | 119 | 17689 | zero-unique-coverage |
| src/main/__tests__/configRealResolve.test.cjs | 118 | 17648 | zero-unique-coverage |
| src/main/__tests__/prdSourcePromptIdBackfill.test.cjs | 118 | 17866 | zero-unique-coverage |
| src/main/lib/__tests__/mcpToolCatalog.test.cjs | 117 | 17344 | zero-unique-coverage |
| src/main/__tests__/epicStatusMirror.test.cjs | 110 | 18165 | zero-unique-coverage |
| src/main/__tests__/scheduler-bash-timeout-env.test.cjs | 104 | 17983 | zero-unique-coverage |
| src/main/__tests__/scheduler-archive-completed-prd.test.cjs | 99 | 17910 | zero-unique-coverage |
| src/main/lib/__tests__/telemetryCountersMetadataColumn.test.cjs | 98 | 17234 | zero-unique-coverage |
| scripts/test-quality/__tests__/coverage-guard.test.cjs | 97 | 60218 | zero-unique-coverage |
| web/manual/__tests__/figure-captures.test.cjs | 97 | 13198 | zero-unique-coverage |
| src/renderer/lib/__tests__/uiSettingsPrefs.test.ts | 95 | 16314 | zero-unique-coverage |
| src/main/__tests__/scheduler-utilization-hold.test.cjs | 89 | 17457 | zero-unique-coverage |
| src/main/__tests__/workTypeLibrary.test.cjs | 88 | 17661 | zero-unique-coverage |
| scripts/__tests__/check-epic-transcripts.test.cjs | 84 | 14929 | zero-unique-coverage |
| scripts/package/__tests__/release-workflow.test.cjs | 81 | 18565 | zero-unique-coverage |
| src/main/__tests__/scheduler-supervisor-record.test.cjs | 81 | 18122 | zero-unique-coverage |
| src/renderer/components/tabs/scheduler/__tests__/trackerStepParity.test.tsx | 81 | 20285 | zero-unique-coverage |
| src/main/lib/__tests__/gitWorktreeIntegrateSha.test.cjs | 79 | 16703 | zero-unique-coverage |

## Top 20 consolidate clusters

| src | test files | merge/bloat |
| --- | ---: | ---: |
| src/main/lib/schedulerPaths.cjs | 334 | 106 |
| src/main/lib/opsOwnership.cjs | 301 | 98 |
| src/main/lib/cwdClassify.cjs | 298 | 96 |
| src/main/lib/atomicFs.cjs | 304 | 93 |
| src/main/lib/ephemeralCwd.cjs | 281 | 91 |
| src/main/lib/gitExec.cjs | 267 | 85 |
| src/main/lib/expandHome.cjs | 262 | 85 |
| src/main/lib/personaImportHealth.cjs | 262 | 85 |
| src/main/lib/importReferences.cjs | 261 | 85 |
| src/main/config.cjs | 260 | 85 |
| src/main/lib/opsErrorLog.cjs | 260 | 85 |
| src/main/lib/sendToRenderer.cjs | 260 | 85 |
| src/main/logs.cjs | 260 | 85 |
| src/main/lib/gitWorktree.cjs | 266 | 84 |
| src/main/lib/workTypeLibrary.cjs | 260 | 84 |
| src/main/lib/activeSessions.cjs | 256 | 80 |
| src/main/lib/auditLog.cjs | 249 | 78 |
| src/main/lib/prdFrontmatter.cjs | 225 | 75 |
| src/main/lib/prdLocations.cjs | 241 | 74 |
| src/main/lib/telemetryCounters.cjs | 231 | 72 |

## Smell counts

- micro-file: 11
- mock-only: 77
- no-assert: 5
- prd-named: 2
- source-text: 8
