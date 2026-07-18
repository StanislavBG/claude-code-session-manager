# PRD Authoring Guide — Scheduler Safety Rules

This guide codifies lessons from two stuck-job incidents (fizzpop poll-hang, etch-engine post-AC overrun) into enforceable rules every PRD MUST follow. Violating these rules costs real money and wastes hours waiting at a terminal.

Before queueing a new PRD, run through the §10 checklist at the bottom.

---

## §1 Bounded waits, never unbounded polls

**Summary:** Every `until`/`while` loop that makes network calls or waits for external state MUST have a hard iteration cap that surfaces non-zero on exhaustion.

**Anti-example** (verbatim from `106-fizzpop-publish.md`):
```bash
# WRONG — what 106-fizzpop-publish did
PREV=288694
until [ "$(curl -s https://bilko.run/api/health | jq .uptime)" -lt "$PREV" ]; do
  sleep 15
done
# Outcome: 2h47m hang because static-content Render deploys never restart the Node API
# so `uptime` never dropped. Loop hung until the 4h watchdog SIGKILLed.
```

**Recommended pattern:**
```bash
# RIGHT — bounded, surfaces failure cleanly
for i in $(seq 1 20); do
  if curl -sf https://bilko.run/projects/fizzpop/ > /dev/null; then
    echo "deploy live (attempt $i)"; break
  fi
  echo "waiting for deploy ($i/20)..."
  sleep 15
done
# Smoke test downstream will diagnose the real failure if the deploy didn't land.
```

**Rule:** Every `until`/`while` network-or-state poll MUST use `for i in $(seq 1 N); do ...; done` with a hard cap. Recommended cap: 20 × 15 s = 5 min for HTTP polls. On exhaustion, print a diagnostic line and continue (let the smoke test below catch the real failure).

---

## §2 Don't add work past the acceptance checklist

**Summary:** Once every AC line is ticked, write the result and exit. Do not add polish, fixtures, generators, or "while we're here" improvements not enumerated in the PRD.

**Anti-example** (verbatim from `112-etch-engine.md`):
```bash
# WRONG — what 112-etch-engine did after declaring success
for (let seed = 100; seed < 50000 && !found; seed++) {
  const result = generateRandom({ size, rng, maxAttempts: 3 });
  if (result.ok && result.solution) { found = true; ... }
}
# Outcome: 2h44m of token burn looking for fixtures the AC did not require.
# The agent had emitted result-success at 17:44 UTC; the bonus loop ran until 20:28.
```

**Rule:** Once every AC line is checked, write the result and exit 0. If bonus work seems genuinely valuable, write a follow-up PRD and reference it in the result. Do not add any work not explicitly enumerated in an AC line.

---

## §3 Smoke tests verify; spin-waits don't

**Summary:** Prefer "do thing, run a test that asserts thing happened" over "do thing, spin until I detect thing happened."

**Rule:** After a deployment, migration, or build step, run an actual test command (`curl -sf`, `npm test`, `pnpm typecheck`) that exits non-zero on failure. A spin-wait that polls for a condition hides the failure mode; a test command surfaces the exact error.

**Pattern:**
```bash
# Deploy step above (bounded, §1)
# Smoke test — will exit 1 with a clear message if deploy failed:
curl -sf https://bilko.run/projects/fizzpop/ > /dev/null || { echo "smoke test FAILED: fizzpop not reachable"; exit 1; }
```

---

## §4 Bound any generator/search loop with max-attempts and surface-on-exhaustion

**Summary:** When iterating a search space (fixtures, seeds, brute-force), declare the maximum search size in the PRD AC and surface and HALT on exhaustion.

**Anti-example:** Same etch-engine fixture generator from §2 — `for (let seed = 100; seed < 50000 ...)` with no AC line constraining it.

**Rule:** When iterating a search space, the PRD AC MUST state the bound explicitly ("up to 1000 seeds; if exhausted, surface and HALT"). The executor knows when to give up and moves on rather than burning tokens indefinitely.

**Pattern:**
```ts
let found = false;
for (let seed = 0; seed < MAX_SEEDS && !found; seed++) {
  // ...
}
if (!found) {
  console.error(`HALT: exhausted ${MAX_SEEDS} seeds without finding a valid fixture`);
  process.exit(1);
}
```

---

