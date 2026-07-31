---
title: Rename Left Nav "Terminal" → "Projects" + prompt-session list view
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Link 2/5. Rename the Left Nav's `terminal` item to "Projects" and replace its landing content
with a list of `PromptSession` records (from PRD 802,
`~/.claude/session-manager/scheduled-plans/prds/802-prompt-session-data-model-referential-chain.md`)
grouped by `cwd`, so each row represents one independent goal-oriented prompt/session the user
can jump into — "Each Prompt/Project in reality is an independent session that the user can jump
into to converse" (explicit user framing). This is the new primary entry point that replaces
today's single continuous per-tab Chat/PROMPT QUEUE view for this purpose.

# Acceptance criteria

- [ ] `src/renderer/lib/navGroups.ts:27-31` — the `key: 'terminal'` entry's `label` changes from
  "Terminal" to "Projects" (keep the `key` value `'terminal'` unchanged to avoid an unrelated
  routing/rename churn — only the user-facing label and hint text change)
- [ ] The view rendered for this nav item shows `PromptSession[]` (from
  `src/renderer/state/promptSessions.ts`, PRD 802) grouped by `cwd`, each group showing its
  project path once and each `PromptSession` row beneath showing `goalText` (truncated) +
  `status` (active/completed badge) + `createdAt`
- [ ] Active (`status: 'active'`) sessions are visually distinguished from completed/archived
  ones; completed ones read from persisted history once PRD 806 lands (out of scope here to wire
  the read path — this PRD only needs to render whatever `promptSessions.ts` currently returns,
  which for now is in-memory active sessions only)
- [ ] A "New starting prompt" action creates a `PromptSession` via `createPromptSession(cwd,
  goalText)` (PRD 802) for a chosen/current project cwd and adds it to the list — but does NOT
  yet open a conversation view (that's PRD 804); clicking a row after creation may show a
  placeholder/stub until PRD 804 lands
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A component/unit test asserts: sessions render grouped by cwd, active vs completed
  styling differs, and the "New starting prompt" action calls `createPromptSession` with the
  correct cwd and goal text

# Implementation notes

Read PRD 802's actual landed diff first (`src/renderer/state/promptSessions.ts` export names may
have shifted during its execution). Read `src/renderer/lib/navGroups.ts` in full and
`src/renderer/components/layout/AlmanacSidebar.tsx` (renders `NAV_ITEMS` filtered by group,
~lines 35-36) to understand how nav item → view routing works today before changing it. Look at
`src/renderer/components/tabs/ProjectsWorkspace.tsx` and `src/renderer/lib/useKnownProjects.ts`
for the existing "list of projects, grouped/keyed by cwd" pattern already used elsewhere in this
app (API-reuse standard — don't reinvent cwd-grouping display logic if a usable pattern already
exists there). Do not remove or repurpose the existing `terminal` nav item's `key` — only its
label/content.

This is link 2 of the 5-PRD chain (802-806). PRD 804 (next) builds the actual scoped Agent
conversation view that a row's click opens into, with no top TabBar and no right nav.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- The scoped Agent conversation view itself (PRD 804)
- Removing the right-nav `ChatSessionRail` from the existing per-tab Chat view (PRD 804)
- Persistence/archive read path (PRD 806)
- Any change to the existing per-tab Chat/PROMPT QUEUE view's own behavior — it keeps working
  as-is until PRD 804 supersedes its role for goal-scoped work
