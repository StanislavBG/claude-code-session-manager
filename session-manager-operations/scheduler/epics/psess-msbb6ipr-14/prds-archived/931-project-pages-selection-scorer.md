---
title: Project Pages — deterministic slot-selection scorer
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msbb6ipr-14
dependsOn: [929-project-pages-static-renderer, 930-project-pages-summary-schema]
---
# Goal

Build the Stage 2 "summary → component mapping" step: a deterministic, non-LLM scorer that picks the best-fitting variant for every slot in every lens, given a ProjectPageSummary, by formalizing each variant's existing prose `note` (already in the ported library from PRD 929) into structured requires/avoidIf predicates. This replaces ad hoc judgment with a repeatable rule so regenerating a project's pages doesn't reshuffle the layout on every run. Also implements the idempotency rule: an existing picks.json's hand-made choices are preserved on regenerate unless the caller explicitly asks to reset.

# Acceptance criteria

- [ ] Read src/renderer/lib/projectPages/library/index.ts (from PRD 929) and every VariantDef's `note` string before writing predicates — do not invent requirements not implied by the existing note text (e.g. a note saying 'Needs a real quote.' implies `requires: ['summary.quotes.length > 0']`; a note with no such qualifier implies no requirement, i.e. always eligible).
- [ ] Extend VariantDef (or add a parallel VariantRequirement map keyed by `${lensId}.${slotId}.${variantId}`) with `requires: string[]` and `avoidIf: string[]`, each entry a dot-path + comparison expression evaluable against a ProjectPageSummary WITHOUT using JS `eval`/`Function` (write a small safe expression evaluator supporting `.length > N`, `.length === 0`, and plain truthiness of a dot-path, e.g. `architecture.risks.length > 0`) in src/renderer/lib/projectPages/selectionPredicates.ts.
- [ ] Add src/renderer/lib/projectPages/select.ts exporting `scoreVariants(lens: PageLensDef, summary: ProjectPageSummary): Record<slotId, variantId>` — for each slot, filters out variants whose `requires` isn't satisfied or whose `avoidIf` IS satisfied, then among the remaining eligible variants picks deterministically (e.g. first eligible variant in the slot's defined order, OR the preset v1 pick if it's eligible, falling back to the first eligible one otherwise — pick ONE deterministic tie-break rule and document it in a code comment) — if NO variant in a slot is eligible (all have unmet requires), fall back to the slot's preset v1 pick regardless (never leave a slot unpicked).
- [ ] Add `mergePicks(existing: ProjectPagePicks | null, scored: ProjectPagePicks, resetSlots?: string[]): ProjectPagePicks` — for each slot, keeps `existing`'s pick if present UNLESS that slot id is listed in `resetSlots`, otherwise uses `scored`'s pick. When `existing` is null, returns `scored` unchanged.
- [ ] Add scripts/select-project-pages-picks.cjs CLI wrapper: `node scripts/select-project-pages-picks.cjs <summary.json path> <existing picks.json path or 'none'> <output picks.json path> [comma-separated resetSlots]` requiring the same build:project-pages bundle from PRD 929 (extend that bundle's entry point to also export scoreVariants/mergePicks, OR add a second small esbuild entry — pick whichever keeps the build script simplest and document the choice).
- [ ] New unit test src/renderer/lib/projectPages/__tests__/select.test.ts covering: (a) a summary with empty quotes[] never selects a quote-requiring variant in any lens, (b) a summary with populated quotes[] CAN select a quote-requiring variant when it's the deterministic winner, (c) every slot in every lens always receives a pick for a minimal valid summary (no undefined/missing slot in the output), (d) mergePicks preserves an existing hand-pick for a slot not in resetSlots, and overwrites it for a slot that IS in resetSlots.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/lib/projectPages/__tests__/select.test.ts passes

# Implementation notes

Depends on PRD 929 (library/index.ts's VariantDef shape and LENS_LIBRARY) and PRD 930 (ProjectPageSummary's final validated shape). Read both PRDs' actual landed files rather than re-deriving from the architecture spec's prose. Canonical spec: session-manager-operations/architecture/project-pages-pipeline.md Stage 2 section. The saved component library's per-variant `note` text is at session-manager-operations/design-mocks/project-pages-component-library/source/*.jsx (e.g. 10-marketing-slots-core.jsx's PAGE_MARKETING.slots array) — cross-reference against whatever PRD 929 ported into library/index.ts to make sure notes weren't dropped in the port. Explicitly avoid `eval`/`new Function` for the predicate evaluator (security — untrusted-shaped data should never reach a code-eval path even though these particular strings are developer-authored, not user input; a small hand-written dot-path+comparator parser is the correct scope here, not a general expression language).

# Out of scope

- An LLM-driven taste pass over the scored picks — explicitly deferred per the architecture spec's non-goals.
- Rendering — that's PRD 929's render.tsx, already built; this PRD only produces the picks.
- Any Project Home UI — separate PRD.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