## §5 Render/deploy waits are bounded and always followed by a smoke test

**Summary:** Render (and similar) deploys may take 2–10 minutes and may silently fail. Always bound the wait and follow it with a live endpoint test.

**Pattern:**
```bash
DEPLOY_OK=0
for i in $(seq 1 20); do
  if curl -sf https://bilko.run/projects/<slug>/ > /dev/null; then
    DEPLOY_OK=1; echo "deploy live (attempt $i)"; break
  fi
  echo "waiting for deploy ($i/20)..."
  sleep 15
done
# Continue regardless. Smoke test below catches the real failure.
if [ $DEPLOY_OK -eq 0 ]; then
  echo "WARNING: deploy not detected after 20 attempts; continuing to smoke test"
fi
curl -sf https://bilko.run/projects/<slug>/ > /dev/null || { echo "SMOKE TEST FAILED"; exit 1; }
```

**Rule:** A static-content deploy on Render does NOT restart the backend API. Never use `uptime` or process-restart signals to detect a static-content deploy — use the actual URL that should be live.

---

## §6 Frontmatter rules

**Summary:** Required keys are `title`, `cwd` (absolute path), `estimateMinutes`. Default to letting the filename `NN-` prefix drive grouping; include `parallelGroup` ONLY when you are deliberately interleaving across project streams.

**Required frontmatter:**
```yaml
---
title: <one line, plain English>
cwd: ~/Projects/<target-repo>
estimateMinutes: 60
---
```

**Cross-machine portability:** Write `cwd` as `~/Projects/<name>` — the parser expands `~` to `os.homedir()` at ingest time, so the same PRD file works on Linux (`/home/<u>/...`) and macOS (`/Users/<u>/...`). Absolute paths (e.g. `/home/bilko/Projects/foo`) are passed through unchanged and will break on any machine with a different home directory.

**Rules:**
- `cwd` MUST point to the target project. Prefer `~/...` for portability; only use an absolute path if you have a specific reason to pin to one machine.
- **`cwd` MUST already exist on disk at queue time.** The scheduler runs a dead-cwd guard (`fs.accessSync(cwd, fs.constants.X_OK)` in `src/main/scheduler.cjs:669-680`) *before* spawning the child, so a PRD whose `cwd` references a not-yet-created directory will exit with `-1: cwd no longer exists` and the body will never run — even if the first step of the body would have created the directory. If the PRD's purpose is to create a brand-new sibling project at `~/Projects/<new-slug>/`, point `cwd` at the parent (`~/Projects`) and make the first executable step `mkdir -p ~/Projects/<new-slug> && cd ~/Projects/<new-slug>`.
- `estimateMinutes` is used for ETA display; include a realistic estimate (note: empirical median is ~10 min, p90 ~20 min — avoid wildly inflated estimates that hide real outliers).
- `parallelGroup` in frontmatter, when present, IS honored by the scheduler (`pickNextBatch` reads `parallelGroup ?? 99` and overrides the filename NN). Use this only for cross-stream interleaving — e.g., the cellar series `122-`, `123-`, `124-` overrides to groups `113`, `114`, `115` so cellar steps fire alongside the parallel etch steps. Do NOT use it to reorder within a single stream; rename the file instead.

---

## §7 Self-containment

**Summary:** The PRD body is the executor's entire context. It runs as `claude -p "<body>"` with no conversation history.

**Rule:** Include exact file paths, function signatures if they save a Read, library versions, and the name of any sibling PRD the executor must NOT duplicate. Do not reference "the conversation", "what we discussed", "the design doc", or any other external context. If the executor would need to search for something, include the answer.

---

## §8 Scope sizing — target ~15 min, ceiling 30 (data-driven, 2026-06)

**Summary:** One PRD ≈ **~15 wall-clock minutes** of work. Empirically (400+ runs) median real run = **~7 min**, p90 = **21 min**; authored estimates ran 5–8× too high. **If you project >30 min, SPLIT.**

**Rule:** Split larger work into sequential PRDs; reference the dependency in `# Implementation notes`. PRDs in the same `NN-` group run in parallel — don't put dependent work in the same group. e2e/publish work is the failure tail: **shard test suites to one spec per PRD; never run a full suite or an endpoint-polling publish in a single PRD** (§1/§5).

---

