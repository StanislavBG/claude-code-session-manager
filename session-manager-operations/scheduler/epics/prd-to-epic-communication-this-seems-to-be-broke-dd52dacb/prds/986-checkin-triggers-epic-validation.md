---
title: A PRD check-in triggers validation in the authoring Epic — it never asserts the PRD is done
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
dependsOn: [985-notify-epic-prd-path-fix-redo]
---
# Goal

Today a PRD's check-in is an inert text line asserting an outcome the Epic has no reason to believe. PRD 972 proved why that is unsafe: it reported `completed`, shipped zero code, and the authoring Epic had no mechanism to notice. Invert the contract — a check-in is a REQUEST TO VALIDATE and carries no authority about whether the work landed. When a PRD checks in, the scheduler enqueues a validation prompt into the authoring Epic's own session instructing it to independently verify each acceptance criterion against the real working tree and answer VERIFIED or REFUTED with evidence. The job's self-reported status becomes an input to that check, never a substitute for it.

# Acceptance criteria

- [ ] `PromptSessionEvent` gains an optional `validation` field: `'unvalidated' | 'validating' | 'verified' | 'refuted'`. A response event stamped by the scheduler is born `'unvalidated'` — never `'verified'` — regardless of the job's own `outcome`. Absent on pre-existing events, which must keep rendering as they do today.
- [ ] On a successful `appendResponseEventIfKnown` for a terminal PRD outcome, the scheduler enqueues ONE validation prompt into the authoring Epic's session via `enqueueExternalPrompt(epicId, prompt)` (`chatRunner.cjs:821`). The prompt must: name the PRD slug and the absolute path to its .md; state the job's self-reported outcome explicitly labelled as an unverified claim; instruct the session to read the PRD's own Acceptance Criteria and check each one against the actual working tree; and require a reply of VERIFIED or REFUTED with per-criterion evidence (file:line or command output).
- [ ] The prompt explicitly warns against the failure mode that produced this PRD: an exit code of 0, a green queue row, or a confident completion report are NOT evidence — only the working tree is. Instruct it to run `git diff --stat` for the run window and treat an empty diff on an implementation PRD as REFUTED.
- [ ] LOOP GUARD: the validation reply must not itself trigger another validation. Assert this with a test — an appended event that is a validation result never enqueues a further prompt. State in a code comment how the guard distinguishes the two.
- [ ] GATING, all four required: never fire for an Epic whose status is not `active`; never fire more than once per (epicId, prdSlug) pair; respect the machine-wide session slot pool (`lib/sessionSlots.cjs`, cap 3) rather than spawning outside it; and honour a kill-switch env var (name it in the code comment, following the `SM_DOD_DISABLE` precedent) so this can be turned off without a code change.
- [ ] Fire-and-forget and non-blocking, mirroring the existing `notifyOriginatingTab` call convention at `scheduler.cjs:3057-3061` — a failure to enqueue is logged, never thrown, and never blocks the job's status transition or the response-event append.
- [ ] New unit tests: (a) a completed check-in enqueues exactly one validation prompt naming the PRD slug; (b) a check-in for a non-active Epic enqueues nothing; (c) a second check-in for the same (epicId, prdSlug) enqueues nothing; (d) the enqueued prompt contains the PRD's absolute path and the VERIFIED/REFUTED instruction; (e) the loop guard from AC #4.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Main-process, plus the one shared type. Read the appended standards file first.

DEPENDENCY: gated on 985 (`notify-epic-prd-path-fix-redo`). Until 985 lands, `appendResponseEventIfKnown` is never reached for completed/failed jobs at all, so there is no check-in to hang this off. Verify a response event actually lands before building on it; if it does not, stop and report rather than building over a dead channel. (PRD 976 already made this mistake once.)

WHY THIS EXISTS — the motivating incident, worth reading in full: PRD 972 ran 34 s, made zero edits, and exited 0. Its own `verdicts.json` flagged `no_verdict_sentinel` / `downgradeTo: needs_review`, and the queue recorded `completed` anyway. Three layers of scheduler-side automation failed to stop it. The lesson is not "add a fourth scheduler check" — it is that the party with the context to judge whether the work is right is the Epic that WROTE the PRD, and it was never asked.

Key files/lines:
- `src/main/promptSessionEvents.cjs:55` — `appendResponseEventIfKnown`, the check-in sink. PRD 976 already added an optional 4th metadata arg (`prdSlug`/`outcome`); extend that, do not add a fifth positional parameter.
- `src/main/chatRunner.cjs:821` — `enqueueExternalPrompt(tabId, prompt)`, which broadcasts `chat:external-send`. The renderer already resolves that target id against known Epics as well as open tabs (see the resolution-order doc comment at `scheduler.cjs:1800-1830`), so an Epic id is a valid target — confirm this against the renderer handler before relying on it.
- `src/main/scheduler.cjs:1863-1869` and `:1926` — the two append call sites.
- `src/main/lib/sessionSlots.cjs` — the ≤3 concurrent `claude -p` pool. Per CLAUDE.md's "Avoid" section, exceeding 3 concurrent claude processes OOM-killed Electron on 2026-06-10; a validation prompt per check-in is exactly the kind of fan-out that could reintroduce that, which is why the slot-pool AC is non-negotiable.
- `src/main/lib/dodDrainHook.cjs` — precedent for a fire-and-forget, kill-switched, idempotent hook. Follow its shape.

Cost note: this spends tokens per PRD check-in. That is the intended trade — the alternative is what already happened, a silently-unfixed bug shipped green. The once-per-(epicId, prdSlug) rule and the kill-switch are what keep it bounded; do not weaken either.

Do NOT create an Epic from this path. `epicMint.cjs`'s SINGLE-CREATOR LAW is fail-closed and this is a join-only consumer — if no active authoring Epic exists, log and do nothing.

# Out of scope

- Creating an Epic when none exists
- Any renderer surfacing of the validation state (that is the sibling PRD)
- Changing runVerify.cjs, the commit guard, or the DoD gate
- Auto-fixing a REFUTED PRD — this PRD only asks the question and records the answer
- Removing the existing scheduler-side verification (it stays as defence in depth)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
