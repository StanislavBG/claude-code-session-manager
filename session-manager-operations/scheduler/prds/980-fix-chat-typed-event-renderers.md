---
title: "Fix: implement PRD 980's typed event renderers inline (prior run delegated to a background subagent and exited 0 with nothing done)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 980
estimateMinutes: 55
---

# READ THIS FIRST — the failure class you must not repeat

The previous run of this work failed as a **self-delegation failure**. Quoting the canonical rule
from `plugins/session-manager-dev/skills/develop/standards.md`, "Execution discipline (headless
runs)", VERBATIM:

> - **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop` or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)

**This queued PRD is the task, not evidence that the task is done. Your deliverable is a committed
code diff in this repo, produced by your own Edit/Write calls in this run.** Concretely, in this run:

- Do NOT call the `Task`/Agent tool with `subagent_type: dev-lead` (or any other) to "implement the
  PRD" and then end your turn. That is exactly what killed the last run.
- Do NOT call `ScheduleWakeup`, `CronCreate`, `TaskCreate`, or `Workflow`.
- Do NOT invoke the `Skill` tool with `session-manager-dev:develop` or any queue-authoring skill.
- The work is large. Do it inline, in this run, editing files directly. If you run short on time,
  land a smaller-but-complete, tested, committed subset and say so in the FAIL/PASS output — a
  partial-but-committed diff is infinitely better than a delegated turn that commits nothing.

# Root-cause analysis (what went wrong last time)

Run: `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T05-03-12-912Z/980-chat-typed-event-renderers.log`, exit 0, 657s.

1. The main loop read the PRD, then immediately spawned a **background `Task` subagent**
   (`subagent_type: "dev-lead"`, `tool_use_id: toolu_01CysCgXLRQKmoqkYWTbW1sW`) to do the entire
   implementation.
2. The main loop then **ended its turn after ~55s** with the literal result text: *"Kicked off a
   dev-lead agent in the background to implement the typed event renderers in
   `ChatTranscriptTurn.tsx` per the PRD, run code/security review, verify (typecheck/tests/selector
   lint), and commit. I'll report back once it completes."* A headless run has no next turn — there
   was nothing to report back to.
3. The harness printed `Background tasks still running after 600s; terminating` and SIGKILLed the
   subagent **mid-`Edit`**, immediately after it had inserted the new import lines into
   `ChatTranscriptTurn.tsx` and was about to insert the renderer block.
4. Process exited 0. No commit, no `SCHEDULER_VERDICT` sentinel, no tests.

Contributing cause: PRD 980's `## Engineering standards` section only *linked* `standards.md` by an
absolute npx-cache path instead of inlining the Execution-discipline rules, so the executor never
read the "You ARE the executor" rule. This fix-PRD inlines them verbatim below.

# Current state of the working tree (uncommitted, on `main`, HEAD = 8bac5b0)

Verify this yourself with `git status --short` before touching anything; do NOT `git stash`,
`git reset --hard`, or `git clean` — these changes are the partial output of the failed run plus
adjacent in-flight work, and some of it is salvageable.

- `src/renderer/lib/chatSignals.ts` — **NEW, untracked, substantially complete (~338 lines).**
  Exports `SIGNAL_TEXT_MAX`, `SIGNAL_NAMES_MAX`, `interface ChatSignal`, `toolTraceFor`,
  `summarizeSignal`, `fullSignalText`, `fullSignalNames`, `isToolFamilyKind`. Read it in full and
  REUSE it — do not rewrite it from scratch.
- `src/renderer/state/chat.ts` — modified and already wired: it imports `summarizeSignal`, carries
  `signal?: ChatSignal` on a turn, and builds `role: 'event'` turns with `kind`, `ref`, `signal`
  (~line 1079). The store side of the feature is done.
- `src/renderer/components/ChatTranscriptTurn.tsx` — **only the imports were added.** Lines 1, 4, 5
  now import `type ReactNode`, `{ fullSignalText, fullSignalNames, isToolFamilyKind }` from
  `../lib/chatSignals`, and `{ formatBytes }` from `../lib/formatBytes`. **None of them are used
  anywhere in the file.** There is no dispatch point, no Signal card, no router-never-filter
  comment, no typed renderers. `npm run typecheck` passes only because unused imports are not TS
  errors — treat a green typecheck as meaningless evidence here.
- Also present and NOT yours: `src/main/transcripts.cjs`, `src/main/ipcSchemas.cjs`,
  `src/preload/*`, `src/main/__tests__/transcripts-paged-reads.test.cjs`,
  `session-manager-operations/scheduler/prds/979-fix-transcript-paged-reads.md`, and scheduler
  state files. Leave them alone; they belong to PRDs 978/979. Your commit should scope to the
  renderer files and their tests (`git add` explicit paths — never `git add -A`).

