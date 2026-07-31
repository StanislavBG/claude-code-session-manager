---
title: Skills tab — show each skill/command's description directly in the sidebar row
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Implement the design already built and browser-verified in Claude Design (project "Session
Manager", file `List Detail - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=List+Detail+-+Guided.html).

`src/renderer/components/tabs/Skills.tsx`'s sidebar list (the `ListDetail` `sidebar` prop, lines
~261-339) renders each skill/command as a bare name button — no description at all. Each skill's
real one-line description already exists in its own `SKILL.md` frontmatter `description:` field
(the same field this repo's `/develop`-style skills all carry) but is never read or shown in this
list — a first-time user sees a list of skill names with zero indication of what any of them do
until they open one into the markdown editor.

# Acceptance criteria

- [ ] Extend the `Item` interface (`Skills.tsx:28-38`) with an optional `description?: string`.
  When enumerating skills (the `useEffect` at lines 56-127), parse the `description:` frontmatter
  field out of each `SKILL.md` (reuse whatever frontmatter-parsing helper this repo already has —
  search for one before writing a new parser; `readSkillDisabled`/`setSkillDisabled`
  (`lib/skillFrontmatter.ts`) already parse this same file's frontmatter for the
  `disable-model-invocation` field, so extend that module to also extract `description` rather
  than writing a second, parallel frontmatter reader).
  Commands (`.md` files with no frontmatter contract) don't need this — leave `description`
  undefined for `kind === 'commands'` unless a similar convention already exists for them (check
  before assuming there's nothing to show).
- [ ] In the sidebar row rendering (`Skills.tsx:283-332`), show `i.description` as a small, muted,
  single-line-clamped text directly under the name (matching the verified mockup's row layout) —
  only when present; a command or skill missing a description just shows the name as today, no
  placeholder text.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a test (search `find src/renderer -iname '*skills*spec*' -o -iname
  '*skillfrontmatter*spec*'` first) asserting a `SKILL.md` with a `description:` frontmatter
  field renders that text in the row, and one without renders no description line. Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/tabs/Skills.tsx` and `src/renderer/lib/skillFrontmatter.ts` in
  full first — this is additive (one more field read + one more line of UI), not a restructure
  of the enumeration/toggle/remove logic.
- The verified mockup shows the exact row layout (name + badge inline, description below) to
  match.

# Out of scope

- Do not change the toggle/remove/save mechanics.
- Do not add descriptions for slash commands unless an existing convention for that already
  exists — confirm, don't invent one.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
