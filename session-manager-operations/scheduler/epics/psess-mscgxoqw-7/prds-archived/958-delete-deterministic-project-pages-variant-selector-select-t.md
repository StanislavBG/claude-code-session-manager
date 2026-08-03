---
title: Delete deterministic Project Pages variant selector (select.ts, predicates, CLI script)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-mscgxoqw-7
---
# Goal

Remove the now-retired deterministic Stage 2 variant scorer for the Project Pages pipeline: the project-home-builder agent now picks variants itself (per the human's decision, Epic "Project Home Layout", 2026-08-03, and per sibling PRD 957's doc rewrite), so the rule-based scorer, its predicate language, and the CLI script that invoked it are dead code. Delete them and every reference so the build and test suite stay green with no dangling imports.

# Acceptance criteria

- [ ] src/renderer/lib/projectPages/select.ts is deleted (exported scoreVariants, mergePicks).
- [ ] src/renderer/lib/projectPages/selectionPredicates.ts is deleted (VARIANT_REQUIREMENTS map, evaluatePredicate, requirementsSatisfied, anyAvoided, requirementsFor).
- [ ] src/renderer/lib/projectPages/__tests__/select.test.ts is deleted.
- [ ] scripts/select-project-pages-picks.cjs is deleted.
- [ ] src/renderer/lib/projectPages/logicBundle.ts no longer exports scoreVariants/mergePicks (remove the `export { scoreVariants, mergePicks } from './select';` line) but still exports validateProjectPageSummary and LENS_LIBRARY/LENS_ORDER unchanged — read the full file first and confirm no other line references select.ts before editing.
- [ ] scripts/build-project-pages-logic.mjs is checked for any reference to select.ts/selectionPredicates.ts or the deleted script and updated if it names them directly (e.g. in a file list, glob, or comment) — report explicitly in the PRD completion notes whether a change was needed here or not.
- [ ] src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx: find the comment referencing 'Stage 2 selector' and "select.ts's mergePicks" (currently around the JSDoc above the Regenerate handling) and rewrite it to describe the current agent-owned pick-preservation behavior (picks.json is written directly by the project-home-builder agent's Write tool, which preserves existing picks unless asked to start over) instead of naming the deleted function.
- [ ] grep -rn "select-project-pages-picks\|selectionPredicates\|from './select'\|from '../select'\|scoreVariants\|mergePicks" across src/ and scripts/ (excluding this PRD's own file and session-manager-operations/) returns zero matches after the change.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 300 npm run test:unit passes (confirms no test still imports the deleted modules and the rest of the Project Pages test suite — summaryValidate, render, etc. — is unaffected).
- [ ] npm run lint:selectors passes (unrelated to this change but is part of this repo's standard pre-commit checks per CLAUDE.md; confirm it still passes since files under src/renderer were touched).

# Implementation notes

Current call graph to unwind, confirmed by reading the code before this PRD was written:\n- src/renderer/lib/projectPages/logicBundle.ts re-exports `{ scoreVariants, mergePicks }` from `./select` alongside `validateProjectPageSummary` from `./summaryValidate` and `{ LENS_LIBRARY, LENS_ORDER }` from `./library` — only the select.ts export line should be removed.\n- scripts/select-project-pages-picks.cjs is a thin CLI wrapper that requires scripts/project-pages-logic/dist/logic.cjs (the esbuild output of logicBundle.ts) and calls scoreVariants/mergePicks — delete the whole file.\n- scripts/build-project-pages-logic.mjs is the esbuild script that produces scripts/project-pages-logic/dist/logic.cjs from logicBundle.ts — it likely just points at the single entry file and needs no change, but verify by reading it; if npm run build:project-pages-logic is a package.json script, leave it in place since validateProjectPageSummary and LENS_LIBRARY/LENS_ORDER still need the bundle for the summary-validator CLI (scripts/validate-project-pages-summary.cjs) which is NOT being removed.\n- src/renderer/lib/projectPages/__tests__/select.test.ts tests scoreVariants/mergePicks directly — delete it; do not try to repurpose it.\n- ProjectPagesSection.tsx's stale comment is around lines 260-266 (search for \"Stage 2 selector\" to find it exactly — line numbers may have shifted).\nDo not add any new predicate/scoring code back in any form as a replacement — selection is now purely the project-home-builder agent's own judgment call at generation time, with no code-level selection logic left in this repo. Sibling PRD 957 handles the doc rewrite (project-pages-pipeline.md, .claude/agents/project-home-builder.md) — do not duplicate that work here, this PRD is code-only.

# Out of scope

- Rewriting session-manager-operations/architecture/project-pages-pipeline.md or .claude/agents/project-home-builder.md (PRD 957)
- Any change to the component library (library/*.tsx), summary synthesis, or Stage 3 render logic
- Adding any new selection/scoring mechanism as a replacement

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