# Fix steps

1. `git status --short` and `git log --oneline -3` to confirm the state above. Do not discard
   anything.
2. Read, in full, in this order:
   - `src/renderer/lib/chatSignals.ts` (the partial run's real output — your building block)
   - `src/renderer/state/chat.ts` around the `role: 'event'` turn construction (~lines 55–75,
     1070–1095) to confirm the exact shape reaching the component: `{ role: 'event', text, kind,
     ref, signal }`
   - `src/renderer/components/ChatTranscriptTurn.tsx` **in full** (682 lines). Its header says do
     not fork it. Inventory its existing exported primitives before writing anything new.
3. Implement the original PRD 980 acceptance criteria **inline in
   `src/renderer/components/ChatTranscriptTurn.tsx`**, reusing the file's existing primitives
   (`TOOL_USE_TONE`, `TOOL_USE_ICON`, `collapseToolUseRuns`, `runLabel`, `ToolUseTraceStrip`,
   `CollapsibleToolStrip`, `DiffCard`, `UrlCallout`, `FileCallout`, `ERROR_TEXT`, `ERROR_TINT`,
   `AMBER_TEXT`, `AMBER_TINT`, `renderChatMarkdown`, `computeLineDiff`, `formatAgo`,
   `MarkdownPreview`) rather than adding parallel ones. The full original AC list is reproduced
   verbatim in "Original PRD 980 acceptance criteria" below — it is the contract.
   The load-bearing core, if you must triage: (a) the single dispatch point with an explicit
   `default` branch rendering a generic Signal card, carrying the code comment stating the
   **classifier is a ROUTER, never a FILTER** rule and that it is the forward-compatibility
   guarantee for unknown/future event kinds; (b) the generic Signal card itself; (c) the
   conversation lane (assistant markdown, inline in-order thinking blocks, tool_use strip,
   tool_result outcome chip); (d) the signals lane interleaved chronologically; (e) the two-and-only-two
   permitted suppressions (`ai-title` repeats, `last-prompt`); (f) the unit tests.
4. Make every import that the failed run added actually used, or delete it. An unused
   `formatBytes`/`ReactNode`/`fullSignalNames` import at the end of this run is a signal you did
   not finish; `fullSignalText`/`fullSignalNames` are the expand-to-uncapped-payload path and
   `isToolFamilyKind` is the tool-chip merge predicate — wire them.
5. Write the unit tests under `src/renderer/__tests__/` (match the existing renderer test layout —
   check `vitest.config.ts` for the include globs, which were modified by an adjacent PRD). At
   minimum: a made-up event type (e.g. `{ type: 'tip', ... }`) RENDERS rather than being dropped;
   no kind other than repeated `ai-title` / `last-prompt` is suppressed; an unlisted `attachment`
   subtype falls through to the generic Signal card; a null/malformed payload renders an empty-state
   shell rather than throwing.
6. Do NOT attempt the "launch the app and screenshot both themes" validation criterion from the
   original PRD — a headless run cannot drive a GUI and attempting it is how runs get SIGTERMed.
   Instead, satisfy its intent statically: assert in a test that each new renderer family emits a
   distinguishing class/tone token, keep every color to existing Almanac tokens already in this
   file, and state in your final output that the visual/theme check is deferred to interactive
   human validation.
7. Respect CLAUDE.md constraints: never return a freshly-built value from a zustand selector
   (three prior blank-app incidents); surface non-fatal errors via `useToast()`; no new nav tab; do
   not fork a parallel `Turn` variant — this file is shared by `TerminalChat`
   (`toolStripVariant='inline'`) and `EpicDetail` (`toolStripVariant='collapsible'`) and both must
   keep working. `grep -rn "ChatTranscriptTurn" src/` before changing any exported signature.
8. Commit with explicit paths, e.g.
   `git add src/renderer/components/ChatTranscriptTurn.tsx src/renderer/lib/chatSignals.ts src/renderer/__tests__/<new tests> && git commit -m "feat(chat): typed renderers per event family with a router-never-filter fallback"`.

# Verification commands (run these, bounded, before the finish protocol)

```
timeout 300 npm run typecheck
timeout 300 npm run test:unit
timeout 120 node scripts/check-unstable-selectors.cjs
if grep -nE "^import .*(formatBytes|chatSignals)" src/renderer/components/ChatTranscriptTurn.tsx >/dev/null && ! grep -q "ROUTER" src/renderer/components/ChatTranscriptTurn.tsx; then echo "HALT: imports added but no router dispatch comment — same failure as last run"; exit 1; fi; echo "router dispatch present"
if [ -z "$(git log --oneline -1 --since='2 hours ago')" ]; then echo "HALT: nothing committed this run"; exit 1; fi; echo "commit landed"
```

Note the last two are negative-assertion checks written so the clean path exits 0.

# Acceptance criteria

- [ ] The implementation was performed by THIS run's own Edit/Write calls. No `Task`/subagent was
      spawned to do it, no `ScheduleWakeup`/`CronCreate`/`Workflow` was called, and no
      queue-authoring skill was invoked.
- [ ] `src/renderer/components/ChatTranscriptTurn.tsx` contains a single kind→renderer dispatch
      point with an explicit `default` branch rendering the generic Signal card, plus a code comment
      at that default stating the classifier-is-a-ROUTER-never-a-FILTER rule and the
      forward-compatibility guarantee.
- [ ] Every one of the original PRD 980 CORE and EDGE criteria (reproduced verbatim below) is
      implemented, except the GUI-launch VALIDATION criterion, which is explicitly deferred per
      step 6 and called out in the final output.
- [ ] No import added to `ChatTranscriptTurn.tsx` is unused.
- [ ] Unit tests exist and pass covering: unknown/made-up event type renders; only `ai-title`
      (repeats) and `last-prompt` are suppressed; unlisted `attachment` subtype falls through;
      malformed payload renders an empty state without throwing.
- [ ] `npm run typecheck`, `npm run test:unit`, and `node scripts/check-unstable-selectors.cjs` all
      pass, run last, and nothing errors after them.
- [ ] The work is COMMITTED (explicit paths, not `git add -A`; the PRD 978/979 files listed above
      are left untouched and uncommitted) and the run ends with a truthful
      `SCHEDULER_VERDICT: PASS` as the literal last line.

# Original PRD 980 acceptance criteria (the contract — reproduced verbatim)

- [ ] Read src/renderer/components/ChatTranscriptTurn.tsx in full first and REUSE its existing exported primitives rather than adding parallel ones: TOOL_USE_TONE, TOOL_USE_ICON, collapseToolUseRuns, runLabel, ToolUseTraceStrip, CollapsibleToolStrip, DiffCard, UrlCallout, FileCallout, ERROR_TEXT, ERROR_TINT, AMBER_TEXT, AMBER_TINT. Also reuse renderChatMarkdown, computeLineDiff, formatAgo and MarkdownPreview.
- [ ] CORE: a single dispatch point maps event kind -> renderer, with an explicit `default` branch that renders the generic Signal card. Add a code comment at that default stating the router-never-filter rule and that it is the forward-compatibility guarantee for unknown/future event types.
- [ ] CORE (generic Signal card): renders the event's type name as a header plus a pretty-printed, syntax-highlighted JSON body, collapsed to 3 lines with an expand affordance. Add a unit test that feeds a completely made-up event type (e.g. { type: 'tip', ... }) and asserts it RENDERS rather than being dropped — this test is the executable statement of the forward-compat guarantee, do not omit it.
- [ ] CORE (conversation lane): assistant text via renderChatMarkdown; thinking blocks rendered INLINE IN ORDER with a distinct dimmed left-border tint (they are currently suppressed entirely); tool_use via the existing icon+label strip with runs collapsed via collapseToolUseRuns; tool_result as an outcome chip plus first line plus byte count, expanding to the full untruncated payload, reusing DiffCard where a diff applies; user prompts as markdown.
- [ ] CORE (signals lane, chronologically interleaved with the conversation — NOT a separate scroll container): mode and permissionMode render as an inline divider RULE, not a card (e.g. '— mode → plan —') because a state transition is a line; queue-operation as a chip with operation verb plus queued command text; attachment/deferred_tools_delta as a count chip ('+12 tools' / '−16 tools') expandable to the name list; attachment/mcp_instructions_delta as a named card with the server name in the header and a markdown body; attachment/skill_listing and attachment/agent_listing_delta as a count chip plus expandable name grid; attachment/task_reminder as a thin dim one-line strip; attachment/command_permissions tinted with the existing AMBER_TINT; attachment/edited_text_file reusing DiffCard directly; file-history-snapshot as a one-line restore-point marker.
- [ ] CORE (uncapped on inspect): expanding any card loads the FULL untruncated payload. Reuse the byte-reference/paging path the upstream PRDs added, and for Epic turn text reuse the existing durable per-Epic transcript (promptSessionTranscript.cjs) that appendResponseEvent already writes — do NOT invent a second full-text mechanism.
- [ ] CORE (show everything by default): no collapsed-by-default signal rail. Exactly TWO suppressions are permitted, both exact duplicates of something already displayed — repeated ai-title (show once as the session title) and last-prompt (duplicate of the immediately preceding user turn). Add a unit test asserting no OTHER kind is suppressed.
- [ ] EDGE: an attachment subtype not in the list above falls through to the generic Signal card rather than rendering blank.
- [ ] EDGE: an event with a null/empty/malformed payload renders its card shell with an explicit empty state rather than throwing and blanking the view.
- [ ] EDGE: a multi-MB tool_result renders its preview promptly and does not block the UI thread when expanded.
- [ ] INTERACTION EFFECT: this file is shared by TerminalChat (toolStripVariant='inline') and EpicDetail (toolStripVariant='collapsible'). Every new renderer must work in BOTH contexts — do not fork a parallel Turn variant. Grep importers before changing any exported signature.
- [ ] INTERACTION EFFECT: PRDs 845, 914, 915 and 916 already landed the per-turn caption layer, outcome label, and diff capture/rendering in this same file. Read their landed state and EXTEND it — do not rebuild captions, the outcome label, or DiffCard.
- [ ] Unit tests cover each named renderer family plus the unknown-type fallback.

Real event-kind frequencies measured across the last 20 sessions of this project, for sizing and
fixtures: attachment 317 (subtypes: deferred_tools_delta 107, task_reminder 94,
mcp_instructions_delta 77, agent_listing_delta 23, skill_listing 20, command_permissions 6,
edited_text_file 3, queued_command 2), last-prompt 252, ai-title 217, queue-operation 122, mode 94,
permissionMode 24, file-history-snapshot 5.

VERIFIED, do not chase: there are ZERO `*tip*` keys in any transcript under `~/.claude/projects/*/`.
Claude Code "TIPs" are rendered by the CLI into the terminal, not written to the JSONL. Do NOT build
an ANSI/PTY scraper for them — the generic Signal card is the durable answer.

# Out of scope

- The three-zone turn frame and per-message attribution chips (next PRD in the chain)
- The Epic grounding/AIM briefing card (later PRD in the chain)
- Any ANSI/PTY scraping to capture CLI-rendered TIPs
- Changing what the classifier emits
- Adding a new nav tab or a parallel Simplified Chat surface
- Touching the PRD 978/979 files currently uncommitted in the working tree

## Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop` or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **`gh pr checks`/`gh run watch` exit non-zero while CI is merely *pending*, not failed — don't let that surface as a bare error.** Polling `gh pr checks <n>` before checks finish returns a non-zero exit (e.g. 8) with output like `check  pending  0  <url>` — this is normal, documented `gh` CLI behavior, not a failure. If you retry with a *differently-worded* command (e.g. dropping a `sleep N &&` prefix, or switching to `gh run watch <id> --exit-status`), the verifier's self-recovery detector pairs retries by exact command-description match and may not recognize the differently-worded retry as the same recovery, leaving the original pending-state error looking unrecovered in the transcript (incident: `745-pr188-ci-lint-docs-integrity`, a fully green, committed, pushed run flagged `needs_review` over exactly this). Prefer polling with the *same* command/description each time (e.g. loop `gh pr checks <n>` unchanged, or use `gh run watch <id> --exit-status` from the start rather than switching mid-poll) so a later success is recognized as recovering the earlier pending-state failure.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Polling remote CI/job status: never `sleep N && <cmd>`, and annotate the pending exit code.** The harness hard-blocks a `sleep` chained to another command (`Blocked: sleep 90 followed by: gh pr checks ...`) and that block lands in the transcript as a bare `is_error=true` — usually in the last 20% of the run, right where the verifier weighs errors most. To wait for a remote run, use the tool's own blocking watcher under a hard cap: `timeout 600 gh run watch <run-id> --repo <owner>/<repo> --exit-status`. Also note `gh pr checks` is a **negative-assertion-shaped command**: it exits `8` while checks are pending and `1` when a check failed or none are reported — so the ordinary "still running" path is non-zero. Wrap it so the expected cases print a clean token rather than a bare error: `if out=$(timeout 60 gh pr checks <n> --repo <r> 2>&1); then echo "CI GREEN"; else rc=$?; echo "gh pr checks rc=$rc (8=pending, 1=fail/none) — expected/handled"; fi`. (Incident: PRD 745 fixed PR #188's Lint + Docs-integrity failures, pushed, and CI went fully green — but its `sleep 20 && gh pr checks` (exit 8) and `sleep 90 && gh pr checks` (harness-blocked) sat unannotated at the very end of the transcript and the run was flagged despite a truthful PASS and a landed commit.)
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.