## §9 Failure surfacing

**Summary:** Prefer `exit 1` with a one-line diagnosis over silent retries. Note: a `rateLimited` exit-1 is the scheduler's benign auto-pause (it auto-resumes at the next 5h reset), NOT an authoring failure — don't engineer retry logic for it.

**Rule:** When a step fails, print a single diagnostic line and exit 1. The scheduler marks the job `failed` and the investigator Claude reads the log. A clean failure message is worth more than a 15-minute silent retry loop. Do not swallow errors with `|| true` unless the failure is genuinely non-fatal and you explain why.

```bash
# RIGHT
npm test || { echo "HALT: npm test failed — see above"; exit 1; }

# WRONG
npm test || true   # silently continues even if tests are broken
```

---

## §10 Pre-queue checklist (the litany)

Before queueing a new PRD, verify each of these:

- [ ] **§1 Bounded waits:** Every `until`/`while` poll has a `for i in $(seq 1 N)` cap ≤ 20 iterations.
- [ ] **Every command bounded:** Every test/build/dev-server/deploy command is wrapped in `timeout` (typecheck/unit 300s, e2e 120s, `curl --max-time 15`). No bare `playwright test` / `vite` / `pnpm dev` / `curl … | head`.
- [ ] **§2 No bonus work:** AC list is the only source of work. No "while we're here" additions.
- [ ] **§3 Smoke tests + verify-before-done:** Every deploy/migration step is followed by a test command that exits 1 on failure. Run the AC test command once before declaring done; never end the run on a red test.
- [ ] **§4 Bounded generators:** Any search/seed loop has an explicit `MAX_ATTEMPTS` constant and surfaces failure on exhaustion.
- [ ] **§5 Render deploys:** Deploy waits use a live URL check, not uptime/restart signals.
- [ ] **§6 Frontmatter:** `title`, `cwd` (`~/Projects/<name>` preferred; path MUST exist on this machine), `estimateMinutes` present. `parallelGroup` only if intentionally interleaving cross-stream.
- [ ] **§7 Self-contained:** No references to "the conversation" or external context. Paths and identifiers are inline. Body is clean UTF-8 — **no NUL/control bytes** (paste-from-PDF crashes the spawn). Quick check: `grep -qP '\x00' file && echo BAD`.
- [ ] **§8 Scope:** Targets ~15 min, ceiling 30. If projected larger, split. e2e/publish sharded to one spec per PRD.
- [ ] **§9 Failure surfacing:** Errors exit 1 with a diagnostic line. No silent `|| true` swallows. (`rateLimited` exit-1 is benign auto-pause, not a failure.)
- [ ] **§11 Negative-assertion checks:** Any "this should produce NO output / NO match" check (a `grep` that should find nothing, a "no leftover X" guard) is written as an inverted conditional that exits 0 on the clean case. A bare `grep` whose success is "no match" exits 1 and trips the verifier `transcript_errors` downgrade even when the run is perfect.
- [ ] **§12 End green:** The acceptance/test gate is the LAST thing the run does; any intentionally-failing step (TDD red test, expected-nonzero probe) runs EARLY, never after the gate, and is captured (`2>&1 | tail` inside a conditional) so it doesn't surface as a bare `is_error`/`Traceback` in the final portion of the transcript.
- [ ] **§13 Recover/annotate errors & expected timeouts:** A throwaway probe that errors is re-run corrected (or annotated `# expected/handled`) right after — never left stranded; prefer a temp `.py` over a fragile inline `python -c`. An *expected* `timeout` cap (a long ingest/scan) handles exit 124 explicitly as success-with-note, not a bare `Exit code 124`. Both prevent the `transcript_errors` downgrade of a green deliverable.

---

## §11 Negative-assertion checks must exit 0 on the clean case

**Summary:** A check that asserts the *absence* of something must return exit 0 when the
thing is absent. The classic trap is `grep`: it exits **1 when it finds no match**. If your
AC says "verify no banned phrase remains" and you write a bare `grep`, the *success* path
(nothing found) surfaces as `is_error=true` in the transcript — and the verifier's
`transcript_errors` heuristic downgrades the whole run to `needs_review` even though it did
everything right.

