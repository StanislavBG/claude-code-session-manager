# Mutation sample

- Base commit: eec9b6144ba63180260e25baba6aee208168fd5d
- Date: 2026-10-09
- nproc: 14
- Total wall time: ~510s (atomicFs 58s, epicMint 315s, opsOwnership 137s; sequential)
- Command: `node scripts/test-quality/mutants.cjs <src> --max 20 --seed 1`
- Raw data: `mutation-sample.json`

## src/main/lib/atomicFs.cjs

Mutants run: 11 | killed: 5 | survived: 6 | kill rate: 45.5%

Survivors:

- line 39, `if->if-not`: `if (opts.mode) {`
- line 42, `if->if-not`: `if (opts.fsync) await handle.sync();`
- line 61, `if->if-not`: `if (opts.mode) {`
- line 64, `if->if-not`: `if (opts.fsync) fs.fsyncSync(fd);`
- line 101, `if->if-not`: `if (raw.trim() === '') return fallback;`
- line 101, `===->!==`: `if (raw.trim() === '') return fallback;`

| test file | kills | uniqueKills |
| --- | --- | --- |
| src/main/lib/__tests__/atomicFs.test.cjs | 5 | 5 |

## src/main/lib/epicMint.cjs

Mutants run: 20 | killed: 11 | survived: 9 | kill rate: 55.0%

Survivors:

- line 90, `&&->||`: `sessions: parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {},`
- line 98, `&&->||`: `tombstones: parsed && typeof parsed.tombstones === 'object' && parsed.tombstones ? parsed.tombstones : {},`
- line 98, `&&->||`: `tombstones: parsed && typeof parsed.tombstones === 'object' && parsed.tombstones ? parsed.tombstones : {},`
- line 246, `&&->||`: `if (explicitEpicId && hasOwn(index.sessions, explicitEpicId)) {`
- line 248, `===->!==`: `if (preferred && (preferred.status === 'proposed' || preferred.status === 'active')) {`
- line 339, `===->!==`: `...(typeof model === 'string' && model ? { model } : {}),`
- line 339, `&&->||`: `...(typeof model === 'string' && model ? { model } : {}),`
- line 340, `&&->||`: `...(typeof effort === 'string' && effort ? { effort } : {}),`
- line 366, `||->&&`: `text: String(openingPrompt || goalText || ''),`

| test file | kills | uniqueKills |
| --- | --- | --- |
| src/main/__tests__/epicMintTelemetryTap.test.cjs | 9 | 8 |
| src/main/lib/__tests__/activeIndexRebuild.test.cjs | 3 | 2 |

## src/main/lib/opsOwnership.cjs

Mutants run: 20 | killed: 19 | survived: 1 | kill rate: 95.0%

Survivors:

- line 107, `true->false`: `if (rest.length === 0) return { inOps: true, namespace: null, relative: '' };`

| test file | kills | uniqueKills |
| --- | --- | --- |
| src/main/__tests__/configWriteBoundaryOwners.test.cjs | 11 | 0 |
| src/main/__tests__/memoryAggregate.test.cjs | 11 | 0 |
| src/main/__tests__/opsErrorLog.test.cjs | 11 | 0 |
| src/main/lib/__tests__/cwdClassify.test.cjs | 13 | 0 |
| src/main/lib/__tests__/opsOwnership.test.cjs | 17 | 4 |
| src/main/lib/__tests__/opsRootResolve.test.cjs | 15 | 2 |

## Test files redundant for these modules (check before deleting: may cover other modules)

redundant for these modules (check before deleting: may cover other modules): files with kills > 0 and uniqueKills == 0 across all three modules

- src/main/__tests__/configWriteBoundaryOwners.test.cjs
- src/main/__tests__/memoryAggregate.test.cjs
- src/main/__tests__/opsErrorLog.test.cjs
- src/main/lib/__tests__/cwdClassify.test.cjs
