---
title: Make health monitoring per-project: unmask stalled projects and stop stranding quarantined PRDs
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
createdVia: scheduler-api
issuedAt: 2026-08-08T19:44:56.609Z
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
---
# Goal

The scheduler ENGINE is correctly machine-wide — queueStore's stateCwds() unions every project holding a queue.json plus every active project, so reconcile, the dead-process reaper, selectAutoFixTargets, spawnInvestigation, reverifyNeedsReview and the DoD drain gate all already operate across every project. The MONITORING layer did not keep up, and three gaps let a project go dark. (1) `quarantined` (shipped in the PRD-authoring lockdown) has NO automated attention and no cross-project surface: homeNeedsYou.ts:96 admits only 'failed'/'needs_review', and the 10-minute periodic pass at scheduler.cjs:4938 only fires `if (s.jobs.some(j => j.status === 'needs_review'))`. Verified live right now: the `burrow` project holds FOUR quarantined PRDs (821-ops-feedback-guard-silent-green, 822-ops-skill-graph-output-path, 823-ops-claudemd-catalog-entry, 824-ops-index-generator-versioned) that nothing will ever look at again. (2) The stall detector's verdict is global, not per-project: scheduler.cjs:991 computes `stalled = total > 0 && running === 0 && pending === 0` over the MERGED job list, so burrow being fully stalled (4 quarantined, 0 running, 0 pending) is masked by 2 running + 2 pending in other projects. It already computes `byProject` — only the boolean is wrong. (3) `npm run health` counts only `failed` (health.cjs:222), missing needs_review and quarantined entirely.

# Acceptance criteria

- [ ] computeStallSummary returns a PER-PROJECT stall verdict: each cwd in `byProject` gets its own `stalled` flag (that project holds jobs but has 0 running AND 0 pending), alongside the existing machine-wide roll-up — a project stalled while other projects are busy must be detected
- [ ] The heartbeat's stall alert fires on any per-project stall, and its error log + toast name the stalled project cwd(s) rather than only reporting a global condition; existing once-per-episode rate limiting is preserved and extended per-project so one stalled project cannot suppress an alert for another
- [ ] homeNeedsYou.ts surfaces `quarantined` jobs as a needs-you row alongside 'failed'/'needs_review', with its own label and an action that routes to adoption (not Retry — a quarantined job must not be re-run, it must be adopted or archived)
- [ ] The 10-minute periodic pass no longer gates solely on needs_review: a queue holding quarantined rows also triggers a pass that re-checks whether those PRDs have since been stamped (reconcile already adopts a stamped row — this only ensures the pass actually runs)
- [ ] A quarantined job that has sat un-adopted beyond a configurable age (default 24h) is escalated: logged at warn level naming project + slug + age, and surfaced distinctly on Home so it cannot be stranded indefinitely and silently
- [ ] health.cjs's rollup counts needs_review and quarantined alongside failed, and reports them BROKEN DOWN BY PROJECT, so `npm run health` answers 'is any project stuck' rather than only 'is the machine stuck'
- [ ] health.cjs exits non-zero (RED) when any project has been fully stalled past the configured threshold, so the existing /local-project-health entry point catches it
- [ ] Tests cover: per-project stall detection with one busy and one stalled project (the exact burrow-vs-others shape observed); a quarantined job producing a Home needs-you row; the age-based escalation firing past threshold and not before; health.cjs's per-project counts including all three non-terminal-problem statuses
- [ ] npm run typecheck, npm run test:unit, npm run lint all pass

# Implementation notes

Key files: src/main/scheduler.cjs (computeStallSummary ~963-992, heartbeat + stall rate limiting ~4848-4880, the 10-min periodic pass ~4930-4941), src/renderer/lib/homeNeedsYou.ts (the status filter at line 96 and the NeedsYouKind union at 35), src/main/health.cjs (readMergedSync at 217, failedCount at 222-223), src/main/lib/queueStore.cjs (stateCwds — read it first to confirm the merge already covers every project; do NOT re-implement project discovery). Note the existing `stallSince`/`stallToasted` module-level vars are single-valued — they must become per-cwd maps, or one project's stall episode will suppress another's alert. Do NOT add a Retry action for quarantined rows: quarantined means unproven provenance, and re-running is exactly what the gate exists to prevent; the only correct actions are adopt (stamp via scheduler_update_prd) or archive. Related context: the Scheduler nav is Project-face only (commit 703f9a7) and CLAUDE.md records that a federated cross-project queue view was deliberately postponed — this PRD does NOT build that view; it makes Home (the one genuinely cross-project surface) and health.cjs complete enough that a dark project is impossible to miss. The four live burrow rows are real test data — verify against them before and after.

# Out of scope

- Building a federated cross-project Scheduler tab view — deliberately postponed, see CLAUDE.md
- Auto-adopting quarantined PRDs — provenance adoption stays a human decision
- Changing what the engine already does machine-wide (reconcile/reaper/auto-fix/reverify are correct as-is)
- The NN-fix-* hook/quarantine exemption

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