**This actually happened** (PRD `62-x-trader-doctrine`, 2026-06-13): the doctrine was cleaned
correctly and committed, but the AC's sanity grep —
`grep -rniE "building in public|..." data/pipelines/x_session/` — found nothing, exited 1,
and a perfect run was flagged for review. Self-inflicted, by the PRD author.

```bash
# WRONG — exits 1 (is_error) exactly when the check PASSES
grep -rniE "building in public|indie hacker" data/pipelines/x_session/

# RIGHT — inverted: "found banned phrase" is the failure, "clean" exits 0
if grep -rniE "building in public|indie hacker" data/pipelines/x_session/; then
  echo "HALT: banned builder framing still present (see matches above)"; exit 1
fi
echo "clean: no banned framing"

# ALSO RIGHT — grep -q with negation, when you don't need to see the matches
grep -rqniE "building in public|indie hacker" data/pipelines/x_session/ \
  && { echo "HALT: banned framing present"; exit 1; } || echo "clean"
```

**Rule:** Whenever an AC line is phrased as "verify there are no…", "confirm X does not
appear", "no leftover…", write it as `if <detector>; then echo HALT…; exit 1; fi`. Never let
the no-match/empty-output path be the one that carries a non-zero exit. Applies to `grep`,
`rg`, `find ... | grep`, `diff` (exits 1 on differences), and any custom detector.

---

## §12 End green, and trust the verdict sentinel

**Summary:** The post-run verifier (`runVerify.cjs`) scans the transcript and downgrades to
`needs_review` on error markers (`Traceback`+`Error`, `FAIL`/`FATAL`, a tool `is_error` in the
final portion of the run). It cannot tell an *intentional* failure from a real one. Two rules
keep legitimate runs from false-tripping it.

**12a — Run the green gate LAST.** Order the run so the final command is the acceptance/test
gate. Do any intentionally-failing step EARLY:

```bash
# WRONG — red test reproduced AFTER the work; its Traceback lands late in the transcript
pytest -q                      # all green
python -m pytest tests/test_repro.py::test_bug   # ← TDD red demo, errors, trips verifier

# RIGHT — red demo first (and captured), green gate last
python -m pytest tests/test_repro.py::test_bug 2>&1 | tail -3 || true   # expected red, captured
# ... implement the fix ...
timeout 300 pytest -q          # ← LAST thing the run does; ends green
```

If you must show a failure late, capture it (`… 2>&1 | tail` inside a conditional, or assert
on the captured text) so a raw `Traceback`/`is_error` never hits the transcript bare.

**12b — The `SCHEDULER_VERDICT` sentinel is authoritative; emit it truthfully.** The scheduler's
FINISH PROTOCOL ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green AND the
commit landed (else `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1`). The verifier treats
`PASS` + a commit landed during the run as the **authoritative** signal and overrides incidental
transcript markers — this is what lets a deliberately-reproduced red test (PRD 77) or a grep
result containing "Error" (PRD 68) finish `completed` instead of `needs_review`. **Never print
`PASS` on a red gate.** The sentinel is only a safety net while it tells the truth; a lying
`PASS` converts the verifier from "catches false failures" into "ships silent failures."

**This actually happened** (PRDs 68 + 77, 2026-06-13): both committed correct work with green
suites, but 77's `systematic-debugging` red-test repro and 68's grep-"Error" substring each
tripped `transcript_errors → needs_review`, and the self-heal pass kept re-deriving the same
verdict from the immutable log — stuck indefinitely. §12 (end-green + authoritative sentinel)
is the structural fix.

---

## §13 Don't strand mid-run probe errors; annotate expected timeouts

**Summary:** §12 keeps the *final* portion of the transcript green. §13 covers the *middle* —
two executor habits that strand a bare `Traceback`/`Error`/`Exit code` the verifier then flags,
even when the deliverable is correct and committed.

**13a — A throwaway probe that errors must recover or be annotated in place.** Exploratory
`python -c`/`bash` probes that error (a quoting/f-string slip, a wrong kwarg, a bad path) leave a
bare traceback. Re-run the corrected probe immediately, or print `# expected/handled: <why>` on
the next line, so recovery is adjacent (the heuristic looks for recovery within ~10 lines).
Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner — inline
f-string/quoting errors are the top source of stranded probe tracebacks.

