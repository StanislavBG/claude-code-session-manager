# Validation: demo-video job full persona

Base: 0a74342be5bb5c08382625ead5c52dc510ceb3ac. HEAD validated: e819c29c.
PRD file: epics/demo-video-animated-whiteboard-add-30-s-1-min-le-0fddc055/prds-archived/2596-job-persona-shipped-seed-uncapped.md
Landed commit: 27158bcb (merge 3a4108f0).

## job-persona-shipped-seed-uncapped — PRD criteria VERIFIED; plan-level full-suite criterion NOT met

- buildPersonaBodyText(rawBody, path, { uncapped }) returns the whole body when uncapped, otherwise the old cap and notice: agentModelResolve.cjs (`uncapped || body.length <= AGENT_BODY_CHAR_CAP`).
- resolvePrdPersonaForSpawn sets uncapped only when the body digest matches `SHIPPED_PERSONA_SEEDS[agentType]`. An unknown name gives `[]`, so the body stays capped.
- Tests in agentModelResolve.test.cjs cover the whole shipped body, the shipped body plus one line (capped), a 7000-char unknown persona (capped), and `shippedBodyHash` equal to `personaBodyHash`.
- The comment above AGENT_BODY_CHAR_CAP states the exemption.
- Gate: the 3 vitest files passed (77 tests), and `npm run typecheck` exited 0.
- Real-path probe, run from the main checkout with HOME set to a temp dir holding a copy of src/seed/agents/demo-video-builder.md at .claude/agents/:
  - Unedited copy: `A len 21119 trunc false F77F00 true`.
  - Copy with one appended line: `B len 6129 trunc true`.
  - Both results match the acceptance criterion.
- `timeout 600 npm run test:unit` at HEAD, with SM_* unset: 4-5 failures per run.
  - Run 1: 4 failed. Run 2: 5 failed, including worktreeSetup "different mainCwd keys overlap". That one passed on isolated rerun, so it is a flake.
  - Four reds reproduce in isolation at HEAD and are green at Base. I ran them in a detached Base worktree: 71/71 passed.
    - check-ops-path-literals "the real repo tree is clean"
    - apiSurface "preload methods missing from table"
    - ProjectHomeEmptyState "renders no hand-written live blocks…" (TypeError reading 'length')
    - macroLibrary "real demo-video v4 copy … upgrades to v5" (got 6; macro v6 landed in 949792c4)
  - None of them touch agentModelResolve. They come from the later marketing-features commits in the range (kit seeder / project_character_write tool / macro v6), not from PRD 2596. The "or red at Base too" escape does not apply, so the criterion is unmet.

## Findings

### Important
- macroLibrary.test.cjs:431 asserts builtinVersion 5. Macro v6 (949792c4) makes it 6, so the test is stale.
- apiSurface.test.cjs: the table lacks the preload method(s) added by 692d3f75 (project_character_write / kit seeding).
- check-ops-path-literals reports a literal in the real tree, introduced in the range after Base.
- ProjectHomeEmptyState.test.tsx throws TypeError ('length' of undefined) at HEAD. It is green at Base.

### Minor
- worktreeSetup.test.cjs "different mainCwd keys overlap" flaked once under full-suite load.
- The persona has since been rewritten to seedVersion 8. The exemption still works, because the manifest carries that version's hash (probe result above).
