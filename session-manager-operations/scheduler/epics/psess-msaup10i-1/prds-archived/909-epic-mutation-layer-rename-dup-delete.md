---
title: Epic rename/edit-goal/duplicate/delete — store + IPC mutation layer
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msaup10i-1
---
# Goal

Add three new mutations to the Epics store/persistence layer that the Epic queue row menu needs: renaming an Epic's title, editing its goal/first-prompt text, and duplicating an Epic as a fresh one. These back the row-menu actions being wired in a sibling PRD (epic-row-menu-wiring, depends on this one) — this PRD is backend-only, no new UI. Read src/renderer/state/promptSessions.ts in full first: it already has createPromptSession, approveProposed, markCompleted, resumeArchived, hydrate/hydrateArchived, appendPromptSessionEvent, and a persistActiveIndex-style tmp+rename write path guarded by an unawaited-round-trip serialization concern documented in its own comments (search for "resumeArchived's createPromptSession call immediately followed by" in that file) — any new write to prompt-sessions/active-index.json must go through the SAME serialized write path, not a parallel one, or it will race markCompleted/resumeArchived/hydrate.

# Acceptance criteria

- [ ] A new store action `renameEpic(promptSessionId: string, title: string, goal: string): Promise<void>` on usePromptSessions (state/promptSessions.ts) reconstructs `goalText` as `${title}\n\n${goal}` (matching the existing encoding read by EpicDetail.tsx's splitTitleAndGoal — do not introduce a separate title field, since every other reader of PromptSession.goalText assumes this encoding) and persists it through the SAME atomic write path markCompleted/resumeArchived already use for active-index.json, under the 'epics' writer per src/main/lib/opsOwnership.cjs.
- [ ] renameEpic rejects (throws, caught by the caller) when title.trim() is empty — an Epic must always have a non-empty title.
- [ ] CLAUDE.md's documented domain-model invariant "An Epic's title + objective are fixed for the life of its session, and are its first prompt" is updated in this PRD to add one sentence carving out: renaming is a cosmetic correction (typo/clarity) via the queue row menu, not a re-purposing of the Epic's goal — do not silently leave the invariant contradicted in the docs.
- [ ] A new store action `duplicateEpic(promptSessionId: string): PromptSession` creates a brand-new Epic via the EXISTING createPromptSession(cwd, goalText, tag, 'active') call (same cwd, same goalText, same tag as the source), minting a fresh id + claudeSessionId — it does NOT copy the source Epic's PRDs, thread/chat history, or scheduler jobs; the duplicate starts exactly like a hand-created Epic with that goal as its opening prompt (this mirrors the design mock's 'Duplicate as new Epic' intent, which mock-copies title only).
- [ ] A new store action `deleteEpic(promptSessionId: string): Promise<void>` removes the Epic from the in-memory `sessions`/`events` maps and persists the removal through the active-index.json write path. It THROWS with a clear message (does not silently no-op) if the target Epic currently has a 'running' or 'queued' scheduler job (join scheduleJobs on sourcePromptId — the caller/UI is responsible for surfacing this as a blocking error, this store action just enforces it) OR has a chat run in flight (useChat's running/queuedPosition for that id) — never deletes out from under live work.
- [ ] deleteEpic does not attempt to delete the Epic's on-disk PRD files or scheduler run logs — those stay on disk (a scheduler job/PRD card whose sourcePromptId no longer resolves to a live Epic must not crash any existing reader; verify by grepping for `.sourcePromptId` usages in src/renderer and confirming none assume the referenced Epic still exists in `sessions`).
- [ ] `timeout 120 npx vitest run src/renderer/components/epics/__tests__ src/renderer/state/__tests__/promptSessions*` passes (adjust the test glob to wherever promptSessions.ts's existing tests actually live — check first), and `npm run typecheck` passes.

# Implementation notes

Primary file: src/renderer/state/promptSessions.ts (already read in full during design-sync research this session — has createPromptSession ~line 270, approveProposed ~296, appendPromptSessionEvent ~305, markCompleted ~339, resumeArchived ~408, hydrate ~420, hydrateArchived ~495). Follow the exact persistence pattern markCompleted/resumeArchived already use (find the shared write helper they call for active-index.json — likely named something like persistActiveIndex or similar; grep for it) rather than inventing a second write path. Single-writer law: src/main/lib/opsOwnership.cjs — the 'epics' namespace already owns prompt-sessions/, so no new delegation entry is needed, just reuse the existing writer identifier the current mutations pass. CLAUDE.md's domain-model section (top-level project CLAUDE.md, "Domain model (TAB / EPIC)" section) has the exact sentence to amend — find it verbatim and add the carve-out sentence next to it, don't rewrite the surrounding paragraph. For the running-job guard in deleteEpic, the shape of a ScheduleJob and how to check status is in src/renderer/../preload/api.ts's ScheduleJob type and useScheduleState's snapshot.jobs (same shape EpicDetail.tsx already filters on: `scheduleJobs.filter((j) => j.sourcePromptId === epicId)`).

# Out of scope

- Any UI (buttons, modals, RowEditor) — that is epic-row-menu-wiring's job
- Cascading delete of PRD files, transcripts, or run logs on disk
- Carrying over PRDs/thread history into a duplicated Epic

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
