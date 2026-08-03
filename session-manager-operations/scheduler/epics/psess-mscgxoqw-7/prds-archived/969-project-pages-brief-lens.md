---
title: Add the 5th "brief" lens to the Project Pages component library and render pipeline
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-mscgxoqw-7
dependsOn: [project-home-hosted-html-spec]
---
# Goal

Add a 5th lens, `brief`, to the Project Pages component library so the Brief's synthesized content (brief.json's purpose/what/areas/scope/conventions) becomes a generated static page instead of a hand-built React block stack in ProjectHome.tsx. This is the library/render half of the Project Home refactor decided in Epic "Project Home Layout" — it adds the lens end to end (summary fields, slot components, render output, IPC read, preload type) but does NOT yet change ProjectHome.tsx's own layout, which is a sibling PRD.

# Acceptance criteria

- [ ] src/renderer/lib/projectPages/summaryType.ts gains the fields the brief lens renders from, mirroring ProjectBrief's shape: at minimum `brief` with purpose (string), what (string[]), areas (array of {name, files, note, epic, heat}), scope (array of {when, kind, text, src}), conventions (string[]). Match the existing naming style in that file (short keys where the existing types use them, e.g. ProjectPageStat's v/k/n) but do NOT rename or change any existing field — this is purely additive.
- [ ] src/renderer/lib/projectPages/summaryValidate.ts is extended to validate the new brief fields with the same never-fabricate/placeholder-rejection discipline it already applies to existing fields, and the new fields are OPTIONAL at the validator level (a project whose brief.json has not been generated yet must still produce a valid summary.json) — add a test asserting both the present and absent cases pass validation and that a placeholder value fails.
- [ ] New file src/renderer/lib/projectPages/library/briefSlots.tsx exports PAGE_BRIEF: PageLensDef following the exact same shape as homeSlots.tsx (id, label, blurb, slots[], presets[]). It must define at least 3 slots covering the brief's real content — suggested: `purpose` (the project's purpose + what-this-is prose), `areas` (how it's put together), `scope` (how the goal has moved) — plus `conventions`. Each slot has at least 2 genuinely different variants (not a cosmetic duplicate), and the lens ships at least 2 presets (v1, v2) picking a full set. Build every component from the kit primitives in library/kit.tsx (PK, PkSection, PkEyebrow, PkH, PkBody, PkPill, PkCmd) — never inline new raw styling conventions or invent a second design kit.
- [ ] src/renderer/lib/projectPages/library/index.ts registers the new lens: LensId union gains 'brief', LENS_LIBRARY gains brief: PAGE_BRIEF, and LENS_ORDER includes it. Decide and document in a one-line comment where 'brief' sits in LENS_ORDER and why.
- [ ] src/renderer/lib/projectPages/render.tsx's renderProjectPages return type and implementation include `brief` alongside home/marketing/feature/architecture, producing a 5th self-contained static HTML string with the same zero-network/inline-CSS guarantees as the other four.
- [ ] src/main/projectPages.cjs's LENSES array includes 'brief' and get() returns it in the output object. IMPORTANT: get() currently returns null (the empty-state signal) if ANY lens html file is missing — adding a 5th lens means every project with existing 4-lens output would suddenly read as having NO output at all. Handle this explicitly: either treat a missing brief.html as tolerable (return the lenses that exist) or document why a hard reset is correct; whichever you choose, add a test covering the 4-files-present-but-brief-missing case so the regression is impossible to reintroduce silently.
- [ ] src/preload's ProjectPagesOutput interface gains `brief: string` (or an optional/nullable form consistent with whatever missing-file behavior the previous criterion settled on) and the renderer compiles against it.
- [ ] src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx's LENS_OPTIONS / VIEW_OPTIONS gain the brief lens so it is selectable in the existing tab bar (this is the minimum wiring so the new lens is reachable and testable; the larger ProjectHome.tsx layout refactor is a sibling PRD and is NOT part of this one).
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 300 npm run test:unit passes, including the new validator and projectPages.cjs tests added above.
- [ ] npm run lint:selectors passes.

# Implementation notes

Read session-manager-operations/architecture/project-pages-pipeline.md FIRST — sibling PRD 968 (project-home-hosted-html-spec) rewrites it to specify this 5-lens design and names the brief lens's exact source fields; that text is authoritative over anything in this PRD if the two disagree.

Pattern to copy, verbatim in shape: src/renderer/lib/projectPages/library/homeSlots.tsx is the smallest existing lens (2 slots, 2 variants each, 2 presets) and is the best template — it was authored directly rather than ported from a design mock, so it shows the hand-authored path this PRD also takes. Read library/kit.tsx for the available primitives before writing any component; read library/types.ts for the PageLensDef/SlotDef/VariantDef/PresetDef contracts.

The content this lens renders corresponds 1:1 to what ProjectHome.tsx renders today in PhWhat (brief.what paragraphs), PhAreas (brief.areas table with name/files/note/epic/heat), PhScope (brief.scope timeline with when/kind/text/src), and PhConventions (brief.conventions checklist). Read src/renderer/components/tabs/projecthome/ProjectHome.tsx to see exactly which fields each block uses — reuse those field semantics rather than inventing a parallel shape, and reuse existing view helpers' logic where it makes sense (src/renderer/lib/projectBriefView.ts has heatPercent, scopeTone, safeList, tokenizeMd) — note those return Tailwind class names in some cases, which will NOT work inside the static HTML (inline styles only), so port the LOGIC, not the class strings.

Do NOT render PhNow (live Epic queue) or PhOpenQuestions (live unresolved questions) into this lens — they are live data and a static HTML page cannot show them truthfully; the spec states they stay live React. This is a hard boundary, not a nice-to-have.

Never fabricate: every brief-lens field traces to brief.json. If brief.json has no scope entries, the scope slot renders an honest empty/omitted state rather than invented history.

# Out of scope

- Refactoring ProjectHome.tsx's own layout to host the HTML as its main content (sibling PRD 970)
- Creating the shipped default home.html build asset (sibling PRD 970)
- Editing .claude/agents/project-home-builder.md (sibling PRD 969)
- Changing the marketing/feature/architecture lenses
- Removing PhWhat/PhAreas/PhScope/PhConventions from ProjectHome.tsx — leave them in place; the layout swap is the sibling PRD's job

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
