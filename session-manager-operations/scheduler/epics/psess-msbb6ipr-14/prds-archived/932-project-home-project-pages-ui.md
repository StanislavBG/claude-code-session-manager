---
title: Project Home — Generate Now empty state + Project Pages display
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: psess-msbb6ipr-14
dependsOn: [929-project-pages-static-renderer]
---
# Goal

Wire Project Home's Stage 4 display: before any Project Pages exist for the active project, show an empty state with a "Generate Now" button; clicking it creates (or resumes, if one is already active for this project) an Epic tagged project-home-builder and navigates to it, exactly like every other Epic in this app. Once session-manager-operations/project-pages/output/*.html exists on disk, Project Home instead shows the 3 generated pages in a sandboxed iframe with a lens toggle (Marketing/Feature/Architecture) and a Regenerate button that resumes/creates the same kind of Epic. The renderer cannot read files directly (this app's architecture: renderer never touches disk) so this PRD adds one new small main-process IPC surface to read the output files + manifest.

# Acceptance criteria

- [ ] ## Epic tag creation UI
- [ ] In src/renderer/lib/agentTagDefs.ts, add 'project-home-builder' to AGENT_TAG_ORDER (it currently only has ['feature','bug','discussion'] with 'build' and 'project-home-builder' deliberately excluded pending this PRD — read the comment above AGENT_TAG_ORDER before editing) SPECIFICALLY for use by the Generate Now button's own Epic-creation call, NOT by exposing a new option in the New Epic composer's form (do not touch NewEpicCard.tsx's KIND_OPTIONS or any user-facing tag picker — this tag is created programmatically only, never hand-picked in the New Epic form, verify no other file reads AGENT_TAG_ORDER to populate a user-facing picker before assuming this is safe to add; if one does, add a narrower export instead of widening AGENT_TAG_ORDER, and say so in the PR).
- [ ] ## Main process IPC (read-only)
- [ ] Add a new IPC handler (follow projectBrief.cjs's get() pattern in src/main/projectBrief.cjs for structure/registration style) e.g. `projectPages:get` in a new src/main/projectPages.cjs: given a cwd, reads session-manager-operations/project-pages/output/manifest.json and the 3 HTML files if present, returns `{ output: { marketing: string; feature: string; architecture: string; generatedAt: string } | null }` (null output when no manifest/files exist yet — this is the empty-state signal). Register in src/main/index.cjs following the existing registerXHandlers() pattern. Uses config.cjs path validation (validatePath, allowedRoots = home dir) exactly like every other main-process fs read — do not bypass it.
- [ ] Expose via src/preload/index.cjs and type it in src/preload/api.d.ts (`window.api.projectPages.get(cwd): Promise<ProjectPagesGetResult>`) following the exact naming/shape convention projectBrief's preload surface already uses.
- [ ] ## Project Home UI
- [ ] In src/renderer/components/tabs/projecthome/, add a new section (new file, e.g. projectpages/ProjectPagesSection.tsx, imported into ProjectHome.tsx) rendered ABOVE or BELOW the existing Brief blocks (do not remove/restyle anything already in ProjectHome.tsx) that: on mount/cwd-change, calls window.api.projectPages.get(cwd); if output is null, shows an empty state (reuse components/ui/EmptyState.tsx or PhBlock/PhCard from ./ph-primitives.tsx for visual consistency, matching ProjectHome.tsx's existing 'no brief yet' empty state pattern) with a 'Generate Now' button; if output is present, shows a 3-way ViewTabs (components/ui/ViewTabs.tsx) toggling which lens's HTML renders in a sandboxed `<iframe sandbox="allow-same-origin" srcDoc={html} style={{width:'100%', border:'none'}} />` sized to a reasonable min-height (e.g. 600px, or use an onLoad height-adjustment if straightforward — do not over-engineer this), plus a 'Regenerate' button.
- [ ] 'Generate Now' and 'Regenerate' both: check src/renderer/state/promptSessions.ts's existing active-Epics state for one already tagged project-home-builder for this cwd with status 'active' — if found, resume it (navigate to it, same as clicking an existing Epic row) instead of creating a new one; otherwise create a new Epic via the SAME creation path New Epic uses (read src/renderer/lib/epicIntake.ts's composeEpicIntake + wherever NewEpicCard.tsx calls the actual create-and-start action in state/promptSessions.ts, and call that same action programmatically) with tag: 'project-home-builder' and a fixed goal text (e.g. 'Generate this project\'s Project Pages (Marketing/Feature/Architecture).') — do not hand-roll a second Epic-creation code path; reuse the existing one.
- [ ] New unit test(s) covering: the empty-state renders when projectPages.get resolves { output: null }; the iframe display renders when output is present, with the correct html string passed as srcDoc for the active lens; clicking Generate Now with no existing project-home-builder Epic calls the create-and-start action with tag 'project-home-builder'; clicking it when one already exists (mock promptSessions state) navigates to the existing one instead of creating a second (mock the relevant state/promptSessions.ts exports — follow this repo's existing test patterns for ProjectHome-adjacent components, e.g. src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx, for how mocking is done here).
- [ ] timeout 300 npm run typecheck passes
- [ ] node scripts/check-unstable-selectors.cjs passes (this repo's zustand-selector-stability lint — do not select a freshly-built array/object/filter result directly in a component; select the raw slice and derive after, per CLAUDE.md's 'Avoid' section)
- [ ] timeout 300 npm run test:unit passes (full suite, not just the new file — confirm no regression in existing ProjectHome/promptSessions tests)

# Implementation notes

Depends on PRD 929 for the exact output/manifest.json shape (read scripts/render-project-pages.cjs's actual manifest.json field names once landed, don't guess). Does NOT strictly need PRD 930/931 to be functionally complete to ship (this PRD can be tested end-to-end with a hand-written stub output/*.html + manifest.json on disk) but the full pipeline (930, 931) should exist for Generate Now to actually be useful once a human clicks it inside the created Epic. Read src/renderer/components/tabs/projecthome/ProjectHome.tsx in full first — it already has the exact 'no brief yet empty state vs. populated state' shape this PRD needs to mirror for Project Pages, including PhHeader's refresh-button pattern (refreshing state, spinner, disabled-while-refreshing) worth reusing for Regenerate's button state (though Regenerate here navigates to an Epic rather than blocking inline — no long-running wait needed in this component). Read src/renderer/state/promptSessions.ts and src/renderer/components/tabs/epics/NewEpicCard.tsx (or wherever 'create Epic and start it' actually lives) to find the exact action name/signature to call programmatically — CLAUDE.md's domain model section states 'submitting the first prompt in the New Epic flow IS the proposed→active transition' so the action you call must both create the Epic AND send its opening prompt, not just create a proposed stub. sandbox=\"allow-same-origin\" without allow-scripts is deliberate — the generated HTML has no <script> tags (enforced by PRD 929's own test), so scripts stay disabled; do not add allow-scripts.

# Out of scope

- Auto-refresh/polling for when a project-home-builder Epic completes in the background — the user navigates into the Epic and back to Project Home manually for v1; a live 'Epic is generating...' banner is a plausible future PRD, not required here.
- Screenshot capture wiring.
- Any change to the New Epic composer's user-facing form.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
