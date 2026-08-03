---
title: Refactor ProjectHome.tsx to host the generated HTML with one "Generate My Project Home" action
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 28
sourcePromptId: psess-mscgxoqw-7
dependsOn: [project-pages-brief-lens, project-home-shipped-default-html]
---
# Goal

Replace ProjectHome.tsx's stacked hand-built React block layout with the architecture the human decided in Epic "Project Home Layout": the page's primary content is the generated (or shipped-default) static HTML document, hosted at a fixed location and displayed through the existing sandboxed iframe; a single "Generate My Project Home" action replaces it by creating/resuming a project-home-builder Epic. This fixes the original complaint that Project Home reads as multiple unrelated pages stitched together with two competing Generate CTAs.

# Acceptance criteria

- [ ] Core: src/renderer/components/tabs/projecthome/ProjectHome.tsx's main content area renders the hosted HTML document (generated home.html, or the shipped default from PRD 970) via the same sandboxed-iframe approach ProjectPagesSection.tsx already uses — reuse that mechanism, do not write a second iframe implementation.
- [ ] Core: exactly ONE primary generate action exists on the page, labeled "Generate My Project Home", which creates or resumes an Epic tagged project-home-builder bound to the project-home-builder agent. Reuse ProjectPagesSection.tsx's existing findActiveBuilderEpic + composeEpicIntake + approveProposed flow verbatim — it already implements the resume-don't-duplicate rule the pipeline spec requires. The separate "Refresh brief" button is removed from the page (brief.json remains an INPUT to generation; it just no longer has its own user-facing button — see PRD 968's spec text).
- [ ] Core: the page shows document provenance — whether the reader is looking at the shipped default or a generated document, and when it was generated — using the isDefault/generatedAt fields PRD 970 adds to the IPC payload. Do not infer provenance in the renderer.
- [ ] Core: the live blocks stay live React and are rendered as a compact strip ABOVE the hosted document: PhNow ("What is in flight") and PhOpenQuestions ("Waiting on you"). These must NOT be moved into the static HTML — a static document cannot show running-right-now state truthfully. Everything else that ProjectHome.tsx renders by hand today (PhHeader's brief purpose/provenance chips, PhWhat, PhAreas, PhScope, PhConventions) is now the brief lens's job and is REMOVED from ProjectHome.tsx.
- [ ] Core: the now-unused hand-built block components and their helpers are deleted rather than left dead — PhWhat, PhAreas, PhScope, PhConventions, PhMd, PhEditToggle, PhListEditor, useBlockEditor, BlockEditor and any import that becomes unused (per this repo's no-backwards-compat-shims convention). Verify with a grep that nothing else imports them before deleting.
- [ ] Edge case: the per-block Edit/Pin affordances the deleted components provided (window.api.projectBrief.update / setPin, which pin a block so a refresh cannot overwrite it) disappear from the UI with those components. Do NOT silently drop the capability — either keep a path to it or state explicitly in the completion notes that pin/edit is no longer reachable from the UI and that projectBrief.update/setPin are now unreferenced by the renderer, so a follow-up decision is needed. Report which you did; do not leave it ambiguous.
- [ ] Edge case: a project whose brief.json does not exist yet must still render (the shipped default covers this) — verify no crash and no blank page in that state.
- [ ] Interaction / integration: ProjectPagesSection's own lens tab bar (marketing/feature/architecture/brief + the About-these-templates explainer) still works and is reachable. Decide and implement how it relates to the main hosted document now that 'home' is the page itself rather than one tab among five — state the choice and rationale in the completion notes. Do not leave two competing viewers for the same home.html on one page.
- [ ] Interaction / integration: the answerInEpic deep-link from PhOpenQuestions (setPendingPromptSessionId + sm:navigate) still works after the refactor.
- [ ] Tests: timeout 300 npm run typecheck passes; timeout 300 npm run test:unit passes; npm run lint:selectors passes. Update or remove src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx, which tests the old no-brief-yet empty state that no longer exists once a default always renders.
- [ ] Tests: zustand selector safety — this file already follows the EMPTY_JOBS module-constant pattern to avoid returning freshly-built values from a selector (a documented cause of app-wide blank screens in this repo). Preserve that discipline in any new/changed selector; npm run lint:selectors passing is necessary but confirm by reading the diff too.

# Implementation notes

Read session-manager-operations/architecture/project-pages-pipeline.md FIRST (rewritten by sibling PRD 968) — it is the authoritative description of this design and wins over this PRD's wording if they disagree. Then read both sibling PRDs' landed output: PRD 969 added the `brief` lens (library/briefSlots.tsx, render.tsx, projectPages.cjs LENSES, preload types), PRD 970 added the shipped default + the isDefault provenance field on the IPC payload. Build on their REAL landed state, not on the plan for them — check what actually exists before assuming.

Current file, verified 2026-08-03: src/renderer/components/tabs/projecthome/ProjectHome.tsx is 655 lines. Structure: module-level EMPTY_JOBS constant; helpers projectNameFromCwd/answerInEpic; components PhNow, PhOpenQuestions, PhMd, PhHeader, PhEditToggle, PhListEditor, PhWhat, PhAreas, PhScope, PhConventions; the BlockEditor interface + useBlockEditor hook; then the exported ProjectHome() which loads brief via window.api.projectBrief.get(cwd), handles refresh/pin, and renders header → refreshing banner → PhNow → (brief ? What/Areas/Scope/Conventions+OpenQuestions+footer : OpenQuestions + generate-brief empty state) → <ProjectPagesSection cwd={...} />.

The iframe + Epic-creation mechanism to REUSE (do not reimplement) is in src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx: BUILDER_TAG/BUILDER_AGENT_NAME constants, findActiveBuilderEpic(sessions, cwd), the builderPersona lookup via window.api.agents.listPersonas(), composeEpicIntake({title,goal,tag,agentName,agentDescription}), createPromptSession + approveProposed, navigateToEpic. If the cleanest result is to lift that shared logic into a small module both files use, do that rather than copy-pasting it — this repo's API-reuse standard applies.

Shared block chrome lives in ./ph-primitives.tsx (PhBlock, PhCard) — after deleting most blocks, check whether PhBlock/PhCard are still used by the survivors (PhNow/PhOpenQuestions both use PhBlock; PhNow uses PhCard) and keep only what is still referenced.

This is the PRD that actually fixes the human's original complaint ("it feels like multiple pages one after the other"). Optimize the surviving layout for that: one live strip, one hosted document, one generate action, one provenance line — not a new stack of sections.

# Out of scope

- Changing the generated documents' own internal design (that is the component library's job)
- Re-adding any deterministic variant selection
- Moving ProjectPagesSection to its own top-level nav destination
- Building new pin/edit UI to replace what is removed — report the gap, do not design a replacement in this PRD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
