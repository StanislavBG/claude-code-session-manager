---
title: Project Pages — summary schema doc + agent-authored artifact folder
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msbb6ipr-14
dependsOn: [929-project-pages-static-renderer]
---
# Goal

Finalize the ProjectPageSummary contract as a validated, documented artifact (not just a TS type) so both the project-home-builder Epic agent (which composes summary.json by hand using Read/Write tools — there is no backend synthesis call for this) and any future tooling have one unambiguous schema to target, plus a runtime validator the agent/scripts can call to catch malformed output before it reaches the renderer. Also establishes session-manager-operations/project-pages/ as a documented agent-authored artifact folder (same class as design-mocks/ and HUMAN_LEARN/, explicitly NOT an OWNERS namespace — see the corrected 'Storage / ownership' section of the architecture spec).

# Acceptance criteria

- [ ] Read session-manager-operations/architecture/project-pages-pipeline.md in full, especially the corrected Stage 1 and 'Storage / ownership' sections, before writing anything.
- [ ] src/renderer/lib/projectPages/summaryType.ts (created by PRD 929 — read it first) gains a companion JSON Schema (or a lightweight hand-written validator function `validateProjectPageSummary(value: unknown): { ok: true; summary: ProjectPageSummary } | { ok: false; errors: string[] }` in src/renderer/lib/projectPages/summaryValidate.ts) checking: required top-level keys present, `stats`/`pillars`/`architecture.layers`/`architecture.modules` are arrays, `quotes` is an array (may be empty), no field is the literal placeholder string 'TODO' or empty string where a non-empty string is required by the type.
- [ ] New unit test src/renderer/lib/projectPages/__tests__/summaryValidate.test.ts covering: a valid minimal summary passes, a summary missing a required field fails with a descriptive error naming the missing field, an empty quotes[] array is valid (never required).
- [ ] Create session-manager-operations/project-pages/README.md documenting: the folder holds summary.json, picks.json, output/*.html and manifest.json for the CURRENT PROJECT's Project Pages; it is written by the project-home-builder Epic's own session directly (Read/Write tools), NOT by session-manager's main process — explicitly note it is NOT an OWNERS namespace (link to src/main/lib/opsOwnership.cjs's OWNERS table and explain why: OWNERS's assertOpsWrite only guards config.cjs's own writers and cannot intercept a claude session's own Write tool calls) and instead follows the same convention as design-mocks/README.md and HUMAN_LEARN/ (agent-authored artifact, one author per invocation, concurrency handled by 'Generate Now' resuming an already-active Epic instead of starting a second one, not by filesystem write arbitration). Cross-link back to session-manager-operations/architecture/project-pages-pipeline.md as the canonical spec.
- [ ] Update .claude/agents/project-home-builder.md's protocol step 3 to reference summaryValidate.ts by path and instruct the agent to run it (e.g. via a small node -e one-liner or a scripts/validate-project-pages-summary.cjs wrapper you add) against its own summary.json before proceeding to Stage 2/3 — add scripts/validate-project-pages-summary.cjs as a thin CLI wrapper around validateProjectPageSummary, printing errors and exiting 1 on failure, exiting 0 with 'valid' on success, following the same CLI-wrapper pattern as scripts/render-project-pages.cjs from PRD 929.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/lib/projectPages/__tests__/summaryValidate.test.ts passes

# Implementation notes

Depends on PRD 929 (929-project-pages-static-renderer) having landed its summaryType.ts — read that file's actual final shape rather than re-deriving it from the architecture spec's prose, since the type is the ground truth once it exists. This PRD does NOT implement summary synthesis itself (no code that reads brief.json/git and produces a real summary) — per the corrected architecture spec, that's done by the project-home-builder Epic's own session using its normal reasoning + Read tool, not by a script or backend call. This PRD's job is the validation contract + the artifact-folder documentation only. Existing precedent for artifact-folder READMEs to mirror in tone/structure: session-manager-operations/design-mocks/project-pages-component-library/README.md (written this session) and session-manager-operations/project-brief/README.md (for contrast — that one IS an OWNERS namespace, useful to read to see what NOT to claim here).

# Out of scope

- Actual summary synthesis logic/prompting — lives in the project-home-builder agent's own judgment at runtime, not in code.
- The selection scorer — separate PRD (project-pages-selection-scorer).
- Any Project Home UI — separate PRD.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
