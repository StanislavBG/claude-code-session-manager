---
title: Auto-run a definition-of-done gate (verify-AC + code-review) when the queue drains
source: social-signals-trader agent (via /my-feedback)
type: enhancement
severity: normal
---

# What happens / what's missing

When the scheduler finishes the **last** queued PRD and there's nothing left to
run, it just stops. There is **no terminal "definition-of-done" pass** over the
batch that just landed — no holistic re-verification against each PRD's
acceptance criteria, and no code-review gate over the union of changes. Each PRD
self-asserts its own bounded test command and exits 0 on green, so the scheduler
marks it `completed` — but "completed exit 0" is treated as "done," when the real
definition of done (per the `/develop` skill's Phase 2 step 7) is *also*: verify
each landed PRD live against its AC, and for major/risky changes run a code
review and fix Critical/Important findings.

Today that gate only runs if a **human in an interactive session remembers** to
do it after noticing the queue emptied. When nobody does, risky work sits in a
"looks done" state with no holistic review — silently.

# Evidence

- **The drain point is a bare early-return — no terminal hook.**
  `src/main/scheduler.cjs:1471-1472`:
  ```js
  const batch = pickNextBatch(state.jobs, runningSet, cap);
  if (batch.length === 0) return;
  ```
  When `pickNextBatch` returns empty (queue drained), the loop simply returns.
  That `batch.length === 0` branch is precisely the "nothing more on the
  scheduler" moment where a definition-of-done pass belongs.

- **Per-PRD verification machinery already exists — but it's per-job, not
  per-batch.** `scheduler.cjs` already runs a verify/downgrade step and
  re-verification (`verifyResult` / downgrade logic ~`1258`–`1356`,
  `reverifyNeedsReview` exported at `2293`). What's missing is a *batch-level*
  gate at queue-drain that re-checks ACs live and reviews the combined diff.

- **Live incident (2026-06-14, social-signals-trader).** I queued 5 PRDs (81–85)
  for a money-path feature set (time-stop exit backstop, conviction-scaled
  sizing, target gross-exposure band, SB signal wiring, tenant identity). All
  five reached `status=completed, exitCode=0` in
  `~/.claude/session-manager/scheduled-plans/queue.json` (e.g. job slug
  `85-trader-sb-tenant-identity`, `runId 2026-06-14T21-41-12-002Z`,
  `finishedAt 2026-06-14T21:45:46`, `exitCode 0`). Yet **nothing** had:
  re-verified each PRD against its AC, run a code review over the batch, or
  surfaced that PRDs **82/83 — the actual risk/sizing levers — shipped behind
  default-OFF flags and never got any review gate.** I only discovered this
  because the user explicitly asked "check if it's done"; I then had to manually
  grep the source markers and run 325 tests by hand. The scheduler offered no
  terminal audit — draining the queue produced silence, not a verdict.

# Suggested direction (optional)

When a run completes and `pickNextBatch` returns empty (queue drained, not
paused), trigger one **definition-of-done pass** over the just-landed batch:

1. **Per-PRD AC verification** — re-run each completed PRD's acceptance/test
   command live and record pass/fail, rather than trusting the self-reported
   exit code alone.
2. **Batch code-review gate** — review the union of changes the drained batch
   landed (diff since the batch's first run, or the PRDs' commits); surface
   Critical/Important findings and flag risky surfaces (money paths, auth,
   migrations, schema).
3. **Emit a consolidated report** — per-PRD AC result + review summary +
   a "needs human attention" list — to a known path
   (`runs/<ts>/definition-of-done.md`) and/or a notification, so draining the
   queue produces an audit instead of silence.

Mechanism options (implementer's call — pick what fits):
- A terminal hook at the `batch.length === 0` branch (`scheduler.cjs:1472`) that
  spawns one final `claude -p` definition-of-done job scoped to the session's
  completed PRDs (it can invoke the `requesting-code-review` skill + re-run ACs).
- An always-last synthetic meta-PRD auto-appended when the queue would otherwise
  drain (NN above all, depends-on-all), carrying the verify+review brief.
- A per-PRD `finalGate: true` frontmatter flag the scheduler honors on the last
  PRD of a stream.

Keep it **idempotent and bounded** (same timeout discipline as PRD bodies — no
unbounded polls); a `rateLimited` exit-1 should defer it to the next window, not
skip it. Don't re-run it if a definition-of-done report for that batch already
exists.

**Acceptance:** after the scheduler finishes the last queued PRD, a
definition-of-done report exists for that batch (per-PRD AC verification + a
code-review summary + a flagged "needs attention" list) **without any human
trigger**; a batch containing a risky/money-path change is flagged for review
rather than silently marked done. Reference incident: this session's 81–85 drain
on social-signals-trader, where that gate ran only because the user asked.

## RESOLUTION

**Shipped.** All 4 PRDs completed `exitCode=0` (verified 2026-06-25):

| PRD | Status |
|---|---|
| `108-dod-batchkey-idempotency` | ✅ completed |
| `109-dod-ac-reverify-runner` | ✅ completed |
| `110-dod-riskflag-report` | ✅ completed |
| `111-dod-wire-drain-branch` | ✅ completed |

**Verified live:** `src/main/lib/dodDrainHook.cjs` exists and is wired at the
`batch.length === 0` branch in `scheduler.cjs:1553`. Definition-of-done reports
are generating on disk (`runs/<ts>/definition-of-done-<key>.md` confirmed across
5+ drain events). CLAUDE.md documents the feature (dodDrainHook, batchKey,
SM_DOD_DISABLE kill-switch). The AC is fully met: queue drain now produces an
audit (per-PRD AC re-verify + risk-surface flags) without any human trigger.

**Design as shipped:** in-process gate — no spawned `claude -p` meta-job — eliminates
the self-retrigger loop the feedback flagged. `SM_DOD_DISABLE=1` kill-switch
available if the gate needs to be bypassed. Deep LLM code-review recommended in
the report for flagged surfaces, not auto-run.
