---
title: Epic Queue "Build" toolbar action — one-click fresh Builder Epic
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msase2q4-1
dependsOn: [build-tag-and-target-config, builder-skill-package]
---
# Goal

Add a toolbar-level "Build" action to the Epic Queue (`src/renderer/components/epics/EpicQueue.tsx`) that, on click, creates a brand-new Epic tagged `build` with a fixed `openingPrompt` invoking the `/builder` skill, and immediately auto-submits it (same `proposed → active` transition `NewEpicCard`'s submit already performs) so a genuinely fresh, isolated agent session (new `claudeSessionId`, zero shared context with whatever Epic/tab is currently open) starts running the git-diff→publish loop right away. This is a toolbar action, not a per-row action — Builder isn't scoped to any single existing Epic.

# Acceptance criteria

- [ ] New toolbar button/icon in `EpicQueue.tsx`'s header area (near the existing `epics.length` counter, see the component's current header markup), labeled "Build" or similar, styled consistently with this repo's existing toolbar/row-action visual language (reuse existing button primitives — do not introduce a new button component)
- [ ] Clicking it calls the SAME creation path `NewEpicCard`'s submit uses (read `src/renderer/components/epics/NewEpicCard.tsx` first to find the exact store action/IPC call it makes on submit — reuse that function, do not reimplement Epic creation) with: `tag: 'build'`, a fixed `goalText`/`openingPrompt` of `"/builder\n\nCheck git vs the published package for this project, decide the right version bump, and publish if there's anything new."`, and `cwd` set to the CURRENT active project TAB's cwd (not hardcoded to session-manager — this button should work correctly in any project TAB that has this app's Epic Queue, once this repo's own build ships it)
- [ ] The created Epic mints its own fresh `claudeSessionId` via the existing Epic-creation path (verify by inspecting `active-index.json` after a manual test click — the new Epic's `claudeSessionId` must NOT match any currently-open tab's session id)
- [ ] If `resolveBuildTarget(cwd)` (from `src/main/lib/buildTarget.cjs`, added by the `build-tag-and-target-config` PRD in this Epic) returns `null` for the active project (no config and no auto-discoverable npm package.json), the button is disabled with a tooltip explaining why, rather than creating an Epic that will immediately fail to find a publish target
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A test in `src/renderer/components/epics/__tests__/EpicQueue.test.tsx` (create if it doesn't exist, following the pattern of an existing sibling test e.g. `__tests__/EpicsWorkspace.test.tsx`) covers: button renders, click invokes Epic creation with `tag: 'build'`, button is disabled when `resolveBuildTarget` returns null for the active project

# Implementation notes

Read `src/renderer/components/epics/NewEpicCard.tsx` in full before starting — per this repo's CLAUDE.md, "The New Epic card composes both [title + objective] through lib/epicIntake.ts and sends the objective into the Epic's session at creation" — reuse `lib/epicIntake.ts` rather than hand-rolling a second Epic-creation code path; two independent paths that could drift is exactly the kind of duplication this project's CLAUDE.md warns against ("No backwards-compat shims... just rename and refactor" / API-reuse standard in `plugins/session-manager-dev/skills/develop/standards.md`). The `/builder` skill this button's opening prompt invokes is authored by the `builder-skill-package` PRD in this same Epic — confirm it landed at `plugins/session-manager-dev/skills/builder/SKILL.md` before wiring the prompt text.

# Out of scope

- A dropdown of configuration options on the button (registry choice, bump-policy override) — v1 is a single one-click action using whatever build-target.json / auto-discovery already resolves
- Per-row Build action on an existing Epic — toolbar-only, since Builder isn't scoped to one Epic
- Any change to how build-tagged Epics render once created — they use the same Epic UI as every other tag

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
