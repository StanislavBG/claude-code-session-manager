---
title: Stamp PRD check-in response events with their slug + outcome so the indicator survives into the archive
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
dependsOn: [972-notify-epic-prd-path-and-epicid-fallback, 974-epic-prd-chip-checkin-status-tone]
---
# Goal

A PRD's check-in arrives on the Epic's chain as a bare `response` event with only free text (`PromptSessionEvent`, `state/promptSessions.ts:125`) — no PRD slug, no outcome. `ResponseEvent` (`EpicDetail.tsx:99`) therefore renders every check-in as the same undifferentiated grey line, and once the job is archived out of `queue.json` there is no longer ANY way to recover whether that check-in was a success, a question, or a failure — the signal is permanently lost from the Epic's audit trail. Stamp the outcome onto the event at write time in the scheduler, and tone the rendered line green/yellow/red to match the chip from PRD 974.

# Acceptance criteria

- [ ] `PromptSessionEvent` (`src/renderer/state/promptSessions.ts:125`) gains two OPTIONAL fields, documented in the interface: `prdSlug?: string` — already declared for `prd_created`, so widen its doc comment to cover `response` too rather than adding a second field — and `outcome?: 'completed' | 'failed' | 'needs_review'`. Both optional so every pre-existing event on disk stays valid and renders in the current neutral style.
- [ ] `appendResponseEventIfKnown` (`src/main/promptSessionEvents.cjs:55`) accepts an optional 4th argument carrying `{ prdSlug, outcome }` and writes them onto the appended event when present. Its existing guards (active session, non-empty chain) and its `withPathLock` serialisation are unchanged.
- [ ] `notifyOriginatingTab` (`scheduler.cjs:1831`) passes `{ prdSlug: job.slug, outcome: job.status }` on every append. `notifyNeedsReview` (`scheduler.cjs:1913`) passes `{ prdSlug: job.slug, outcome: 'needs_review' }`.
- [ ] `ResponseEvent` (`EpicDetail.tsx:99`) tones its rendered line from `event.outcome` using the SAME `STATUS_TONE` map from `sched-primitives.tsx:212` that PRD 974 uses for the dispatch chip — green completed / yellow needs_review / red failed — and falls back to the current neutral `text-fg-faint` treatment when `outcome` is absent.
- [ ] When `event.prdSlug` is present the response line names the PRD and its outcome in its accessible text (e.g. `PRD 964-epic-detail-agent-readout — needs review`), so the state is readable without relying on colour. Existing expand/collapse behaviour (the truncated-text → `promptSessionTranscript.read` path at `EpicDetail.tsx:113-133`) is unchanged.
- [ ] New main-process test in `src/main/__tests__/promptSessionEvents.test.cjs`: appending with `{ prdSlug, outcome }` persists both onto the event in `active-index.json`; appending WITHOUT them persists an event with neither key set (not `undefined`-valued keys serialised into the JSON).
- [ ] New renderer test: a `response` event with `outcome: 'failed'` renders differently-labelled accessible text than one with `outcome: 'completed'`, and one with no `outcome` renders the current neutral form. Assert on accessible name/text, not Tailwind class strings.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Spans main + renderer. Read the appended standards file first.

DEPENDENCY: this PRD is gated on 972 (`notify-epic-prd-path-and-epicid-fallback`). Until 972 lands, `notifyOriginatingTab` never successfully appends a response event at all — resolving the PRD via the retired flat `scheduler/prds/` dir instead of `epics/<epicId>/prds/`, so `parsePrdRaw` ENOENTs and the append is skipped. Verify 972's fix is present in the working tree before starting; if response events are still not landing, stop and report rather than building an indicator over a dead channel.

Key files/lines:
- `src/renderer/state/promptSessions.ts:125` — `PromptSessionEvent`. Note `prdSlug` at :134 is already declared ("Required for kind: 'prd_created'") — widen that comment, do not add a parallel field.
- `src/main/promptSessionEvents.cjs:55` — `appendResponseEventIfKnown`, the sole main-process writer. It builds the event object at :68-75; add the two keys conditionally there. It writes through `config.writeJson(path, data, { writer: 'scheduler' })` — the single-writer law's declared writer for this delegated path; do NOT change that string.
- `src/main/scheduler.cjs:1863-1869` (notifyOriginatingTab's append) and `:1926` (notifyNeedsReview's append) — the two call sites. Both inject `appendResponseEvent` as a testable dep; preserve that shape.
- `src/renderer/components/epics/EpicDetail.tsx:99-160` — `ResponseEvent`, and `:736` where it is rendered.
- `src/renderer/state/promptSessions.ts` also archives events into `PromptSessionArchive` (`:82`) — no change needed, the new optional fields ride along automatically. Confirm that is true rather than assuming it.

Why this exists separately from 974: 974's chip reads the LIVE queue, which is correct and cheap but goes blank once a job is archived out of `queue.json`. This PRD makes the outcome durable on the Epic's own event chain, which is the auditable record. Both are wanted; they are not redundant.

Traffic-light semantics, identical to 974/975 — GREEN sage = completed, YELLOW butter = needs_review (Architect must act), RED accent = failed. No fourth state, no new palette entry.

# Out of scope

- Backfilling outcome onto response events already on disk
- Changing appendResponseEventIfKnown's active-session or non-empty-chain guards
- Any change to the archive file format beyond the two optional fields riding along
- Adding a toast or notification for failed check-ins

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
