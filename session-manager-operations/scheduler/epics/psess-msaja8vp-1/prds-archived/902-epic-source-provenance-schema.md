---
title: Epic source-provenance schema — structured field replacing markdown-embedded trace
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msaja8vp-1
---
# Goal

Add a structured, first-class `source` field to the Epic (`PromptSession`) type so any auto-created Epic carries a queryable trace of which producer created it — replacing today's practice of burying that info as markdown frontmatter text inside `openingPrompt`, which is invisible without opening and parsing the raw prompt body. This was discovered because a `proposed` Epic (`prd-894-home-global-controls-dashboard-needs-rev-b37bedf2`) had no visible trace of its origin from the Epics list — it was actually `rcaFeedbackHook.cjs`, but nothing on the Epic object said so. This PRD lands only the schema + plumbing to accept and persist it; wiring each producer to populate it is follow-up PRDs (899, 900) that depend on this one.

# Acceptance criteria

- [ ] Add `export interface EpicSource { producer: 'rca-hook' | 'feedback-sweep' | 'propose-epic' | 'scheduler-dispatch'; prdSlug?: string; runId?: string; sourceTabId?: string }` to `src/renderer/state/promptSessions.ts`, and add `source?: EpicSource` to the `PromptSession` interface (alongside the existing `tag?`/`openingPrompt?` optional fields, same doc-comment style: note it's written by `src/main/lib/epicMint.cjs` for auto-minted Epics and absent for human-created ones)
- [ ] Extend `ensureEpic(cwd, {...})` in `src/main/lib/epicMint.cjs` (currently `function ensureEpic(cwd, { goalText, tag, reuseByGoal = false, epicId: explicitEpicId, status = 'proposed', openingPrompt = null, mintIfMissing = true } = {})` at line 121) to accept an optional `source` param of the same `EpicSource` shape, and write it onto the minted `session` object exactly like the existing `...(tag ? { tag } : {})` spread pattern does — i.e. `...(source ? { source } : {})`
- [ ] Extend the `appendAuditEvent('epic_mint', ...)` call in epicMint.cjs (currently `appendAuditEvent('epic_mint', { cwd, epicId, status, tag: tag ?? null, goalText: session.goalText })`) to also pass `source: source ?? null`, so the machine-level audit log (`~/.claude/session-manager/audit-log.jsonl`, written by `src/main/lib/auditLog.cjs`) carries the same producer info as the Epic object — do not build a second, separate tracking mechanism; this one file (`auditLog.cjs`) already exists exactly for 'trace a rogue/unexpected Epic back to its origin' per its own header comment, so extend it rather than duplicating its purpose
- [ ] Update `session-manager-operations/prompt-sessions/README.md`'s `PromptSession` real-fields code block (currently listing id/cwd/goalText/claudeSessionId/status/createdAt/completedAt/resumedFromId/tag/openingPrompt) to include the new `source?: EpicSource` field with a one-line description, per this repo's CLAUDE.md rule that the README's schema block is the single place PromptSession's shape is documented
- [ ] New/updated unit test in `src/main/__tests__/epicMint.test.cjs` asserting: (a) `ensureEpic(cwd, { goalText: '...', source: { producer: 'rca-hook', prdSlug: 'x', runId: 'y' } })` persists `source` on the written `active-index.json` session record exactly as passed, (b) omitting `source` leaves the field absent (not `null` or `{}`) on the written record — matching the existing `...(tag ? {...} : {})` omission convention used elsewhere in this same function
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run src/main/__tests__/epicMint.test.cjs passes

# Implementation notes

Read `src/renderer/state/promptSessions.ts:10-40` (the `PromptSession` interface) and `src/main/lib/epicMint.cjs:121-203` (the `ensureEpic` function body, including the audit-log call at line 202) before writing any code — match the existing optional-field spread convention (`...(tag ? { tag } : {})`) exactly for `source` so the shape stays consistent with how `tag`/`openingPrompt` are already handled. Also check `src/main/ipcSchemas.cjs` for any zod schema that validates a `PromptSession`-shaped payload over IPC (grep `ipcSchemas.cjs` for `PromptSession` or `promptSession`) — if one exists, add `source` there too as optional; if none validates this shape today, say so in your commit and skip it (don't invent new IPC validation as scope creep). `EpicSource`'s field names deliberately reuse this codebase's existing correlation-id vocabulary (`prdSlug`, `runId`, `sourceTabId` already appear on scheduler job records in `src/main/scheduler.cjs` — see its job-shape fields `sourcePromptId`/`sourceTabId`/`epicId`) rather than inventing new terms.

# Out of scope

- Wiring any of the four ensureEpic() call sites (rcaFeedbackHook.cjs, scheduler.cjs, scripts/propose-epic.cjs, scripts/lib/watchdogHelpers.cjs) to actually populate `source` — that is PRDs 899 and 900, which depend on this one landing first
- Any UI change to display `source` in the Epics list/detail view — a separate follow-up, not bundled here
- The join-vs-mint distinctness gate (deciding when to reuse an existing Epic instead of minting) — that is PRD 898

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
