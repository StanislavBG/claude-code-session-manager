---
title: Epic queue row menu — rename/edit-goal RowEditor, duplicate, delete confirm, reopen
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 22
sourcePromptId: psess-msaup10i-1
dependsOn: [epic-mutation-layer-rename-dup-delete]
---
# Goal

Extend the Epic queue row's overflow menu (src/renderer/components/epics/EpicQueue.tsx — RowMenuButton/RowMenu/useRowMenuItems, landed 2026-08-01 with Copy Epic ID / Mark completed / Resume in terminal only) with the remaining design-mock actions: Rename title, Edit goal, Duplicate as new Epic, Delete Epic (with a confirm step), and Reopen (for a completed Epic). Consumes the renameEpic/duplicateEpic/deleteEpic store actions added by epic-mutation-layer-rename-dup-delete (already landed by the time this PRD runs, per dependsOn) — read that PRD's landed diff in src/renderer/state/promptSessions.ts before starting.

# Acceptance criteria

- [ ] Selecting "Rename title" or "Edit goal / first prompt" from the row menu replaces that row (in place, not a separate modal) with a RowEditor: a title text input + a goal textarea (prefilled via EpicDetail.tsx's existing splitTitleAndGoal helper on the epic's current goalText), a Save button disabled until the title is non-empty AND something changed, and a Cancel button; ⌘+Enter saves, Escape cancels. Save calls the new renameEpic(id, title, goal) store action.
- [ ] "Duplicate as new Epic" calls duplicateEpic(id) and selects the resulting new Epic (calls the existing onSelect callback with the new id) so the user lands on it immediately.
- [ ] "Delete Epic" is styled as a danger item (reuse the existing `danger` MenuItem flag already supported by RowMenu) and, when clicked, shows a confirm step before calling deleteEpic — either a second confirm click inside the same menu (e.g. item flips to "Click again to delete…" for ~3s) or a small inline confirm popover; no native `window.confirm`. If deleteEpic throws (blocked by a running/queued job, per epic-mutation-layer-rename-dup-delete's guard), surface the thrown message via the existing toast.error(...) pattern already used elsewhere in this file, not a silent failure.
- [ ] "Reopen" appears in the menu only for a completed/archived Epic and calls the EXISTING resumeArchived(epic.id) store action (already used by EpicDetail.tsx's Resume button for the same purpose) — no new store code needed for this item, just wiring.
- [ ] All five new items are added to the SAME useRowMenuItems()/RowMenuButton flow already landed in EpicQueue.tsx — do not create a second parallel menu component.
- [ ] `npm run typecheck` and `node scripts/check-unstable-selectors.cjs` both pass; `timeout 120 npx vitest run src/renderer/components/epics/__tests__` passes (new tests for these 5 actions are epic-row-menu-test-coverage's job, not this PRD's — just don't break the existing 72).

# Implementation notes

Primary file: src/renderer/components/epics/EpicQueue.tsx (already has RowMenuButton, RowMenu, useRowMenuItems, MenuItem type, DotsIcon from the 2026-08-01 session). RowEditor should follow the design mock's shape documented in session-manager-operations/design-mocks/epics/epics-mock.jsx's comment block (title input + goal textarea, ⌘↵ save / esc cancel) — read that file and DESIGN_SPEC.md first for the full row-menu action list and status of what's already landed vs pending. splitTitleAndGoal lives in src/renderer/components/epics/EpicDetail.tsx (search for that function name) — either import/export it from there or lift it to a shared lib if EpicQueue.tsx can't cleanly import from EpicDetail.tsx (check for circular-import risk first). Toast pattern: `import { toast } from '../../state/toast'` then `toast.error(message)` / `toast.info(message)` — already used in EpicQueue.tsx's Copy Epic ID handler.

# Out of scope

- New store mutations (epic-mutation-layer-rename-dup-delete's job)
- Automated test coverage for these new actions (epic-row-menu-test-coverage's job)
- Composer quote-reply (separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
