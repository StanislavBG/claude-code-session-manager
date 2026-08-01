---
title: "Fix: durably persist full Epic prompt/response text under session-manager-operations"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 863
estimateMinutes: 90
---

# READ THIS FIRST — why the previous run of this PRD produced nothing

The canonical rule from `plugins/session-manager-dev/skills/develop/standards.md`, quoted verbatim:

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it.

**You are the executor for this PRD. The deliverable is a code diff plus a commit — nothing else counts.**

Specifically, in this run:

- Do **not** invoke the `Skill` tool with `session-manager-dev:develop`, `session-manager-dev:process-feedback`, or any other queue-authoring skill.
- Do **not** call `ScheduleWakeup`, and do not end your turn saying you will "check back" or "verify when it lands".
- Do **not** query the scheduler (`scheduler_list_jobs`, the admin API, `queue.json`) to decide whether to work. **A queued or running PRD is the task, not evidence that the task is done.** The previous run of this exact PRD listed the scheduler jobs, saw a running job for this same slug — which was *its own pid* — concluded "this is already being handled by a concurrent job", wrote an essay explaining why it would not act, and exited 0 with zero edits. If you see a running job whose slug matches this PRD, that is you. Ignore it and write the code.
- Do **not** spawn a background review agent and then end the turn waiting for it. Any review must be synchronous and inline before the finish protocol.

---

# Root-cause analysis

## Why the previous run failed

Run log: `/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-08-01T05-50-01-846Z/863-in-sesion-manager-operations-i-can-see-the-actual-prds.log` (exit 0, 212s, no commit, no `SCHEDULER_VERDICT` sentinel, no file edits — 22 Bash + 9 Read calls, all read-only).

The run invoked `Skill(session-manager-dev:develop)` with its own Goal/AC as the argument. That skill's job is to *author and queue* PRDs, so it checked the scheduler, found a live job running this identical request (pid 68949 — the run's own process), and correctly refused to author a duplicate. The run then treated its own reflection as a competing job and stood down. Classic self-delegation failure, same class as incidents PRD 460 and PRD 479.

## The real product gap (verified against the code — reuse this, it is accurate)

Full prompt and response text is **never durably persisted anywhere under `session-manager-operations/`**:

