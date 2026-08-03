---
title: Green means the Epic verified it — retarget the traffic light from the job's claim to the Epic's verdict
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 50
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
dependsOn: [986-checkin-triggers-epic-validation]
---
# Goal

PRDs 974/975/976 shipped a green/yellow/red traffic light across the Epic timeline chip, the Epic-row rollup and the response event — but all three derive their colour from the JOB's self-reported status, which is exactly the value that lied for PRD 972 (reported completed, shipped nothing). Retarget every one of those surfaces onto the Epic's own validation verdict from PRD 986, and introduce a distinct not-yet-validated tone so a PRD that merely CLAIMS success can never render green. Green must mean "the authoring Epic checked the acceptance criteria and confirmed them", nothing weaker.

# Acceptance criteria

- [ ] A new neutral 'claimed' tone is added for `validation: 'unvalidated'` — visually distinct from both green and from queued/running, reading as "reported done, not yet checked". Define it once in `sched-primitives.tsx`'s `STATUS_TONE` and reuse; do not add a per-component tone map.
- [ ] Colour mapping across ALL THREE surfaces, driven by the event's `validation` field first and the job's `outcome` only as a tiebreak: `verified` → green; `refuted` → red; `validating` → the existing running/in-flight treatment; `unvalidated` → the new neutral claimed tone; a job `outcome` of `failed` or `needs_review` → red / yellow as today (a job that admits it failed needs no validation to be believed).
- [ ] A job whose `outcome` is `completed` but whose `validation` is `unvalidated` renders in the CLAIMED tone — never green. This is the single most important line in this PRD; assert it with a dedicated test named for it.
- [ ] The three surfaces retargeted are: the `prd_created` dispatch chip in `EpicDetail.tsx` (shipped by PRD 974, commit e62bd4f), the `ResponseEvent` line (shipped by PRD 976, commit 5ff20ea), and `epicDisplayStatus`'s rollup in `epicDerive.ts` (shipped by PRD 975, commit 870ac00). Modify those existing implementations in place — do not add a parallel second indicator alongside them.
- [ ] `epicDisplayStatus` gains a `refuted` display state ranked ABOVE `failed` in its precedence chain: a PRD that claimed success and was caught not delivering is the single most urgent thing an Architect can be shown, more urgent than one that failed honestly. Document that rationale in the doc comment.
- [ ] Every indicator states its validation state in its accessible name / tooltip (e.g. `PRD 972 — reported completed, not yet verified by this Epic`). Colour is never the only carrier — the same accessibility rule PRDs 974/975/976 already follow.
- [ ] New tests cover, on each of the three surfaces: verified → green, refuted → red, unvalidated-but-outcome-completed → claimed tone. Assert on accessible text, not Tailwind class strings.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Renderer-only (plus reading the type PRD 986 adds). Read the appended standards file first.

DEPENDENCY: gated on 986, which adds the `validation` field and populates it. Confirm that field exists and is being written before starting; if it is not, stop and report rather than inventing a placeholder — an indicator over an unpopulated field is worse than no indicator, because it reads as authoritative.

Key files/lines (all three already exist and ship the job-status-derived version):
- `src/renderer/components/epics/EpicDetail.tsx` — the `prd_created` dispatch chip and `ResponseEvent`. `scheduleJobs` is already bound at ~:351; reuse it, and do NOT add a second `useScheduleState` call.
- `src/renderer/lib/epicDerive.ts` — `EpicDisplayStatus` and `epicDisplayStatus`, which PRD 975 extended with `failed`/`attention`.
- `src/renderer/components/epics/epic-primitives.tsx:11` — the Epic-row `STATUS_TONE`.
- `src/renderer/components/tabs/scheduler/sched-primitives.tsx:212` — the PRD `STATUS_TONE` and `prdStatusFor`. Single source of truth for PRD tone; add the claimed tone here.

CRITICAL — zustand selector rule (CLAUDE.md "Avoid"): never return a freshly-built value from a selector (`.filter(...)`, `.map(...)`, `?? []` inline). Select the raw slice and derive after, using a module-level stable constant like the existing `EMPTY_JOBS`. Three blank-app incidents in this repo trace to this exact mistake; `npm run lint:selectors` guards it.

THE POINT, so the executor does not optimise it away: the previous traffic light was accurate about the wrong thing. It faithfully reported the queue's opinion, and the queue's opinion was wrong. This PRD moves the signal to the only party that actually inspected the work. A PRD sitting in the CLAIMED tone for a long time is INFORMATION (nobody validated it), not a bug in this feature — do not "fix" it by defaulting unvalidated to green.

Keep the total palette at four states plus the existing in-flight treatments. Do not invent a fifth colour.

# Out of scope

- Adding a second/parallel indicator alongside the existing ones
- Any main-process change (986 owns the data)
- Auto-triggering validation from the renderer
- Adding a new Tailwind palette colour
- Filter/sort controls for the new states

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
