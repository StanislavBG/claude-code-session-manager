# Validation: Review MD network built-in (PRDs 2725-2733)

Base: 45e8cf55faaba3cadf6da87a373e6354d3e690f1. Landed commits: 2dff8ad4 (script), 40fc351a, e5989fb7, 479b8bc8, ef58b144 (refs), 260bb237 (SKILL.md + 0.3.1), e876564c (seed inputs/supersedes), e079caa2 (macro), 369fb48a (eval).

Gates re-run (all exit 0): `vitest run` md-network-drift-check, dev-plugin-skillset, macroLibrary, builtinMacros = 4 files / 83 tests pass; `npm run typecheck` exit 0; drift-check.cjs over placement.md, audit.md, plan.md, drift-check.md, SKILL.md and the eval record = exit 0, findings [].

## md-network-drift-check-script — VERIFIED
- Own run on a temp git repo: clean (a.md -> b.md) printed one JSON object, exit 0; after changing the link to nope.md it printed `broken-link a.md:2 nope.md`, counts {broken-link:1}, exit 1.
- Flags --root/--map/--file/--exclude/--checks parsed at scripts/drift-check.cjs:35-39; unknown/missing value exits 2 (line 28). Node built-ins only; `git ls-files` via spawnSync without shell (line 69).

## md-network-ref-placement — VERIFIED
- Gate exit 0. placement.md (38 lines) lists seven https sources (lines 32-38) plus placement rules.

## md-network-ref-audit — VERIFIED
- Gate exit 0. audit.md: Time box (line 14, 5/12/5-minute split), steps 1-4 (lines 33/64/82/104), Subagent brief (line 123) with 10-minute limit, no-files brief.

## md-network-ref-plan — VERIFIED
- Gate exit 0. plan.md: Verdicts table (line 32), DELETE only when three conditions hold (line 44), `/develop` order (line 62), Other repos (line 72).

## md-network-ref-drift-check — VERIFIED
- Gate exit 0. Flag table drift-check.md:23-26 matches the script's flags exactly; Review record path and fields at lines 91-138.

## md-network-skill-overview — VERIFIED
- Gate exit 0. SKILL.md (62 lines) links placement/audit/plan/drift-check once each (lines 30-33); grep shows no reference file links another. plugin.json:4 version 0.3.1; marketplace.json:17 version 0.3.1.

## builtin-macros-seed-inputs-supersede — VERIFIED
- macroLibrary.cjs: seed branch copies inputs (copyInputs, diff +356-361); upgrade branch sets or deletes inputs; supersedes filter drops only ids with `m.builtin !== true` on first seed and collects `retired`; applyBuiltins logs after successful write. Tests pass. Prior saveMacro change from the other Epic preserved.

## builtin-review-md-network-macro — VERIFIED
- `git diff 45e8cf55..HEAD -- builtinMacros.cjs`: header comment plus one appended entry; no hunk touches builtin-project-home or builtin-demo-video. Entry: id builtin-review-md-network, agent architect, tag discussion, surface project-home, projects ['*'], no `job`, frozen inputs scope+mode (options Full review / Drift check), supersedes review-md-network-d38ffd, builtinVersion 1, priorPrompts [].

## md-network-skill-eval — VERIFIED
- Gate exit 0. Record covers Bilko, family-frame and session-manager (scenarios lines 16/32/47, runs A and B lines 65-85) and maps the hand-run Bilko review (Comparison section, line 110).

## Composition with the other Epic — CONFIRMED
- ProjectPagesSection.tsx:240 `PAGE_MACRO_IDS = ['builtin-project-home','builtin-demo-video']`; line 412 hot keys = every other macro, so the new built-in is a hot key; HotKeyStrip opens MacroInputsForm (lines 242, 266).
- useMacroLaunch.ts: no `job` -> skips the job branch and calls launchSession with agentName architect, tag discussion, goal = rendered prompt, then onSelect(epicId) (lines ~108-122). Tests: useMacroLaunch.test.tsx:134 (job-less mints new Epic even with an active one), :165 (no delegationReadiness), :243-296 (inputs rendering/required).

## Findings
### Critical
- none
### Important
- none
### Minor
- eval record shows the script's `missing-path` check is noisy (session-manager 288 in Run B; Bilko false positives such as `origin/main`). Evaluator already notes it; consider a heuristic tweak.
- Combined diff base..HEAD is 206 files because of unrelated merged plans; only this plan's paths were reviewed. No secrets, shell injection (spawnSync without shell) or path traversal found in the script.
