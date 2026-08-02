---
title: Epic row-menu + quote-reply — test coverage and manual verification pass
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msaup10i-1
dependsOn: [epic-mutation-layer-rename-dup-delete, epic-row-menu-wiring, epic-composer-quote-reply]
---
# Goal

Add automated test coverage for the Epic queue row menu (all 8 actions: Copy Epic ID, Mark completed, Resume in terminal — landed 2026-08-01 with zero direct test coverage — plus Rename, Edit goal, Duplicate, Delete, Reopen from the two dependency PRDs) and for Composer quote-reply. None of this has any test today; existing tests only cover the pre-existing EpicQueue/EpicQueueControls behavior (search/filter/group/sort/pin/paging/keyboard nav) and would pass unchanged even if the whole row menu were broken.

# Acceptance criteria

- [ ] Read src/renderer/components/epics/__tests__/*.spec.* (whatever the existing test file(s) for EpicQueue are named — check first) to match the existing test setup/mocking conventions (how usePromptSessions/useEpicTerminal/toast are mocked or seeded) rather than inventing a new pattern.
- [ ] New tests (in the existing epics __tests__ directory, new file(s) as appropriate) cover: the row menu opens on trigger click and closes on outside click / Escape; each of the 8 menu items is present with correct visibility rules (e.g. Reopen only for a completed Epic, Mark completed hidden once already completed); clicking Copy Epic ID calls navigator.clipboard.writeText with the epic's id; clicking Mark completed calls the store's markCompleted; clicking Resume in terminal calls useEpicTerminal's setMode with 'terminal'; the Rename/Edit-goal RowEditor opens inline, Save is disabled until dirty+non-empty title, Save calls renameEpic, Cancel/Escape discards without calling it; Duplicate calls duplicateEpic and selects the returned Epic; Delete requires the two-step confirm before calling deleteEpic, and a thrown deleteEpic error surfaces via toast.error and does not remove the row; Reopen calls resumeArchived.
- [ ] New tests for Composer quote-reply: clicking a turn's Quote button (via the onQuote prop path) shows the reply-context strip in EpicComposer with the quoted text; the X button and a successful send both clear it.
- [ ] Run the FULL suite, not just the new files: `timeout 300 npx vitest run src/renderer/components/epics` and `npm run typecheck` both pass, plus `node scripts/check-unstable-selectors.cjs`.
- [ ] Manual verification: start the dev app (`npm run dev` in the background with a bounded timeout, or reuse whatever this project's `run` skill/pattern already does for Electron — check session-manager-operations or CLAUDE.md for an established launch pattern first rather than improvising a new one) and, in the Epics workspace, actually click through: open the row menu on a real Epic, rename it, edit its goal, duplicate it, mark one completed then reopen it, delete one (confirm step included), and quote a turn into the composer. Capture screenshots of at least: the open row menu, the RowEditor mid-edit, the delete confirm state, and the quote-reply strip. This step exists because typecheck/unit-tests passing green does not by itself prove a button renders or a modal actually opens — confirm it does before calling this PRD done.
- [ ] Report in the PRD's own finish output which of the above screenshots were captured and where, and note explicitly if the app could not be launched headlessly (e.g. no display available) rather than skipping this AC silently.

# Implementation notes

This PRD runs LAST (depends on all three others) — by the time it executes, EpicQueue.tsx has the full 8-item menu + RowEditor, and EpicComposer.tsx/ChatTranscriptTurn.tsx have the quote-reply wiring. Read the actual landed diffs in those files first rather than assuming the exact shape described in the sibling PRDs' goals, since execution may have adjusted small details. For the manual-verification step, this is an Electron app — check whether `npm run test:e2e`'s Playwright + xvfb-run setup (mentioned in this repo's CLAUDE.md) is reusable for a quick manual screenshot pass instead of hand-rolling a new launch method.

# Out of scope

- Any new product behavior beyond what the three dependency PRDs already built — this PRD only tests and verifies
- Visual/design polish beyond what's needed to confirm the feature works

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
