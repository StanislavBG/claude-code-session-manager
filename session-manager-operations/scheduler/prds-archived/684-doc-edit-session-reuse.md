---
title: Route Document Experience edits through the project's existing dormant chat session when one exists
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

**Depends on PRD 679 (`679-doc-voice-edit-context-pipeline.md`) — do not start until it has
landed** (this PRD's renderer changes assume `useDocEdit(path, documentText)`'s two-arg
signature from 679 already exists; if 679 hasn't merged, `git log --oneline -- src/renderer/components/tabs/editor/useDocEdit.ts`
to confirm before proceeding, and halt with `SCHEDULER_VERDICT: FAIL blocked-on-679` if it
hasn't).

Today every Document Experience edit (`docedit:run` → `src/main/docEdit.cjs`'s `runDocEdit`)
spawns a brand-new, context-free `claude -p` process — even when the user already has an active
conversation open elsewhere in the app for the same project. That conversation's context (design
decisions discussed, prior instructions, file familiarity already built up) never reaches the doc
edit, and the edit's own context never reaches back into that conversation either — two isolated
context pools for what is, to the user, one continuous piece of work.

This PRD makes the doc edit **append itself as one more turn onto an already-open, currently-idle
chat session for the same project**, when one exists, instead of always spawning an isolated
process — so the edit is grounded in everything already discussed in that session, and the
session's own transcript (not a second store) is where that context lives. `src/main/chatRunner.cjs`
already has the exact mechanism for this: `probeContextUsage` (`chatRunner.cjs:179-206`) fires a
**silent, resumed** one-shot turn — `run({ tabId, sessionId, resume: true, silent: true,
onSilentResult })` — against an existing session without disturbing the chat UI, and parses a
structured result back out of the reply text in the callback. Reuse that exact pattern for doc
edits; do not build a second resume mechanism.

**Never target a live interactive terminal's session.** `claudeSessionId` (raw pty) and
`chatSessionId` (headless chat) are deliberately kept separate in this codebase specifically
because two processes attached to the same session id collide ("Session ID `<uuid>` is already
in use" — see the comment on `chatSessionId` in `src/renderer/state/sessions.ts:10-19`). This PRD
must only ever resume a tab's `chatSessionId`, and only when that tab's `status === 'dormant'`
(no live pty attached to it).

# Acceptance criteria

- [ ] Add a pure selector (co-locate with `useDocEdit.ts` or in a small new
  `src/renderer/components/tabs/editor/findBackgroundSession.ts`, whichever keeps the hook
  readable — executor's call) that, given the current file's project `cwd`, the full
  `useSessions.getState().tabs` list, and `useLive.getState().tabs`, returns the single best
  candidate tab: filter to `tabs` where `cwd === targetCwd && status === 'dormant'`, then pick the
  one with the highest `useLive().tabs[tab.id]?.lastEventAt ?? 0` (ties: first in array order).
  Returns `null` if no dormant tab matches. Unit test this selector directly (pure function, no
  IO) — cases: no matching cwd → null; one dormant match → that tab; two dormant matches with
  different `lastEventAt` → the more recent one; a `running`/`spawning`/`exited` tab for the same
  cwd must never be picked even if its `lastEventAt` is higher.
- [ ] Determine the file's "project cwd" the same way the rest of the app already scopes a file to
  a project (search for how `EditorView.tsx`/the Files sidebar currently resolves a project root
  for an open file — reuse that resolution, don't invent a second one; if no such resolution
  exists yet, use the longest-prefix-matching tab `cwd` among all tabs as a pragmatic stand-in and
  say so in your commit message).
- [ ] In `useDocEdit.ts`'s `runInstruction` (`~line 132`, per PRD 679's shape), before the
  existing `window.api.docEdit.run(...)` call: resolve the candidate tab via the selector above.
  - If a candidate exists AND that tab is not currently mid-run (check the same "is this tab
    running" signal the chat UI itself uses to disable its input — locate it in `state/chat.ts` or
    wherever `chat:run:started`/`chat:run:complete` are consumed; reuse it, don't add a second
    running-flag), call a new IPC (see below) that performs the resumed/silent chatRunner path.
  - Otherwise (no candidate, or candidate is busy) fall through unchanged to today's isolated
    `window.api.docEdit.run(...)` call from PRD 679 — this is the existing, already-tested path;
    do not modify it.
- [ ] Add a new main-process entry point that wraps `chatRunner`'s `run()` for this use case —
  e.g. `docEditViaSession({ tabId, sessionId, cwd, before, instruction, documentText })` in
  `docEdit.cjs`, exposed as a new IPC handler `docedit:run-in-session` (add its zod schema next to
  `docEditRun` in `ipcSchemas.cjs`, same field caps, plus `tabId: z.string().min(1)` and
  `sessionId: z.string().min(1)`). It must:
  - Build the SAME prompt `editPrompt(before, instruction, documentText)` already produces (PRD
    679) — reuse it verbatim, don't fork a second prompt builder.
  - Call `chatRunner.run({ tabId, sessionId, cwd, prompt: <that prompt>, resume: true, silent:
    true, onSilentResult: (text) => { /* parseDocEdit(text) and resolve/broadcast the result */ } })`.
  - Because `chatRunner.run()` is fire-and-forget (broadcasts happen via IPC events, it does not
    return a promise with the result), thread the result back to the renderer the same way
    `probeContextUsage` does for `chat:context-usage` — broadcast a new event (e.g.
    `docedit:session-result` with `{ tabId, ok, after, error }`, using `parseDocEdit` from
    `docEdit.cjs` on the `onSilentResult` text) and have the renderer's `useDocEdit.ts` subscribe
    to it (mirroring how `live.ts`/`chat.ts` subscribe to their own IPC events) and resolve the
    pending `runInstruction` promise/dispatch from there instead of from a direct `invoke()`
    return value.
- [ ] `preload/index.cjs` + `preload/api.d.ts`: expose the new `docedit:run-in-session` invoke and
  the `docedit:session-result` event subscription, following the exact existing pattern for
  `docEdit.run`/`transcripts.onEvent`.
- [ ] The DOC_EDIT_SYSTEM anti-injection framing (`docEdit.cjs`) must still apply to this path —
  don't send the raw prompt through `chatRunner.run()` without it; pass it via chatRunner's
  existing system-prompt mechanism if it has one for one-shot resumed turns, or prepend it to the
  prompt text with the same nonce-tag data-boundary pattern if not (check
  `chatRunner.cjs`'s prompt-building code first — reuse whatever mechanism it already uses for
  its own stop-signal/chat-mode-truth prompt prefixing, mentioned in the file's header comment
  around "Prepend the stop-signal protocol instruction").
- [ ] Add unit tests (extend whatever test file already covers `docEdit.cjs`/`useDocEdit.ts` from
  PRD 679, or `chatRunner.spec.ts` if that's the more natural home for the session-routing logic)
  covering: the selector behavior above, and that `docEditViaSession` builds its prompt via the
  shared `editPrompt` and calls `chatRunner.run` with `resume: true, silent: true`.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <files you touched>` passes.

# Implementation notes

- Read `chatRunner.cjs:179-206` (`probeContextUsage`) end to end first — it is the exact template
  for "fire a silent resumed turn and parse structured output from the reply," down to the
  broadcast-on-success / log-on-parse-failure shape. Copy its structure, not just its idea.
- Read the per-tab exclusivity guard at `chatRunner.cjs:308-312` — this is *why* you must check
  busy-state in the renderer before calling, rather than relying on chatRunner to queue for you:
  it deliberately drops (no-ops) a second `run()` for a tab already in flight or waiting, it does
  not enqueue it. Silent-fail-and-fallback (per the AC above) is the intended handling for that
  case, not a bug to route around inside chatRunner.
- Do not add a generic "queue behind the busy session" mechanism — that's explicitly out of
  scope (see below) and the single-instance isolated-fallback behavior in the AC already covers
  the busy case without new queuing machinery.
- `sessions.ts:7-30`'s `SessionTab` and `live.ts`'s `LiveTab.lastEventAt` are the two data sources
  the selector needs — both already exist and are read elsewhere in the app (`AlmanacFooter.tsx`
  for `lastEventAt`); don't add a third tracking field for "recency."

# Out of scope

- Do not build a queue/wait mechanism for a busy background session — fall back to the isolated
  one-shot for that single edit instead (see AC).
- Do not add a manual session picker UI — auto-match by cwd + recency only, per the design
  decided in conversation.
- Do not ever target a `running`/`spawning` tab's `claudeSessionId` (the live interactive pty) —
  only a `dormant` tab's `chatSessionId`. This is a hard safety boundary, not a style choice.
- Do not modify `chatRunner.cjs`'s core queue/exclusivity/concurrency-cap logic — only add a new
  caller (`docEditViaSession`) that uses its existing public `run()` surface unchanged.
- Do not change the diff/approval UI — Accept/Reject/Retry gating stays exactly as-is regardless
  of which path produced the `after` text.

## Engineering standards

# Engineering standards

> Single source of truth for the developer guidance that used to live in the global
> `~/.claude/CLAUDE.md`. Consumers: the `/develop` skill reads it while planning and
> inlines it **verbatim** into every PRD it emits (under an `## Engineering standards`
> heading); the `/prd` command points here for the execution-discipline rules so a
> directly-authored PRD carries the same block. The headless `claude -p` executor sees no
> skills and no conversation — inlining this is the only way these rules reach it. Edit
> here once; every call site updates.
>
> The **Execution discipline** section below is the executor-facing core — it is the part
> that MUST appear in every PRD body. The rest (Performance, Debugging, API reuse, TDD)
> guides authoring and interactive work.

## Performance

- State the time and space complexity of any non-trivial algorithm in a comment.
- Flag any nested loop over user-scaled data as a complexity hazard.
- Prefer O(n) solutions over O(n log n) only when n is provably small or constant.
- Lay out hot data contiguously and traverse it in memory order.
- Prefer arrays of structs or structs of arrays based on actual access patterns.
- Avoid pointer-chasing in inner loops on large datasets.

## Debugging approach

- State an explicit hypothesis before each debugging action.
- Describe what observation would confirm or refute the hypothesis.
- If three hypotheses fail, stop and re-examine your assumptions from scratch.
- When a bug was recently introduced, bisect commits to find the offender.
- When a bug is in a long pipeline, halve the input or code path until it localizes.
- Record each bisection step so the path to the root cause is reproducible.
- Never attempt a fix until you can reproduce the bug on demand.
- Capture the reproduction as a failing test before changing production code.
- If the bug cannot be reproduced, instrument the system until it can.

## API reuse and single source of truth

- One concept = one implementation. Before writing code that computes, fetches, formats, or displays a value, search the codebase for an existing implementation and reuse it. Do not write a second or third copy of the same logic.
- N display sites, ONE source. When the same datum appears in multiple places (a metric shown in several tabs, a value returned by several endpoints), it must flow from a single shared accessor / store / hook / endpoint. Displaying something in 3 places must not mean 3 implementations — it means 1 implementation with 3 call sites.
- Extend, don't fork. If an existing function/module/API is close but not sufficient, generalize it (add a param, widen the contract) rather than cloning a divergent variant. Prefer composition over duplication.
- Treat duplication as a latent bug. Copy-pasted logic drifts; divergence between copies is how silent inconsistencies ship (e.g. one site reads a 0–100 percentage as a 0–1 fraction). When you see the same logic in two places, consolidate it on sight and route both through the shared unit.
- Design for extensibility: stable shared contracts, single ownership, callers depend on the contract — not on a private copy. New surfaces consume the canonical API; they never reimplement it.
- When reviewing or implementing, explicitly check: "is this value/behaviour already produced elsewhere, and am I reusing that path?" If not, fix the reuse before adding the feature.

## Test-driven development

- Write the failing test first, then the implementation that makes it pass — for every feature and every bugfix.
- A bugfix starts with a test that reproduces the bug (red), then the fix (green).
- Do not write production code without a test asserting the behavior it adds.
- (Interactive sessions: the `test-driven-development` skill has the full red-green-refactor
  workflow. Headless PRD runs can't load it — the three rules above are the load-bearing core.)

## Visual design (UI/visual acceptance criteria)

When a PRD's acceptance criteria touch UI or visual output and no design brief is given,
resolve the visual direction in this priority order — never substitute a generic default when
a higher-priority source exists:

1. **User-supplied design.** If the PRD or the conversation that spawned it includes a design
   brief, mockup, brand palette, or explicit visual direction, use it verbatim.
2. **Existing project design system.** Before reaching for any external skill, check the repo
   itself for an existing theme — CSS custom-property blocks, `tailwind.config.js`, a
   design-tokens file, a component library already in use. Reuse and extend what's there
   rather than introducing a second visual language into the same project.
3. **Only if neither exists**, invoke a design-oriented skill rather than eyeballing colors
   from memory or hand-picking hex values (e.g. the bundled `dataviz` skill for
   chart/table/dashboard work, or a `frontend-design`-class skill for overall aesthetic
   direction) — and **render + screenshot both light and dark color-scheme modes** before
   calling the work done. A palette validator that checks categorical/series colors does not
   cover surrounding chrome tokens (panel/page/border) — those need their own contrast check
   (WCAG relative luminance) and a visual look in each mode. "I checked light mode" is not "I
   checked dark mode"; verify both, don't assume palette-reference hex values are safe by
   construction. (Incident: a dashboard shipped with panel/page background contrast of
   1.12:1 and a border at 1.34:1 in dark mode — both invisible — because only light mode was
   ever rendered before the work was marked done.)

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.