- `PromptSessionEvent.text` (`src/renderer/state/promptSessions.ts:79`) holds real content only for the **first** `prompt` event (the Epic's goal text). Later prompts and *all* responses are placeholders.
- `response` events are synthetic strings, not agent output:
  - `src/main/scheduler.cjs:1671` — `` const message = `PRD ${job.slug} finished: ${job.status}. Check Scheduler for details.` ``
  - `src/renderer/components/epics/EpicDetail.tsx:334-338` — hardcoded `text: 'Iterated in Terminal view'` on the terminal→chat handoff.
- `src/main/transcripts.cjs` parses transcript lines into a **500-entry in-memory ring buffer only** (`doFlush`, cap at `src/main/transcripts.cjs:116-118`) and broadcasts them. Nothing is written to disk.
- The archive's `transcript` field (`markCompleted`, `src/renderer/state/promptSessions.ts:305-317`) is a **one-shot best-effort copy** of `~/.claude/projects/<encodedCwd>/<claudeSessionId>.jsonl` taken at completion time. It is an empty string whenever that file does not exist yet or the session id does not line up. Confirmed empty in this repo's own archive at `session-manager-operations/prompt-sessions/psess-ms9x7241-9.json`.
- Chat responses: `src/renderer/state/chat.ts` appends `prd_created` events (`appendPrdCreatedEvent`, ~line 549) but never appends the assistant's actual reply text as a `response` event.

Net effect for the user: the Epic detail view can show which PRDs an Epic spawned, but not what was actually said. There is no on-disk record to rebuild chat context from, so the Epic cannot be used as grounding.

**The fix is durable, incremental capture of full prompt/response text under `session-manager-operations/` — not patching the placeholder strings.**

# Fix steps

Work inside `/home/bilko/Projects/session-manager`. Follow the existing architecture conventions in `CLAUDE.md`: main process is `.cjs`, renderer is TS/TSX, all fs paths go through `config.cjs`'s `validatePath` + atomic write helpers (`writeJson` / `writeTextAtomic`) — do **not** hand-roll tmp+rename.

### 1. New durable transcript store (main process)

Create `src/main/promptSessionTranscript.cjs`:

- Path helper: `transcriptPathFor(cwd, epicId)` → `<cwd>/session-manager-operations/prompt-sessions/transcripts/<epicId>.jsonl`. Mint the `transcripts/` dir on first write.
- `appendTurn(cwd, epicId, { role, text, at, eventId })` — appends **one JSONL line** per turn: `{ v: 1, epicId, eventId, role: 'user' | 'assistant', at: <ISO>, text: <full untruncated text> }`.
  - Append via `fs.promises.appendFile` with a per-path in-process serialization queue (a `Map<path, Promise>` chain) so concurrent appends cannot interleave a partial line. A full-file tmp+rename is wrong here — the file grows unboundedly and rewriting it per turn is O(n²).
  - Best-effort: log and return `false` on failure, never throw into the caller (mirror `src/main/promptSessionEvents.cjs`'s error posture).
  - Reject control bytes / NULs from `text` before writing.
- `readTurns(cwd, epicId, { limit } = {})` — parses the JSONL back into an array, skipping unparseable lines rather than throwing (a torn tail line must not poison the whole read).

Register IPC in `src/main/index.cjs` under a `promptSessionTranscript:` namespace (`append`, `read`), add zod payload schemas to `src/main/ipcSchemas.cjs`, and expose it on `src/preload/index.cjs` + `src/preload/api.d.ts` as `window.api.promptSessionTranscript`.

### 2. Capture the real text at each existing placeholder site

- **Chat responses** (`src/renderer/state/chat.ts`): where an assistant run completes for an Epic, append a `response` `PromptSessionEvent` carrying the assistant's real reply text (truncate the in-memory event `text` to a bounded preview — 2000 chars — and write the **full** text through `promptSessionTranscript.append`). Also append the user's prompt text as a `user` turn when a prompt is sent from an Epic.
- **Scheduler completion** (`src/main/scheduler.cjs:~1671`, `notifyOriginatingTab`): keep the existing short status message as the event `text` (it drives the UI chip), but additionally call `promptSessionTranscript.appendTurn` with the job's real result text. The `claude -p` result is available in the run log at `~/.claude/session-manager/scheduled-plans/runs/<ts>/<slug>.log` — read the final `{"type":"result",...}` line's `result` field. Best-effort: a missing/unparseable log must not break notification.
- **Terminal handoff** (`src/renderer/components/epics/EpicDetail.tsx:~334`): replace the hardcoded `'Iterated in Terminal view'` with the actual turns observed for that Epic. `src/main/transcripts.cjs` already parses and classifies the session's JSONL and broadcasts `transcript:event:<tabId>` — subscribe/drain the buffered events for the Epic's `claudeSessionId` and append each user/assistant turn through `promptSessionTranscript.append`. If genuinely nothing is available, keep a placeholder — but the placeholder must be the fallback, not the only path.

### 3. Make the archive complete rather than best-effort

In `markCompleted` (`src/renderer/state/promptSessions.ts:297-320`): when the `~/.claude/projects/...` transcript copy comes back empty, fall back to `promptSessionTranscript.read(cwd, promptSessionId)` and serialize those turns into the archive so a completed Epic always carries its conversation. Keep the existing raw-jsonl copy when it *is* present (both may be included; prefer including both fields over dropping one).

### 4. Surface it in the UI

`src/renderer/components/epics/EpicDetail.tsx`: render full turn text for `prompt` / `response` events, reading from `promptSessionTranscript.read` when the event's inline `text` is a truncated preview. A long turn should be collapsible/expandable rather than clipped with no way to see the rest.

### 5. Tests

Add unit tests (vitest) covering, at minimum:

- `appendTurn` → `readTurns` round-trips full untruncated text.
- Concurrent `appendTurn` calls for the same epic produce N well-formed lines (no interleaving).
- `readTurns` skips a corrupt/torn line instead of throwing.
- The scheduler completion path writes a real result turn (mock the run-log read), and a missing log does not throw.
- `markCompleted` falls back to the durable store when the `~/.claude/projects` copy is empty.

Place main-process tests alongside the existing ones under `src/main/lib/__tests__/` (or `src/main/__tests__/`, matching whatever sibling convention that module ends up in) and renderer tests next to the component/store under test.

# Verification commands

Run these, bounded, in this order, and make the acceptance gate the **last** command:

```
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main --reporter=dot
timeout 300 npm run test:unit
timeout 60 npm run lint:selectors
```

Then prove the feature end-to-end without launching a second Electron instance (a second Electron would SIGTERM live scheduler jobs — do not run the app or e2e here). Use a node one-liner against the new module in a temp cwd:

```
timeout 60 node -e "
const t = require('./src/main/promptSessionTranscript.cjs');
const os = require('os'), fs = require('fs'), path = require('path');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
(async () => {
  await t.appendTurn(cwd, 'psess-test-1', { role: 'user', text: 'x'.repeat(5000), at: new Date().toISOString(), eventId: 'e1' });
  await t.appendTurn(cwd, 'psess-test-1', { role: 'assistant', text: 'y'.repeat(5000), at: new Date().toISOString(), eventId: 'e2' });
  const turns = await t.readTurns(cwd, 'psess-test-1');
  if (turns.length !== 2 || turns[0].text.length !== 5000 || turns[1].text.length !== 5000) { console.log('HALT: round-trip lost text'); process.exit(1); }
  console.log('durable round-trip OK');
})();
"
```

A `grep`-style negative assertion (e.g. confirming the hardcoded placeholder is no longer the sole response text) must be inverted so the clean case exits 0:

```
if grep -rn "Iterated in Terminal view" src/renderer/components/epics/EpicDetail.tsx | grep -v fallback; then echo "HALT: placeholder still on the primary path"; exit 1; fi; echo clean
```

# Acceptance criteria

- [ ] `src/main/promptSessionTranscript.cjs` exists, appends one JSONL line per turn under `<cwd>/session-manager-operations/prompt-sessions/transcripts/<epicId>.jsonl`, and round-trips full untruncated text via `readTurns`.
- [ ] Paths go through `config.cjs`'s `validatePath`; no hand-rolled tmp+rename; appends are serialized per path.
- [ ] IPC registered in `src/main/index.cjs`, zod-validated in `src/main/ipcSchemas.cjs`, exposed in `src/preload/index.cjs` and typed in `src/preload/api.d.ts`.
- [ ] Chat prompts and assistant replies for an Epic are written to the durable store with full text; the in-memory `PromptSessionEvent.text` carries a bounded preview.
- [ ] `src/main/scheduler.cjs`'s `notifyOriginatingTab` additionally persists the job's real result text; a missing/unparseable run log does not throw or break the existing notification.
- [ ] `'Iterated in Terminal view'` is no longer the only response text on the terminal→chat handoff — real captured turns are persisted, with the placeholder used only as a fallback.
- [ ] `markCompleted` falls back to the durable store when the `~/.claude/projects` transcript copy is empty, so a completed Epic's archive always carries its conversation.
- [ ] `EpicDetail.tsx` renders full prompt/response text (expandable for long turns), not just a status chip.
- [ ] New unit tests cover round-trip, concurrent appends, corrupt-line tolerance, the scheduler result-text path, and the archive fallback.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit` passes.
- [ ] `timeout 60 npm run lint:selectors` passes.
- [ ] Work is committed and `SCHEDULER_VERDICT: PASS` is the literal last line of the run.

# Out of scope

- Building a new LeftNav tab or a separate transcript-browser surface (CLAUDE.md: extend an existing surface — Epic detail — rather than adding a nav destination).
- Any change to `src/main/transcripts.cjs`'s 500-entry ring buffer size or its broadcast protocol.
- Retroactively backfilling transcripts for already-archived Epics.
- Launching the Electron app, taking screenshots, or running `npm run test:e2e` (a second Electron instance would SIGTERM live scheduler jobs).

## Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
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
