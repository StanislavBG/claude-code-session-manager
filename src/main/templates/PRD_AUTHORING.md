<!-- PRD_AUTHORING.md v4 -->
# PRD Authoring Guide — Scheduler Safety Rules

Rule: every PRD you queue follows the rules below.
Why: two real stuck jobs (fizzpop poll-hang, etch-engine post-AC overrun) cost hours of wall-clock time and real money.

Before queueing, run the §15 checklist at the bottom. It is last on purpose — check it last.

---

## §1 Bounded waits, never unbounded polls

Rule: every `until`/`while` loop that polls a network call or external state needs a hard iteration cap. On exhaustion, print a diagnostic line and move on — never spin forever.
Why: `106-fizzpop-publish` polled `curl .../health | jq .uptime` for a value that could never drop (a static-content deploy doesn't restart the API). It hung 2h47m until the 4h watchdog killed it.

Pattern:
```bash
for i in $(seq 1 20); do
  if curl -sf https://example.com/health > /dev/null; then
    echo "live (attempt $i)"; break
  fi
  echo "waiting ($i/20)..."; sleep 15
done
# Continue regardless — the smoke test (§3) catches a real failure.
```

Recommended cap: 20 × 15s = 5 min for HTTP polls. Never use an uptime/restart signal to detect a static-content deploy — check the actual URL that should be live.

---

## §2 Stop at the acceptance checklist

Rule: once every acceptance-criteria line is checked, follow the finish protocol (§11) and stop. Do not add polish, fixtures, or "while we're here" work that isn't an AC line.
Why: `112-etch-engine` declared success at 17:44 UTC, then ran an unbounded fixture search until a user killed it at 20:28 — 2h44m of token burn on work no AC line asked for.

If more work seems valuable, name it in your report as a follow-up. Never queue it, and never do it now. Why: only the planner queues work.

---

## §3 Verify with a real test, not a spin-wait

Rule: after a deploy, migration, or build step, run a command that exits non-zero on failure (`curl -sf`, `npm test`, `tsc --noEmit`).
Why: a poll that waits for a condition hides the real error; a test command shows it.

```bash
curl -sf https://example.com/projects/foo/ > /dev/null \
  || { echo "smoke test FAILED: foo not reachable"; exit 1; }
```

---

## §4 Bound search and generator loops

Rule: when you iterate a search space (fixtures, seeds, brute force), the acceptance criteria must state the max attempts. On exhaustion, print a HALT line and exit 1 — never loop past the stated bound.
Why: the same etch-engine loop (§2) had no bound in its AC, so nothing told the executor when to stop.

```ts
for (let seed = 0; seed < MAX_SEEDS && !found; seed++) { /* ... */ }
if (!found) {
  console.error(`HALT: exhausted ${MAX_SEEDS} seeds without a valid fixture`);
  process.exit(1);
}
```

---

## §5 Frontmatter

Rule: every PRD needs these fields.
1. `title` — one line, plain English.
2. `cwd` — the Epic's project root, as an absolute path or `~/…`. The API always sets it to the Epic's project, whatever you pass. To work in another project, open an Epic in that project. The folder must exist when you queue.
3. `estimateMinutes` — a realistic integer. Most PRDs take 5–10 minutes (§8) — don't inflate it.

`parallelGroup` is deprecated and ignored. `dependsOn: [<slug>, ...]` is the only ordering primitive.

`planId` is written by the API, never by you. It groups PRDs into the plan (wave) they belong to: an `append` PRD, or one with an explicit `dependsOn`, inherits the `planId` of the PRD it attaches behind; a fresh PRD mints a new one.

Artifact-only PRDs (`deliverable: artifact` + `artifactPaths: [...]`) — use this ONLY when every deliverable is a file the repo deliberately git-excludes, so "no commit" is the correct outcome, not a miss.
1. Every artifact path is listed in `artifactPaths` and is relative, never `..`.
2. Each file must be non-empty and written during the run window — the verifier stat-checks it on disk.
3. The tree must still end clean. A declared artifact excuses the missing commit, not a stray tracked edit.
4. Both fields are required together — passing one without the other is refused.

Why: PRD `816-prepare-157-copy-citation-extras-patch` wrote its patch into a git-excluded folder with no way to declare that, and parked `needs_review` twice.

---

## §6 Gate and files

Both fields are required in every `scheduler_create_prd` call.

### gate

1. 1–10 commands. The scheduler re-runs them, in order, after the executor finishes. Each must exit 0.
2. Start each command with `timeout <seconds>`. Why: a command without a timeout can hang the run.
3. Join steps inside one entry with `&&`.
4. The scheduler runs gate commands without a shell, so shell syntax is refused. Outside single quotes, do not use `|` `<` `>` `;` `&` (only `&&` between steps), backticks, `$`, `\`, `*`, `?`, `[`, `]`, `(`, `)`, `{`, `}` or `!`. Inside double quotes, `$`, backticks and `\` are refused too.
5. Do not start a word with `#` or `~`, and do not put `~` right after `=` or `:`. `HEAD~1` is fine.
6. Put text with these characters inside single quotes, for example `rg -n 'a|b' src/`. A check that needs a shell belongs in a test file that the gate runs.
7. Keep each entry on one line, at most 500 chars, with plain spaces between words.
8. Use `["none"]` only for docs or config with no runnable check. Write exactly `none`. Never mix `none` with commands.
9. A leading `TMPDIR=$(mktemp -d) ` and `NAME=value` words are allowed before the command.

### files

1. 1–50 repo-relative paths. A folder ends with `/`.
2. No absolute paths, no `~` at the start, no `..` or `.` segments, no `*` or `?`, no `\` or backticks, no leading `-`. Use `/` between folders.
3. PRDs that can run at the same time must not share a file. If two PRDs touch the same file, chain them with `dependsOn`.

### What the API writes

The API writes the frontmatter and renders two body sections from the fields above: `# Files` (right after `# Acceptance criteria`) and `# Gate` (after `# Out of scope`, before `## Engineering standards`). Do not write those two sections yourself, and do not put a gate fence (three backticks + `gate`) in the goal, notes, or criteria — the API rejects that. For `["none"]`, the Gate section says the PRD has no runnable check and to verify each AC line by reading the files, with the fence holding the single word `none`.

### Acceptance criteria

Plain, checkable statements. Commands go in `gate`, not in the criteria.

---

## §7 Self-containment

Rule: the PRD body is the executor's entire context — it runs as `claude -p "<body>"` with no conversation history. Include exact file paths, signatures, library versions, and any sibling PRD not to duplicate. Never write "the conversation" or "the design doc" — if the executor would need to search for an answer, put the answer in the PRD.

A short Epic-context digest is prepended automatically for orientation only — never load-bearing; write the body as if it won't be there.

The executor can't ask you anything: no `ScheduleWakeup`, Cron, Monitor, `AskUserQuestion`, plan mode, or worktree tools; background tasks are off (a `timeout` command is always on PATH — the app installs a shim on macOS). It must never stop to ask a question — it makes the safest reasonable call and reports it, so write the PRD so that call is obvious.

---

## §8 Scope sizing — target ≤10 min, ceiling 15

Rule: one PRD is ≤10 wall-clock minutes of work. If you project more than 15, split it into sequential PRDs and link them with `dependsOn`.
Why: 2026-09 data put wall p50 at 7.8 min, with 60% of runs ≤10 min — authored estimates ran 4× too high.

e2e and publish work is the long tail: shard test suites to one spec per PRD. Never run a full suite, or an endpoint-polling publish, in a single PRD (see §1/§3).

---

## §9 Failure surfacing

Rule: when a step fails, print one diagnostic line and exit 1. Don't swallow errors with `|| true` unless the failure is genuinely non-fatal — say why inline when you do.
Why: a clean failure is worth more than a 15-minute silent retry loop; the scheduler marks the job `failed` and the investigator reads the log.

```bash
npm test || { echo "HALT: npm test failed — see above"; exit 1; }
```

Note: a `rateLimited` exit-1 is the scheduler's own benign auto-pause (it resumes at the next 5h reset) — don't engineer retry logic for it.

---

## §10 Negative-assertion checks must exit 0 on the clean case

Rule: a check that asserts something is ABSENT must exit 0 when it's absent. Write it as `if <detector>; then echo HALT...; exit 1; fi` — never leave the no-match path carrying the non-zero exit.
Why: `grep` exits 1 when it finds nothing. PRD `62-x-trader-doctrine` cleaned up correctly, but its sanity `grep` for a banned phrase found nothing, exited 1, and a perfect run was flagged `needs_review` by the verifier's `transcript_errors` check.

```bash
if grep -rniE "banned phrase" path/; then
  echo "HALT: banned phrase still present"; exit 1
fi
echo "clean"
```

Applies to `grep`, `rg`, `diff` (exits 1 on any difference), and any custom detector.

---

## §11 End green, and trust the verdict line

Rule: order the run so the acceptance/test gate is the LAST command. Run any intentionally-failing step (a TDD red test, an expected-nonzero probe) EARLY, and capture its output (`2>&1 | tail` inside a conditional) so a bare `Traceback`/`is_error` never lands in the final part of the transcript.
Why: the post-run verifier scans the transcript and downgrades to `needs_review` on error markers — it can't tell an intentional failure from a real one.

```bash
# RIGHT — red demo first and captured, green gate last
timeout 120 python -m pytest tests/test_repro.py::test_bug 2>&1 | tail -3 || true   # expected red
# ... implement the fix ...
timeout 300 pytest -q   # LAST thing the run does
```

The scheduler appends a finish protocol after your PRD's own steps — you never write it: review, then the `# Gate` commands (§6), then commit only the exact paths you created or changed for this PRD, then the verdict line — `SCHEDULER_VERDICT: PASS` once the gate is green and the commit landed, else `SCHEDULER_VERDICT: FAIL <one-line reason>`. The verifier trusts a truthful `PASS` plus a landed commit over stray transcript markers. Never print `PASS` on a red gate.

---

## §12 Don't strand mid-run probe errors; annotate expected timeouts

Rule: a throwaway probe that errors (a bad quote, a wrong kwarg) must be re-run corrected right after, or annotated `# expected/handled: <why>` on the next line — never left stranded. Prefer a temp `.py` file over a fragile inline `python -c` one-liner.

Rule: an *expected* `timeout` cap (a long ingest/scan you expect to hit it) is success-with-note, not a bare `Exit code 124` — branch on it explicitly:
```bash
timeout 120 python -m project.ingest --all || { rc=$?
  [ $rc -eq 124 ] && echo "hit time cap — partial, rows persist; OK" \
                  || { echo "HALT: ingest failed rc=$rc"; exit 1; }; }
```
Why: both a stranded probe traceback and a bare `Exit code 124` read as failure to the verifier even when the committed work is correct and green (PRDs 77, 80 — 2026-06-13).

---

## §13 Queueing PRDs from external automation

Decision: is the session-manager app running on this machine right now?
- Yes → call the `scheduler_create_prd` MCP tool, with the usual fields (`title`, `cwd`, `estimateMinutes`, `sourcePromptId`, `goal`, `acceptanceCriteria`, `implementationNotes`) plus `gate` and `files` (§6).
- No → stop. Ask the human to start the app, then call the tool again. Never write the PRD file by hand: the scheduler quarantines a file the API did not write, and it never runs.

It only works while the app is running — closing it removes the admin port/token, and the call fails with `session-manager app is not running (admin API unreachable)`.

---

## §14 A parked job may resolve itself now

Rule: if a job parks `needs_review` with verdict `transcript_errors`, `no_verdict_sentinel`, or `abandoned_background_task`, do nothing first. The scheduler re-runs the gate on its own and completes the job once the gate is green, the commit is on HEAD, and the tracked tree is clean.
Why: those three verdicts mean the transcript looked noisy, not that the work was wrong.

Rule: a park caused by a DIFFERENT actor already finishing the same objective (a sibling PRD, a human) does not self-heal this way. Why: the job has no landed commit of its own. Confirm in the tree that the work is really done, then call `scheduler_archive_prd` with the slug. Archiving marks the job completed and frees the PRDs that depend on it. Never hand-edit `queue.json`: the scheduler and the watchdog both write it. Archiving clears a stale label; it does not fix a real bug.

Known gap: `pass_no_commit` ("already correct, nothing to commit") isn't yet in the self-heal list above for the general case.

---

## §15 Pre-queue checklist (the litany)

Before queueing a new PRD, verify each of these:

- [ ] **§1 Bounded waits:** every poll loop has a `for i in $(seq 1 N)` cap ≤20 iterations; no uptime/restart signal used to detect a static-content deploy.
- [ ] **Every command bounded:** every test/build/deploy command is wrapped in `timeout` (typecheck/unit 300s, e2e 120s, `curl --max-time 15`).
- [ ] **§2 No bonus work:** the AC list is the only source of work.
- [ ] **§3 Verify, don't poll:** every deploy/migration step is followed by a test command that exits 1 on failure; the AC test command ran green once before you declare done.
- [ ] **§4 Bounded generators:** any search/seed loop has an explicit max and surfaces failure on exhaustion.
- [ ] **§5 Frontmatter:** `title`, `cwd` (exists on this machine), `estimateMinutes` present; `dependsOn` used for ordering, not `parallelGroup`.
- [ ] **§6 Gate and files:** `gate` is 1–10 timeout-wrapped commands (or `["none"]` alone), no shell operators; `files` is 1–50 repo-relative paths, no overlap with a concurrent PRD.
- [ ] **§7 Self-contained:** no reference to "the conversation" or outside context; paths/identifiers inline; clean UTF-8, no NUL bytes (`grep -qP '\x00' file && echo BAD`).
- [ ] **§8 Scope:** targets ≤10 min, ceiling 15; e2e/publish sharded to one spec per PRD.
- [ ] **§9 Failure surfacing:** errors exit 1 with a diagnostic line; no silent `|| true`.
- [ ] **§10 Negative assertions:** every "should find nothing" check is inverted to exit 0 on the clean case.
- [ ] **§11 End green:** the gate runs last; any intentional failure runs early and is captured.
- [ ] **§12 No stranded probes:** a probe error is corrected or annotated; an expected `timeout` cap branches on exit 124.
