---
title: Retire direct PRD authoring as the sanctioned path and fix the false retired-directory guarantee
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 55
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
dependsOn: [complete-the-scheduler-prd-api-so-direct-filesystem-access-i]
---
# Goal

Direct filesystem PRD authoring is not a leak in the boundary — it is the DOCUMENTED DEFAULT. plugins/session-manager-dev/skills/develop/SKILL.md:60 instructs "Write every PRD's markdown yourself", line 426 says "Write PRD files directly, then confirm", and lines 255-267 present `node scripts/mint-epic.cjs <cwd> <epic-id>` + a hand-written file as a first-class "manual-write fallback" co-equal with the MCP tool. The scheduler_create_prd tool description itself ends with "if the app is not running, author the PRD file by hand instead". So the service boundary is advisory by policy, not just by implementation. Separately, that same skill (lines 268-271) promises the retired flat `session-manager-operations/scheduler/prds/` dir is "auto-consolidated into prds-archived/ at the next app boot WITHOUT being executed" — this is FALSE: prdLocations.cjs:126 unconditionally adds the flat dir as a live scan source, and the 2026-08-07 incident PRDs (1021/1022, social-signals-trader) were written there and did execute once their status was repaired. Consolidation only runs at boot, so anything written to the retired dir after boot stays live. Make the docs true and make the MCP the sanctioned path.

# Acceptance criteria

- [ ] develop/SKILL.md is rewritten so the MCP tools are the ONLY sanctioned authoring and mutation path: the 'write the markdown yourself' instruction is reframed as 'do the thinking/decomposition yourself in the main loop, then submit it through scheduler_create_prd' — the model-economics point of line 55-64 must be preserved, since it is about WHERE the thinking happens, not about which tool writes the file
- [ ] The manual-write fallback is demoted from co-equal to explicitly last-resort: retained ONLY for the app-not-running case, marked as such, and required to emit a visible warning in the agent's report that the PRD bypassed the service boundary and needs verification
- [ ] SKILL.md lines 426 and 429's bullets are updated so 'Write PRD files directly' is no longer stated as the normal path
- [ ] scripts/scheduler-mcp-server.cjs's scheduler_create_prd description no longer presents hand-authoring as a plain alternative; it names it a degraded fallback with the same warning requirement
- [ ] The retired-directory claim is made TRUE in code, not just softened in prose: either prdLocations.cjs stops adding the flat prds/ dir as a scan source, or the consolidation runs on a watcher/tick rather than only at boot — pick one and state which in the PR
- [ ] If the flat dir stops being scanned, a migration pass moves any PRD currently sitting there into its resolved Epic's prds/ dir (or prds-archived/ if terminal), logging each move — no PRD may be silently orphaned by this change
- [ ] A test asserts a PRD written into the retired flat dir after boot is either executed-after-migration or provably never executed — whichever behaviour was chosen — so the doc and the code cannot drift apart again
- [ ] Project CLAUDE.md's scheduler section is updated to state the API-only rule, and audit-ops-hygiene.cjs / the ops-sweep skill flag a hand-written PRD as a hygiene finding

# Implementation notes

Files: plugins/session-manager-dev/skills/develop/SKILL.md (lines 55-64, 250-272, 420-430), scripts/scheduler-mcp-server.cjs (tool descriptions ~line 88-118), src/main/lib/prdLocations.cjs (resolvePrdsDirs at line 118-146, specifically the `if (fs.existsSync(dir)) add(dir)` for the flat dir), src/main/lib/prdMigration.cjs (existing consolidation, and read its fail-closed comment at lines 120-121 before changing it), scripts/mint-epic.cjs, scripts/audit-ops-hygiene.cjs. Read the comment at prdLocations.cjs:100-117 before removing the flat dir from the scan: resolvePrdsDirs was deliberately un-recency-filtered after a 2026-07-31 incident where 142 PRDs across 6 quiet projects had their queue rows silently dropped because their dir was unscannable — reconcile reads an unscannable PRD as a DELETED one. That failure mode is exactly what a careless removal here would re-create, which is why the migration AC is mandatory and must run before the scan source is dropped. Depends on the API-parity PRD because demoting the manual path is only honest once the API can do everything the manual path could.

# Out of scope

- The PreToolUse deny hook and provenance stamping — the sibling enforcement PRD
- Changing where new PRDs are written (epics/<id>/prds/ stays canonical)
- Any change to Epic creation or the single-creator law

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
