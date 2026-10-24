# Validation sweep 202610241956

Base: 9df7a773 (from PRD notes). Commits found via `git log base..HEAD`: 01d37a33 (2198), 58667387 (2199), b627b613 (2200), 774bbb8f (2201), 91872a04 (2202), f19eb67c (2203 seed status), a10fccc4 (2203 fix).
Gates re-run (all exit 0): combined `vitest run` over every PRD's gate test files — 20 files, 282 tests passed; `npm run typecheck` clean.
Note: two PRD files share number 2203 (`2203-fix-telemetry-machine-seed-status`, `2203-telemetry-machine-seed-status`); only the fix one is in scope, the sibling's code (f19eb67c) is present.

## guard-spawn-settings-primitive — VERIFIED
- buildGuardSpawnSettings groups GUARD_DEFS by matcher, hook = nodeShellCommand(guardShimPath(...)): guardSpawnSettings.cjs:25-41.
- checkGuard-ok guards skipped; null when none left: :28, :35.
- writeGuardSpawnSettingsFile awaits ensureShims, sha1[0..12] path, skips existing, writeTextAtomic, null on failure (never throws): :52-74.
- GUARD_DEFS/checkGuard exported, nothing else changed: delegationReadiness.cjs diff (+2 lines).
- Test file guardSpawnSettings.test.cjs present and passing (gate).

## epic-standing-instructions-primitive — VERIFIED
- Kinds actor/persona-body/injection/mission only, stored order: epicStandingInstructions.cjs:13,33-37.
- Legacy fallback to readPersonaBody(agentType): :38-43.
- Delegate text for feature/bug/architect unless injection section exists: :45-49.
- 12000 cap + notice, null on empty/null epic: :11-12,23-26,29,51-52.
- defaultReadPersonaBody overlay-aware via resolveMergedPersona: :56-65.
- delegateTextDrift.test.ts and unit tests pass.

## launch-session-default-injections — VERIFIED
- defaultContextInjectionsForTag exported: contextInjections.ts:60-65 (general-behavior true; delegate only feature/bug).
- launchSession passes it to composeEpicIntake: launchSession.ts:55.
- launchSession.test.ts +20 lines asserting feature/discussion/general-behavior; passes.

## delegation-readiness-self-heal — VERIFIED
- selfHealDelegation: plugin install with bundled marketplace, respects enabledPlugins === false, mcp remove+add, ignores seed attempts marker: delegationSelfHeal.cjs:38-60.
- Once per check per process (claimed synchronously) and awaits boot seeding: :41-44; index.cjs passes `bootSeedingPromise` (assigned from runSeedersSerially).
- Marker rewritten on success; failures logged scope 'delegationSelfHeal', never thrown: :58-70.
- Handler wired, returns fresh check result: index.cjs:630-643.
- Tests pass (delegationSelfHeal, seedDevPlugin, seedSchedulerMcp).

## telemetry-epic-and-prd-create-signals — VERIFIED
- trackEpicCreate({tag, agentType}, deps) with tag→'other' / agentType→'custom' mapping: telemetryCounters.cjs:32-52.
- epicMint passes tag/agentType: epicMint.cjs:385.
- trackPrdCreate once after successful writePrd; alreadyExisted returns earlier (prdCreate.cjs:498 vs :675); tests pass.

## fix-telemetry-machine-seed-status — VERIFIED
- a10fccc4 touches only two test files (telemetryCounters.test.cjs, telemetryCountersMetadataColumn.test.cjs); all trackEpicCreate calls use (props, deps); keys asserted `['agentType','tag']`.
- `vitest run src/main/lib/telemetry/__tests__/` passes (incl. telemetryMachineSeeds).

## Findings
### Critical
- none
### Important
- none
### Minor
- Two PRDs numbered 2203 in prds-archived (duplicate NN; see memory "Unique PRD numbers").
- src/renderer/components/epics/NewEpicCard.tsx:96 still holds a private duplicate of defaultContextInjectionsForTag (PRD 2200 explicitly deferred this to a later plan PRD).
- guardSpawnSettings/epicStandingInstructions are primitives not yet wired into any spawn (explicitly out of scope; later PRDs).
- delegationSelfHeal.cjs:63 `cwd: d.cwd` is only set via index.cjs deps; undefined in other callers (harmless).
- Self-review (no new security issues): seed values sanitized to enum in telemetryClient.cjs sanitizeSeeds; telemetry maps user personas to 'custom'; file paths built from homeDir + sha1 only.
