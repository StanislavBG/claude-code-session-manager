---
title: Spec: Project Home becomes hosted generated HTML with a shipped default + 5th "brief" lens
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-mscgxoqw-7
---
# Goal

Rewrite session-manager-operations/architecture/project-pages-pipeline.md to specify the architecture the human decided in Epic "Project Home Layout" (2026-08-03): Project Home is no longer a hand-built React page that happens to embed a Project Pages viewer at the bottom. Instead, Project Home's primary content IS a generated static HTML document hosted at a fixed location, session-manager ships with a default version of that HTML so a brand-new project is never empty, and a "Generate My Project Home" button replaces it by creating an Epic bound to the project-home-builder agent + tag. The Brief's synthesized content (purpose/what/areas/scope/conventions from brief.json) becomes a 5th generated lens, "brief", instead of a separate hand-built React block stack. This PRD is docs-only and lands first because this repo treats the architecture spec as the source of truth that code follows.

# Acceptance criteria

- [ ] session-manager-operations/architecture/project-pages-pipeline.md gains a new top section (before the existing Stage sections) titled something like "Project Home is a hosted document, not a React page" stating: (a) Project Home's main content area renders a generated, self-contained static HTML document via the existing sandboxed-iframe mechanism; (b) that document lives at a FIXED path, session-manager-operations/project-pages/output/home.html, which is what the app always reads for the main view; (c) the app SHIPS a default home.html baked into the build so a project with no generated output still renders a real page rather than an empty state; (d) the only way that document is replaced is a "Generate My Project Home" action which creates (or resumes) an Epic tagged project-home-builder bound to the project-home-builder agent — never an inline function call or main-process claude -p spawn.
- [ ] The spec's lens list is updated from 4 lenses to 5 everywhere it is enumerated (currently 'home / marketing / feature / architecture' appears in the intro paragraph, the Inputs section item 1, Stage 0's renderProjectPages signature, Stage 3, and Stage 4). The new 5th lens is `brief`, described as the generated form of what the live React Brief used to render by hand: brief.json's purpose/what/areas/scope/conventions. Its source fields must be named explicitly so a later PRD can implement it without guessing.
- [ ] The spec states explicitly which parts of today's ProjectHome.tsx are NOT consolidated into the brief lens because they are live and a static page cannot show them truthfully: PhNow ("What is in flight", live Epic queue status) and PhOpenQuestions ("Waiting on you", live unresolved questions). Specify that these remain live React, rendered as a thin strip ABOVE the hosted HTML document — and state the reason: injecting live data into the generated HTML would violate the existing 'self-contained static HTML, immune to the app's own React/Tailwind drift' non-negotiable that this same spec already states.
- [ ] The spec describes the shipped-default home.html's provenance and constraints: it is a build-time asset (not per-project state), it must be honest about being a default (it describes what Project Home is and prompts the reader to press "Generate My Project Home"; it must NOT contain fabricated project-specific content, per this spec's existing never-fabricate rule), and the app falls back to it whenever the per-project output/home.html is absent.
- [ ] The spec's Stage 4 section is rewritten so the empty state is no longer 'centered explainer + Generate Now button' — with a shipped default there is no truly empty state for the main view. Describe instead: default-vs-generated is a provenance distinction the UI should surface (e.g. a chip saying whether this is the shipped default or a generated document, and when it was generated), with the "Generate My Project Home" action always available.
- [ ] The spec resolves the existing two-competing-CTAs problem the human raised: today there is a 'Refresh brief' button (regenerates brief.json for the React blocks) AND a separate 'Generate Now'/'Regenerate' button (regenerates the Project Pages HTML). State that these consolidate into the single "Generate My Project Home" action, since the brief's content is now one of the generated lenses — and note what that implies for projectBrief.refresh (brief.json is still an INPUT to the generation, so the mechanism stays; it just stops having its own separate user-facing button).
- [ ] The spec explicitly addresses the stale-picks hazard found on 2026-08-03: session-manager-operations/project-pages/picks.json currently contains preset-v1 picks written by the now-deleted deterministic scorer, and the 'preserve existing hand-picks on regenerate' rule would grandfather them in forever, silently defeating agent-owned selection. Specify how a first-run-after-the-change is handled (e.g. a schemaVersion/provenance field in picks.json distinguishing scorer-era picks from agent/human picks, with scorer-era treated as non-authoritative and re-judged once).
- [ ] grep the finished file for '4 lenses', 'three lenses', '3 files', 'four lenses' and confirm no stale count remains contradicting the new 5-lens design.
- [ ] git diff shows only session-manager-operations/architecture/project-pages-pipeline.md changed — this PRD writes no code and does not edit .claude/agents/project-home-builder.md (that is PRD 969's job).

# Implementation notes

Read session-manager-operations/architecture/project-pages-pipeline.md in FULL first — it is long and the 4-lens count plus the old 'Project Home's own live Brief dashboard stays a separate hand-built React view above the generated block' framing appears in several places including a dated 'Correction, 2026-08-02' block near the top. That correction block is now itself superseded; add a new dated correction rather than silently rewriting history (the file's existing convention is to append dated corrections — follow it).

Real current state, verified 2026-08-03, so you do not have to rediscover it:
- src/main/projectPages.cjs has `const LENSES = ['home', 'marketing', 'feature', 'architecture'];` and returns null (the empty-state signal) if ANY lens html or the manifest is missing. Reading output dir: `path.join(cwd, 'session-manager-operations', 'project-pages', 'output')`.
- src/renderer/lib/projectPages/render.tsx's renderProjectPages returns `{ home, marketing, feature, architecture }` (line ~96).
- The component library lives at src/renderer/lib/projectPages/library/{homeSlots,marketingSlots,featureSlots,architectureSlots,kit,types,index}.tsx; index.ts exports LENS_LIBRARY (Record<LensId, PageLensDef>) and LENS_ORDER.
- src/renderer/components/tabs/projecthome/ProjectHome.tsx is the live React page (PhHeader/PhNow/PhWhat/PhAreas/PhScope/PhConventions/PhOpenQuestions + ProjectPagesSection at the bottom).
- The 'Generate Now' Epic-creation flow already exists and is correct — see ProjectPagesSection.tsx's findActiveBuilderEpic + composeEpicIntake usage with BUILDER_TAG='project-home-builder' and BUILDER_AGENT_NAME='project-home-builder'. The new "Generate My Project Home" button reuses this exact mechanism; the spec should say so rather than describing a new one.
- brief.json's shape (the input for the new `brief` lens) is ProjectBrief in src/preload's api types: purpose, what[], areas[], scope[], conventions[], pins, model, synthesizedAt, editedAt.

This is a specification-writing task, not an implementation task. Be concrete and decision-complete: three sibling PRDs (968, 969, 970) implement against this text, so any question you leave open becomes a guess someone else makes. Where a choice is genuinely open, pick one and state it as decided, with a one-line rationale.

# Out of scope

- Any code change whatsoever
- Editing .claude/agents/project-home-builder.md (PRD 969)
- Building the brief lens's slot components or the shipped default HTML (PRDs 968/970)
- Redesigning the marketing/feature/architecture lenses' own content

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
