---
title: Project Home brief blocks — header, synthesized sections, pins, refresh
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
dependsOn: [837-project-brief-backend-ipc, 838-project-home-nav-scaffold]
---

# Goal

Render the synthesized Brief in `src/renderer/components/tabs/projecthome/ProjectHome.tsx` on top of PRD 837's backend: the header card (purpose h1, Refresh button with spinner + in-progress banner, "synthesized X ago / by <model>" line, "read from" source chips with drift marks), and the synthesized blocks **What this is** (pinnable), **How it is put together** (areas table with heat bars), **How the goal has moved** (scope timeline), **Conventions Claude follows** (pinnable) side-by-side with PRD 839's "Waiting on you" block, plus the mock's footer note. Includes the no-brief-yet "Generate the brief" empty state.

Previous links landed: PRD 837 → `window.api.projectBrief.{get,refresh,setPin}` (get returns `{ brief|null, sources[] }`; refresh is slot-gated and single-in-flight; brief.json schema is in the DESIGN_SPEC), PRD 838 → the routed `ProjectHome.tsx` scaffold, PRD 839 → live blocks + `ph-primitives.tsx` block chrome. Read their landed files first and compose — do not re-derive what they built.

# Acceptance criteria

## Core functionality

- [ ] On mount / active-cwd change, `ProjectHome` calls `projectBrief.get(cwd)`; header card renders the brief's `purpose` as the serif h1 (falls back to the project folder name when brief is null), the "synthesized <relative> / by <model>" mono line, and one chip per `sources[]` entry (label + detail; drifted chips get a tinted border + "newer than brief" mono mark per the mock).
- [ ] Refresh button: accent, disabled + spinner while a refresh is in flight; triggers `projectBrief.refresh(cwd)`, shows the mock's tinted banner ("A headless session is re-reading CLAUDE.md, the Epic archive and recent commits. Pinned blocks are left untouched.") while running, re-fetches on completion; errors (including "no session slot free" and "refresh already running") surface via `useToast().show('error', …)` — never swallowed.
- [ ] Synthesized blocks render from the brief per the mock: "What this is" paragraphs through a mini-markdown renderer supporting only `**bold**` and `` `code` `` spans (port the mock's `PhMd` split-regex approach; no dangerouslySetInnerHTML); areas table rows (name, N files, note | "touched by <epic>" or "no open Epic" | heat bar 0–100 using accent at reduced opacity); scope timeline rows (when, kind pill tinted via the existing `delta-good`/`delta-bad`/`honey` token families for added/narrowed/decided, text, "from <src>").
- [ ] Pin toggles on "What this is" and "Conventions" call `projectBrief.setPin` and reflect `brief.pins`; pinned state shows the accent pin affordance with the mock's tooltips ("Pinned — refreshes will not overwrite this" / "Pin so refreshes leave it alone").
- [ ] No brief yet: header card + a centered "Generate the brief" CTA (same code path as Refresh); PRD 839's live blocks still render above/below per the spec's layout order; footer note paragraph present (adapted: regeneration is on-demand only — do not promise the every-tenth-turn trigger).

## Edge cases

- [ ] brief null + refresh failing (e.g. app offline slot error) leaves the page usable: CTA re-enabled, toast shown, live blocks unaffected; malformed brief (missing arrays) renders the present blocks and skips absent ones without crashing (defensive defaults in one place).

## Tests

- [ ] Pure helpers (mini-markdown tokenizer, scope-kind → tone mapping, source-chip formatting) live in `src/renderer/lib/projectBriefView.ts` with vitest coverage: `timeout 120 npx vitest run src/renderer/lib/__tests__/projectBriefView.test.ts` passes.
- [ ] `timeout 120 npm run lint:selectors` passes; `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` ("Surface 2") and the decoded `project-home-mock.jsx` (PhHeader/PhBlock/PhAreas/PhScope/PhMd) first; translate every hex to Tailwind tokens (paper→bg, card→bg-hi, rule→rule, accent→accent; the tinted refresh banner and question cards use the accent-muted/`accent`-family tokens, NOT the mock's `#fbeee9`). Local component state for in-flight refresh is fine (this is pane-local UI state, not a store concern). IPC results are plain promises — no new zustand store; keep fetch state in the component with a `cancelled` guard like `Home.tsx`'s `useRecentSessions`.

# Out of scope

- Backend changes (837 owns `projectBrief.cjs`; if its API surface differs from this PRD's expectation, adapt the renderer to the landed API — do not edit main-process code).
- Auto-refresh triggers, per-block regeneration granularity beyond the two pins.

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
