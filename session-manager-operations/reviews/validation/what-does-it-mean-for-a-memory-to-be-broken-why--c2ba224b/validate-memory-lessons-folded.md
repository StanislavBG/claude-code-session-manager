# Validation: memory lessons folded into the markdown network

Base: 72952588 (known). Each PRD's gate (`timeout 300 npm run lint:docs`) re-run at HEAD: exit 0 ("doc-hierarchy: ok, 21 junctions, 35 files linted"). Diffs checked with `git diff -U0 <base>..HEAD -- <file>`: every change is a pure addition (no reworded/removed lines). Code-review/security-review: self-reviewed (docs-only; no code, secrets or path handling).

## Per-PRD verdicts
- **fold-memory-lessons-scheduler-ops (3207): VERIFIED.** 8 rows added to the diagnosis table, scheduler-operations.md:369-377 (commit c8d54e7f). Each names symptom + action.
- **fold-memory-lessons-tests-readme (3208): VERIFIED.** tests/README.md:118-127 "Environment gotchas", 4 entries (commit 411da87c).
- **fold-memory-lessons-web-remote (3209): VERIFIED (deviation).** The 4 lessons landed in a NEW file `web/remote-app/RELAY.md:5-12`, linked from `web/remote-app/CLAUDE.md:61`, not inline in CLAUDE.md as the AC said. RELAY.md was not in the PRD's Files list. Content is accurate (`remoteControlEnabled` exists at webRemote.cjs:98/1095). Judged acceptable: the lesson is reachable from the scoped doc, and the PRD's own "no reworded/removed text" rule holds.
- **fold-memory-lessons-conventions-lib (3210): VERIFIED.** conventions.md:104 (E2BIG), :105 (landing refusal); src/main/lib/CLAUDE.md:53 (allProjectCwds), :54 (validated()); code-map.md:53 (MCP Servers scope). Entries are longer than "one-line" in conventions.md but match that list's incident style.
- **fold-memory-lessons-authoring-plugins (3211): VERIFIED.** PRD_AUTHORING.md:1 stamp v20→v21; rules at :237 (no interactive AC) and :238 (contract consumers gated); plugins/CLAUDE.md:18 (marketplace bump rule); bilko-run-marketing.md:38 (promo film; `web/promo-video/` exists).
- **fold-memory-lessons-plugin-skills (3212): VERIFIED.** send-feedback/SKILL.md:45; builder/SKILL.md:93; plugin.json 0.4.2→0.4.3 and marketplace.json entry 0.4.2→0.4.3 (commit 84726580).

## Per source memory file: did the lesson land?
| Memory file | Landed | Where |
| --- | --- | --- |
| detached_head_commit_drop.md | Yes | scheduler-operations.md:371 |
| false_prd_missing_tail_scan.md | Yes | scheduler-operations.md:372 |
| headless_restart_request.md | Yes | scheduler-operations.md:373 |
| quiet_machine_lease_freeze.md | Yes | scheduler-operations.md:369 |
| reverify_heals_on_foreign_commit.md | Yes | scheduler-operations.md:374 |
| running_build_vs_git_drift.md | Yes | scheduler-operations.md:375 |
| stranded_on_restart_recovery.md | Yes | scheduler-operations.md:376 |
| validator_budget_sizing.md | Yes | scheduler-operations.md:377 |
| env_sensitive_test_gotcha.md | Yes | tests/README.md:120 |
| test_stub_claude_bin_hazard.md | Yes | tests/README.md:122 |
| verified_hides_real_path_bugs.md | Yes | tests/README.md:124 |
| worktree_unit_suite_hazards.md | Partly | tests/README.md:126 has the "red in suite, green alone = environment" rule; the `build:project-pages-logic`-before-suite step is NOT stated. Memory says sweep fixed 2026-10-22, so retire is reasonable. |
| web_remote_security_findings.md | Yes | web/remote-app/RELAY.md:5-6 |
| web_remote_v2_mobile.md | Yes | web/remote-app/RELAY.md:7-8 |
| web_ui_sessions_unreachable.md | Yes | web/remote-app/RELAY.md:9-10 |
| web_version_architecture.md | Yes | web/remote-app/RELAY.md:11-12 |
| spawn_e2big_argv_prompt.md | Yes | conventions.md:104 |
| fix_plan_record_path_plan.md | Yes | conventions.md:105 |
| claude_projects_scan_cost.md | Yes | src/main/lib/CLAUDE.md:53 |
| agents_override_project_picker_plan.md | Yes | src/main/lib/CLAUDE.md:54 |
| home_tab_consolidation_plan.md | Yes (MCP lesson only) | code-map.md:53; plan-status content is not folded (plan history, fine to retire) |
| feedback_no_interactive_ac_in_prds.md | Yes | PRD_AUTHORING.md:237 |
| scoped_gates_hide_contract_breaks.md | Yes | PRD_AUTHORING.md:238 |
| md_review_output_link_rule_plan.md | Yes (marketplace rule only) | plugins/CLAUDE.md:18 |
| promo_video_pipeline.md | Yes | bilko-run-marketing.md:38 |
| cross_project_prd_authoring.md | Yes | send-feedback/SKILL.md:45 |
| publish_worktree_cold_gate.md | Yes | builder/SKILL.md:93 |

## Findings
- Critical: none.
- Important: none.
- Minor: web-remote lessons landed in unlisted new file `web/remote-app/RELAY.md` instead of CLAUDE.md (above).
- Minor: worktree_unit_suite_hazards.md's `build:project-pages-logic` step is not folded (tests/README.md:126).
- Minor: the working tree also carries unrelated memory-explorer code commits in `base..HEAD` (other plans); not reviewed here.