```bash
# WRONG — inline f-string slip strands a SyntaxError, then you move on
python -c 'print(f"{p["title"]!r[:40]}")'        # SyntaxError, bare in transcript

# RIGHT — write the probe to a temp file (no shell-quote minefield), or annotate
cat > /tmp/probe.py <<'PY'
print(repr(p["title"])[:40])
PY
python /tmp/probe.py || echo "# expected/handled: probe only, not part of the deliverable"
```

**13b — An *expected* `timeout` cap is success-with-note, not a bare `Exit code 124`.** Capping a
genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is the
correct §1/§8 behavior — but a bare `Exit code 124` reads as failure to the verifier. Branch on
124 explicitly:

```bash
timeout 120 python -m project.ingest --all || { rc=$?
  [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial; rows persist incrementally; OK" \
                  || { echo "HALT: ingest failed rc=$rc"; exit 1; }; }
```

For work that legitimately needs longer than a safe cap, run it in the background and poll a
bounded number of times (§1) rather than capping the foreground command.

**This actually happened** (PRDs 77 + 80, 2026-06-13): 77 stranded an inline-`python -c` f-string
`SyntaxError` from a throwaway permalink probe; 80 surfaced a bare `Exit code 124` from a
`timeout`-capped full-universe EDGAR ingest. Both committed correct, green, AC-complete work
(77's cursor-hold fix; 80's 6 EDGAR rows + installed cron) yet were downgraded to `needs_review`
on the incidental middle-of-run markers. 13a/13b keep the middle of the transcript clean.

## §14 Queueing PRDs from external automation

**Summary:** A downstream project (Connector Atlas, `gh-issue-5`) wanted a Slack-feedback → PRD
loop but had no documented programmatic queueing path. This section is that path.

**Decision, up front:** Is the session-manager Electron app running on this machine right now?
- **Yes** → call the `scheduler_create_prd` MCP tool.
- **No** → write the PRD file by hand into the prds directory, and accept the collision risk
  described below.

### The `scheduler_create_prd` MCP tool

Wraps `POST /admin/scheduler/create-prd` on the loopback admin API
(`src/main/adminServer.cjs`, PRD 549) via `scripts/scheduler-mcp-server.cjs`, registered in this
repo's `.mcp.json` as the `session-manager-scheduler` MCP server. An external project wanting to
call it from its own automation needs the equivalent MCP server registration pointing at this
repo's `scripts/scheduler-mcp-server.cjs`, or can call the admin HTTP route directly (same
request/response shape) using the token at `~/.claude/session-manager/admin-api.json`.

