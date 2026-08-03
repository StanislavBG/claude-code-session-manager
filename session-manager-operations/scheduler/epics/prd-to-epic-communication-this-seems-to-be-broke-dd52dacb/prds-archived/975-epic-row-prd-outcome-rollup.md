---
title: Surface failed / needs_review PRDs in the Epic row's rollup status so the Architect can triage 62 Epics at a glance
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

`epicDisplayStatus` (`src/renderer/lib/epicDerive.ts:44`) inspects each Epic's jobs for `running` and `pending` only — it never checks `failed` or `needs_review`. So an Epic whose PRD came back broken, or parked asking a question, falls all the way through to the resting `'active'` state and renders with the same grey dot as an Epic that is simply idle. With 62 active Epics in this project, the Architect has no way to spot which ones are waiting on them without opening each one. Add two new display states so a PRD's bad outcome rolls up onto the Epic row as red and yellow, using the vocabulary already defined in `epic-primitives.tsx`'s STATUS_TONE.

# Acceptance criteria

- [ ] `EpicDisplayStatus` (`epicDerive.ts:25`) gains two members: `'failed'` and `'attention'` (the latter covering a PRD parked in `needs_review`). Do not overload the existing `'needs'` member — that one specifically means a CHAT run stopped on `<<<SM_NEEDS_INPUT>>>`, a different signal with a different remedy, and conflating them would make the row lie about what action is required.
- [ ] `epicDisplayStatus` precedence is explicit and documented in its doc comment. Required order, highest first: `completed` → `proposed` → `needs` (chat needs-input) → `failed` (any job with status 'failed') → `attention` (any job with status 'needs_review') → `running` → `queued` → `active`. Rationale to record in the comment: a terminal bad outcome outranks an in-flight run because a later PRD running does not discharge the Architect's obligation to deal with the one that already broke.
- [ ] `epic-primitives.tsx`'s `STATUS_TONE` (line 11) gains matching entries: `failed` → `bg-accent/15` / `text-accent` / dot `bg-accent`, label `'failed'`; `attention` → `bg-butter/25` / `text-fg-dim` / dot `bg-butter`, label `'needs review'`. Reuse the palette tokens already present in that file and in `sched-primitives.tsx`'s STATUS_TONE — no new Tailwind colours.
- [ ] `epicQueuedDetail`'s sibling detail-text mechanism is extended (or an equivalent added) so a `failed`/`attention` Epic's chip tooltip names the responsible PRD slug, e.g. `needs review — PRD 964-epic-detail-agent-readout is asking a question`. Colour alone must not be the only carrier of the signal.
- [ ] Every exhaustive switch/`Record<EpicDisplayStatus, ...>` over the union compiles — `npm run typecheck` passes with no `as any` or index-signature widening added to silence a missing case.
- [ ] New unit tests in `src/renderer/lib/__tests__/` for `epicDisplayStatus` covering: a job with status 'failed' → 'failed'; a job with 'needs_review' → 'attention'; a failed job AND a running job together → 'failed' (precedence); a chat needs-input AND a failed job together → 'needs' (precedence); an archived/completed session with a failed job → 'completed' (precedence).
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Renderer-only. Read the appended standards file first.

Key files/lines:
- `src/renderer/lib/epicDerive.ts:25` (`EpicDisplayStatus` union), `:44` (`epicDisplayStatus`), `:84` (`epicQueuedDetail`) — the derivation layer.
- `src/renderer/components/epics/epic-primitives.tsx:11` `STATUS_TONE`, `:31` `epicStatusDotClass`, `:35` `epicStatusLabel`, `:39` `EpicStatusChip` — the presentation layer. `STATUS_TONE` is typed `Record<EpicDisplayStatus, ...>` so widening the union will surface every site that must be updated; let the compiler drive the change rather than grepping.
- `src/renderer/components/epics/EpicQueue.tsx` consumes these at :580 (dot), :628 (left rail), :631 (chip), :741-743 (status bucketing/grouping), :812, :851. Note :741 buckets Epics BY display status for the grouped view — confirm the two new statuses group sensibly there and appear near the top of the list, since they are the states the Architect most needs to see. Adjust the group ordering if the new buckets land below `completed`.
- The `snapshots.jobs` array is `ScheduleJob[]` from `state/scheduleState.ts`; `sourcePromptId` is the Epic FK (already used at `epicDerive.ts:56`).

Traffic-light semantics, identical to PRD 974's (keep them consistent):
- GREEN (sage) = completed / clean.
- YELLOW (butter) = needs_review — a question came back; the primary "Architect must act" state.
- RED (accent) = failed — broken; must be re-scoped or re-queued.

Note on dependency: this reads the live queue snapshot directly, so it works whether or not PRD 972's notification fix has landed. It is independent of 974 (different file, different surface) but shares the colour vocabulary — if 974 lands first, match whatever it settled on rather than diverging.

# Out of scope

- Any main-process / scheduler.cjs change
- Changing the PromptSessionEvent schema (that is PRD 975)
- The in-timeline PRD chip (that is PRD 974)
- Adding a filter/sort control for the new statuses
- Adding a new Tailwind palette colour

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
