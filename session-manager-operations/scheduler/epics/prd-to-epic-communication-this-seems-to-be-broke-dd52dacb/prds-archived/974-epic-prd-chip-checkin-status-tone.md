---
title: Colour the Epic timeline's PRD-dispatch chip by that PRD's live check-in status
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 35
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

In an Epic's Discussion timeline, a dispatched PRD renders as a flat neutral pill — "→ dispatched to PRD #NNN" (`EpicDetail.tsx:722-733`) — that looks identical whether the PRD is still queued, finished clean, came back with a question, or failed outright. The Architect scrolling an Epic cannot tell which of its PRDs have checked back in, let alone which need action. Give that chip the traffic-light tone the rest of the app already uses: green = completed, yellow = needs_review (a question came back — act), red = failed (act), plus the existing neutral/running treatments for not-yet-checked-in. This reads the live queue snapshot that is ALREADY in scope in that component, so it needs no new plumbing and does not depend on the notification fix in PRD 972.

# Acceptance criteria

- [ ] The `prd_created` chip in `EpicDetail.tsx` resolves its PRD's job from the `scheduleJobs` snapshot already bound at `EpicDetail.tsx:351` (match on `job.slug === e.prdSlug`) and derives a display status via the EXISTING `prdStatusFor(job)` helper from `sched-primitives.tsx:246`.
- [ ] Chip tone is taken from the EXISTING `STATUS_TONE` map in `src/renderer/components/tabs/scheduler/sched-primitives.tsx:212` — no new colour table, no new hex values, no per-component tone map. Concretely: completed → sage/green, needs_review → butter/yellow, failed → accent/red, running → filled accent, queued/ready → the existing neutral bordered treatment.
- [ ] A PRD with NO matching queue row (already archived out of the queue, or a pre-existing chip from an older Epic) renders in the current neutral bordered style and does not crash — `prdStatusFor(null)` already returns 'ready', so this must be the fallback path, not a special case.
- [ ] The chip's `title` tooltip and `aria-label` both state the PRD's status in words (e.g. `PRD "964-epic-detail-agent-readout" — needs review — open in Scheduler`) so the signal is not colour-only — accessibility requirement, not optional polish.
- [ ] The chip's existing click behaviour (`openPrdSlug(e.prdSlug!)` → open that PRD in Scheduler) is unchanged.
- [ ] New tests in `src/renderer/components/epics/__tests__/EpicDetail.test.tsx` (or a sibling) assert the rendered chip for four cases — completed, needs_review, failed, and no-matching-job — by asserting on the accessible name/tooltip text, NOT on Tailwind class strings.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

This is a renderer-only change. Read `session-manager-operations/architecture/` and the appended standards file first.

Key files/lines:
- `src/renderer/components/epics/EpicDetail.tsx:722-733` — the chip to restyle. Note `scheduleJobs` is already selected at :351 (`useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS`) and `prds` / `snapshots` are built at :451 — reuse those, do NOT add a second `useScheduleState` call.
- `src/renderer/components/tabs/scheduler/sched-primitives.tsx:212` `STATUS_TONE`, `:238` `PrdDisplayStatus`, `:246` `prdStatusFor` — the single source of truth for PRD status colour and wording. `EpicDetail.tsx:10` already imports `PrdStatusPill`, `SchBadge`, `verdictLabel` and `PrdDisplayStatus` from it, so the import line likely just needs `prdStatusFor` added.
- Check whether the existing exported `PrdStatusPill` can be reused directly inside the chip button (preferred — one fewer bespoke element) before hand-rolling tone classes. Reuse beats re-implementation here.

CRITICAL — zustand selector rule (see CLAUDE.md "Avoid"): do NOT write a selector that returns a freshly-built value (`.filter(...)`, `.map(...)`, `?? []` inline). Select the raw slice and derive afterwards, exactly as :351 already does with the module-level `EMPTY_JOBS` constant. This repo has had three blank-app incidents from this exact mistake and `npm run lint:selectors` guards it.

Colour semantics to apply consistently (these are the project's traffic-light definitions and PRDs 974/975 depend on the same three):
- GREEN (sage) = `completed` — checked in clean, nothing for the Architect to do.
- YELLOW (butter) = `needs_review` — checked in carrying a QUESTION; this is the primary "Architect must act" state.
- RED (accent) = `failed` — checked in broken; must be re-scoped or re-queued.
- Neutral / pulsing accent = pending / running — has not checked in yet.

Do not invent a fourth state or a fourth colour.

# Out of scope

- Any main-process / scheduler.cjs change
- Changing the PromptSessionEvent schema (that is PRD 975)
- The Epic-row rollup indicator (that is PRD 974)
- Restyling the ResponseEvent component
- Adding a new colour palette entry to Tailwind config

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