**Input** (validated server-side by `ipcSchemas.cjs`'s `schemas.schedulerCreatePrd`):

| field | type | required | notes |
|---|---|---|---|
| `title` | string | yes | one-line title, no newlines |
| `cwd` | string | yes | absolute path to the target project; validated via `config.cjs`'s `validatePath` (allowedRoots = home dir) |
| `estimateMinutes` | number | yes | integer wall-clock estimate |
| `goal` | string | yes | 2–4 sentences: what the executor builds and why |
| `acceptanceCriteria` | string[] | yes | 1–100 entries, each one verifiable checklist line |
| `implementationNotes` | string | yes | file paths, patterns, constraints the executor needs |
| `outOfScope` | string[] | no | what NOT to build |
| `slug` | string | no | kebab-case; derived from `title` if omitted |
| `parallelGroup` | number | no | opt into an existing `NN` group instead of allocating a new one |

**Return** (`{nn, filename, status}`, per `adminServer.cjs`):
```json
{ "nn": 550, "filename": "550-my-feature.md", "status": "queued" }
```
On failure the tool returns `{ ok: false, error: "..." }` (e.g. `409` if `filename` already
exists, `400` if `cwd` is rejected by `validatePath` or the payload fails schema validation).

**Worked example** (MCP tool call, e.g. from Claude Code or any MCP client):
```json
{
  "tool": "scheduler_create_prd",
  "arguments": {
    "title": "Sync Slack #feedback channel into feedback intake",
    "cwd": "~/Projects/connector-atlas",
    "estimateMinutes": 20,
    "goal": "Pull unread messages from the #feedback Slack channel and materialize each as a feedback file, deduped against already-tracked message ts.",
    "acceptanceCriteria": [
      "New feedback files land in connector-atlas's own feedback intake folder, one per undeduped message",
      "Each file's `source` field is `slack-<channel>-<ts>` for future dedup",
      "timeout 300 npm run typecheck passes"
    ],
    "implementationNotes": "Use the Slack Web API conversations.history endpoint; token lives in connector-atlas's own secrets store, not session-manager's."
  }
}
```
Server-side, this atomically allocates the `NN` prefix (`allocateParallelGroup()`, PRD 548),
appends the engineering standards block, and writes the PRD file — the same shape `/develop`
produces by hand.

### The app-must-be-running caveat (read this first)

**`scheduler_create_prd` only works while the session-manager Electron app is running on this
machine.** The admin server it depends on (`src/main/adminServer.cjs`) is hosted *inside* the
Electron process — it binds a loopback port and writes its token to
`~/.claude/session-manager/admin-api.json` on app boot (see `CLAUDE.md`'s `adminServer.cjs`
architecture entry) and stops existing the moment the app quits — it is not a standalone daemon.
If the app is closed, `scheduler-mcp-server.cjs` cannot read a live port/token and every call
returns the error `session-manager app is not running (admin API unreachable) — start it first`.
This is the single most likely point of confusion for an automation author who assumes the tool
is a normal always-on API — it is not; it is a convenience surface hosted by a desktop app that
the user may or may not have open.

### Fallback: writing the PRD file directly

When the app is not running, write `<NN>-<slug>.md` by hand into
`~/.claude/session-manager/scheduled-plans/prds/` following the frontmatter rules in §6 and the
body conventions the rest of this guide describes (`# Goal`, `# Acceptance criteria`,
`# Implementation notes`, `## Engineering standards` inlined verbatim — see `/develop`'s output
for the exact shape). **Trade-off:** this path has no atomic `NN` allocation. The tool's
`allocateParallelGroup()` (PRD 548) exists specifically to close a race where two writers pick
the same `NN` at once; a hand-written file bypasses that reservation entirely, so if another
writer (a human, `/develop`, or another automation) picks the same `NN` around the same time, one
file silently shadows or is shadowed by the other's parallel-group slot. Pick an `NN` by scanning
the existing prds directory for the current max and incrementing, and treat a collision as
possible, not merely theoretical.

### Ownership boundary

Projects own their own source adapters — Slack, GitHub, Linear, email, whatever inbound channel
they read. Session-manager owns the queueing API (`scheduler_create_prd` / the admin route) and
nothing upstream of it. Session-manager does not host, run, or import another project's adapter
code; the adapter runs entirely inside the calling project (its own cron, its own credentials,
its own filtering/triage logic) and only reaches into session-manager at the single, narrow
`scheduler_create_prd` call.

### Why project-supplied `automation-hooks.js` was declined

Connector Atlas's third ask was a mechanism to drop a project-supplied `automation-hooks.js` file
that session-manager would load and execute in-process on a timer. This was declined, and should
not be re-proposed:

- It would grant main-process privileges (full filesystem access, IPC, the admin server's own
  token) to arbitrary code from any project directory, invoked on a schedule the *project*
  controls rather than the *user*.
- It inverts this project's core invariants: `config.cjs`'s `validatePath` gate on every
  filesystem path, `ipcSchemas.cjs`'s zod-validated IPC boundary, and `CLAUDE.md`'s Avoid-list
  ban on `shell: true` outside the two features that legitimately need it. A loaded-and-executed
  project JS file has no equivalent boundary to pass through — it *is* the process.
- The supported extension point is the MCP tool described above, called from *outside* the
  session-manager process by the project's own cron/automation. That keeps the privilege boundary
  where it already is (the loopback admin server, token-authed, narrow three-route surface) rather
  than dissolving it.

### Reference implementation of this exact loop

`/process-feedback`'s step 0b (source → triage → `/develop` → queue) is a working example of this
shape, landed 2026-07-14 (`feat(process-feedback): sync open GitHub issues into the feedback
intake`, commit `352b89c`). It syncs open GitHub issues into `session-manager-operations/feedback/`
(deduped on a `gh-issue-<N>` token), then processes each item through the same triage → `/develop`
→ queue path the rest of this guide documents. An external project building a Slack (or any
other) adapter should follow the same source → triage → queue shape, ending at
`scheduler_create_prd` (app running) or a hand-written PRD file (app closed) as described above.
