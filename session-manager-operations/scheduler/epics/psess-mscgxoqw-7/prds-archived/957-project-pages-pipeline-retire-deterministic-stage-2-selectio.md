---
title: Project Pages pipeline: retire deterministic Stage 2 selection in docs
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: psess-mscgxoqw-7
---
# Goal

Update the Project Pages pipeline docs so they describe agent-owned variant selection instead of the current deterministic, rule-based Stage 2 scorer. This is a direct architecture reversal decided by the human (Epic "Project Home Layout", 2026-08-03): there is no separate deterministic selection stage anymore — the project-home-builder agent itself picks each slot's variant by reasoning over summary.json against the component library's own variant notes, the same way it already writes summary.json with its own Read/Write tools. Docs must land first since they are this repo's source of truth for the pipeline (CLAUDE.md: "edit here, not in either of those, when the design changes").

# Acceptance criteria

- [ ] session-manager-operations/architecture/project-pages-pipeline.md's "Stage 2 — Summary → component mapping (selection)" section is rewritten: remove the description of a deterministic requires/avoidIf predicate scorer picking the highest-scoring variant; replace with a description of the project-home-builder agent choosing one variant per slot per lens itself, by reading each variant's note/description in the component library (src/renderer/lib/projectPages/library/*.tsx) and judging fit against summary.json, then writing picks.json directly via its own Write tool (same class of step as Stage 1's summary.json authoring) in the existing Record<lensId, Record<slotId, variantId>> shape.
- [ ] The rewritten Stage 2 section explicitly keeps the existing 'respect existing hand-picks unless explicit start-over' rule (do not silently overwrite a prior pick on regenerate) and explains this is what keeps selection stable across regenerates even though it's now agent-judged rather than script-computed: a project's picks are judged once (or on explicit reset) and then persisted like project-brief's pinned blocks, so this is not reintroducing per-regenerate nondeterminism.
- [ ] "Explicit non-goals for v1" section: remove the line "No LLM-driven variant selection (Stage 2 is rule-based only)." — this is exactly the decision being reversed. Do not leave a contradictory statement anywhere else in the file (grep the file afterward for 'rule-based', 'deterministic', 'scorer', 'predicate' and fix or remove any remaining stale references to the old Stage 2 mechanism, including the 'No LLM call needed for v1 of this stage' sentence).
- [ ] session-manager-operations/architecture/project-pages-pipeline.md's Stage 4 section's mention of picks.json / mergePicks still reads correctly after the Stage 2 rewrite (it references 'select.ts's mergePicks' by name — update that reference to describe agent-owned pick-preservation instead, without naming a specific TS function that a sibling PRD (958) will delete).
- [ ] .claude/agents/project-home-builder.md (project overlay, this repo's own file — NOT ~/.claude/agents/project-home-builder.md which is a separate global file outside this repo and out of scope for this PRD): protocol step 4 currently reads 'Run the Stage 2 selection scorer: node scripts/select-project-pages-picks.cjs ...'. Replace it with an instruction to read each lens's slot/variant notes (already read via the component library README + source files in earlier steps) and summary.json, then directly choose one variant per slot per lens based on genuine fit to this specific project's summary, and write picks.json in the existing shape via the Write tool — preserving any existing picks.json entries unless the request is explicitly 'start over' for specific slots (mirror the existing 'Respect existing hand-picks' rule already stated elsewhere in this same file under Hard rules).
- [ ] Re-read the full updated .claude/agents/project-home-builder.md and session-manager-operations/architecture/project-pages-pipeline.md end to end after editing; confirm no remaining reference instructs running scripts/select-project-pages-picks.cjs or building scripts/project-pages-logic/dist/logic.cjs for a selection step (validation still legitimately builds/uses that bundle for validateProjectPageSummary — do not remove that reference, only the selection-scorer one).
- [ ] git diff shows only the two doc files changed; no code files touched by this PRD (code deletion is PRD 958, a separate sibling PRD — do not do both in one PRD).

# Implementation notes

Read session-manager-operations/architecture/project-pages-pipeline.md in full first (it is long — read the whole file, not just the Stage 2 section, since Stage 4 and the Storage/ownership section also reference the mechanism being changed). Then read .claude/agents/project-home-builder.md in full (short file, has numbered Protocol steps 1-6; step 4 is the one to change). Do not touch scripts/select-project-pages-picks.cjs, src/renderer/lib/projectPages/select.ts, or selectionPredicates.ts in this PRD — their deletion is handled by a separate sibling PRD (958-project-pages-remove-deterministic-selector, queued alongside this one). This PRD is docs-only. For context on why this change is happening, see the current (soon-to-be-outdated) Stage 2 text itself and its reasoning ('nondeterministic re-layout on every regenerate is worse than a boring, repeatable rule') — the rebuttal to keep in the new text is that hand-pick preservation (already an existing rule, unchanged) is what actually prevents re-layout churn, not the scorer.

# Out of scope

- Deleting select.ts / selectionPredicates.ts / scripts/select-project-pages-picks.cjs / their test file (PRD 958)
- Any change to Stage 0 (component library), Stage 1 (summary synthesis), Stage 3 (render), or Stage 4 UI behavior beyond the wording fix to the mergePicks reference
- Editing the global ~/.claude/agents/project-home-builder.md file outside this repo

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
