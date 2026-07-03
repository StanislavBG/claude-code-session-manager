---
name: optimize-kpi
description: >-
  Project-agnostic North-Star-KPI optimization cycle. Reads the current project's
  declared North-Star KPI from its CLAUDE.md, measures it, audits real
  consumption/usage telemetry + operational logs, grades the prior iteration's
  filed lever, then fans out 3 INDEPENDENT recommender agents (Fable 5, max
  thinking) that each diagnose the gap and propose the single
  highest-leverage improvement — every recommendation grounded in usage + logs,
  not the scorecard alone; one consolidator agent merges them into ONE feedback
  item filed into this project's own feedback inbox plus a ranked backlog.
  Implementation is NEVER done inline — it always goes through the scheduler via
  /process-feedback → /develop. Use whenever the user says "/optimize-kpi",
  "optimize the KPI", "improve our north-star metric", or runs the daily KPI
  optimization loop. Keywords: optimize, KPI, north-star, metric, coverage,
  recommenders, consolidate, feedback, scheduler, attribution.
model: fable
---

# /optimize-kpi — measure → grade last lever → 3 recommenders → consolidate → file → scheduler

You are the optimization driver for **whatever this project has declared as its
North-Star KPI**. You do not implement code. Each run is one closed iteration of a
*converging* loop: **discover the KPI → measure + validate → grade the prior
lever → fan out 3 independent recommenders → consolidate into one feedback item +
backlog → hand off to the scheduler → log**.

**Non-negotiable: never implement, review, commit, publish, or reboot inline.**
The single consolidated recommendation is filed into this project's own feedback
inbox and dispatched through **`/process-feedback` → `/develop`**, which queues
PRDs onto the session-manager scheduler and tracks them to done. Bypassing the
scheduler is the one thing this skill must not do.

**Autonomy contract.** This skill is usually driven headless by a cron with
`--dangerously-skip-permissions`, so it must run to completion without human
input. **Never call `AskUserQuestion` or otherwise block on a prompt in loop
mode.** If a decision genuinely needs the operator, take the reversible default,
record the open question as a `> NOTE:` line in the feedback item, and continue —
do not stall the loop. (Interactive, user-invoked runs may ask; detect this by
whether a human is in the turn.)

## Step 0 — Discover the project's North-Star KPI (do not assume)

The KPI lives in the project's mission statement: read `./CLAUDE.md` and find the
section whose heading names the **North-Star KPI** (e.g. `## Objective &
North-Star KPI`). That section is the authority. Extract, by reading it and the
files it points to:

- **The KPI statement** — what is being optimized, the target (usually 100% / a
  ceiling), and the precise definition doc it links (e.g. `docs/<kpi>.md`).
- **The measurement command** — the scorecard/metric script it names (e.g.
  `scripts/coverage_scorecard.py`). Prefer a `--json` form and a `--trend N`
  form if they exist.
- **The driving pipeline(s)** — which scheduled job(s) actually move the metric
  (the gatherer/worker named in the KPI section or registry). You need this for
  the validity gate in Step 1.
- **The usage / consumption audit** — how the project's *outputs* are consumed
  and the operational logs that show whether the machine is healthy. The CLAUDE.md
  observability/telemetry pointer names them (e.g. a usage-audit script over a
  request log, a metrics endpoint, the run-history DB, `data/logs/`). Capture the
  exact audit command(s). If the project exposes **no** consumption telemetry at
  all, that itself is a finding — recommend adding it.
- **The levers** — the files the section names as the knobs (tiers/config,
  selection, throughput/cadence/registry, etc.).
- **The feedback intake** — `feedback/` (or `external-feedback/`) at the repo
  root, and its `README.md` convention.

**If CLAUDE.md declares no North-Star KPI section, STOP** and tell the user this
project hasn't declared one — the KPI belongs in CLAUDE.md's mission statement
(that's the convention this skill reads), and ask them to add it before running.

Capture the discovered KPI statement, measurement command, driving pipeline,
lever files, and intake path — you pass all of them verbatim into the recommender
agents so they work from the project's own definition, not your guess.

## Step 1 — Measure + validity gate (don't tune a corpse)

Run the discovered measurement command in both its snapshot and trend forms (e.g.
`<scorecard> --json` and `<scorecard> --trend 14`). Read the JSON outputs. Record:
today's KPI value, any floor/SLO breaches, per-segment breakdown, the
worst-performing units, and the trend direction over the last several days. This
evidence block is the shared input every recommender receives.

**Validity gate — before diagnosing, prove the metric is real.** A low KPI has
two very different causes: a *mis-set knob* (a tuning problem) or *the driving
pipeline didn't run / is wedged* (an ops problem). Confirm the Step-0 driving
pipeline actually produced work in the measurement window — check the
orchestrator/run history (last successful run, duration, whether it hung to its
max-duration cap or held a lock). If the pipeline **did not run a healthy cycle
in the window**, the metric is an artifact:

- Do **not** run the recommender fan-out. A selection/tiering "fix" against a
  dead pipeline is noise.
- File a single feedback item whose Ask is **"restore the driving pipeline"**
  (cite the stuck/missing runs), hand it to the scheduler (Step 5), log it, and
  stop the iteration there.

Only when the metric reflects a pipeline that genuinely ran do you proceed to the
tuning loop.

## Step 1b — Audit usage + logs (MANDATORY evidence, not optional)

The scorecard says *how high* the KPI is; it never says *why*. The why lives in
how the project's outputs are actually consumed and what the logs are screaming.
**This step is required every run — a recommendation that cites only the
scorecard is rejected in Step 4.**

- **Usage / consumption audit.** Run the Step-0 usage-audit command (for a
  contract/MCP project, the per-consumer + per-tool telemetry; for others, the
  request/access log or metrics endpoint). Extract: who the consumers are, the
  call distribution across outputs, **dark outputs** (shipped but never consumed),
  **error hotspots** (esp. a write/auth path failing silently), and **latency/SLO
  breaches**. Consumption shape tells you what's load-bearing vs dead weight — you
  do not optimize what nobody reads, and a silently-failing consumer is often the
  real KPI gap.
- **Operational-log audit.** Scan the run history + `data/logs/` (or the
  project's log sink) for failed/stuck runs, repeated errors, max-duration
  overruns, and lock contention in the measurement window. These are frequently
  the *direct* root cause of a depressed KPI (e.g. the gatherer hitting its
  duration cap → fewer units visited → coverage falls) — and they're invisible to
  the scorecard.

Produce a compact **usage+log evidence block** alongside the Step-1 scorecard
block. Both are handed to every recommender. If the audit surfaces an ops failure
that is *itself* the dominant KPI cause (a dead consumer, a crashing pipeline),
treat it like the validity gate: the recommendation is "fix that," and you may
skip the tuning fan-out.

## Step 2 — Grade the prior lever + read in-flight work (close the loop)

Before proposing anything new, find out what the *last* iteration did and whether
it worked. Open-loop optimizers don't converge — this step is what makes the loop
learn.

- **Read the optimization log** (`docs/kpi-optimization-log.md`, if present) for
  the last filed lever, its predicted effect, and its measure-by date.
- **Check whether it shipped:** look at the feedback folder (is last run's item
  ✅/archived?) and the scheduler's PRD history for the ids it queued. Status:
  *not yet queued* / *queued, running* / *shipped on `<date>`* / *failed*.
- **Grade it against the metric:** if it shipped, compare the KPI/breach numbers
  before vs after its ship date using the Step-1 trend. Did it move the metric in
  the predicted direction and magnitude? Record `helped` / `no-effect` /
  `regressed` / `too-early-to-tell`.
- **Build the in-flight + cooldown set:** list every lever currently *queued or
  awaiting its first post-ship measurement*. These are **off-limits this run** —
  do not let the recommenders or consolidator re-file a lever that is already in
  flight or whose effect hasn't been measured yet (cooldown). Re-filing the same
  ask stacks duplicate PRDs on the scheduler and never learns.

Carry forward into Step 3: `{last lever, its grade, why it under/over-performed,
the in-flight/cooldown lever set}`.

## Step 3 — Fan out 3 INDEPENDENT recommenders (parallel)

Spawn **3 Agent calls in a single message** so they run concurrently and blind to
each other. Each is a peer doing the full diagnosis independently — divergence is
the point; do not coordinate them. (Default panel = 3; you may scale to 4–5 when
the gap is large and token budget allows, or drop to 2 for a tiny gap — note the
choice.)

- **Model:** `fable` (Fable 5) with **failover to `opus`, then `sonnet`** — launch
  each agent with `model: fable`; if an agent dies on a model/availability error,
  re-spawn that one with `model: opus`, and `sonnet` only if opus is also
  unavailable. A **mixed panel** (some fable, some opus/sonnet) is fine — don't
  block waiting for a uniform fleet. Instruct each to think at **maximum depth**
  before answering.
- **Prompt (identical for all 3, vary only an angle hint):** give each the KPI
  statement, the definition doc path, the Step-1 scorecard block, the **Step-1b
  usage+log evidence block**, the **Step-2 prior-lever grade + in-flight/cooldown
  set**, the lever files, and the project's standing design directives from the
  KPI section. Ask each to:
  1. Diagnose *why* the KPI is below target — name the single root cause with the
     highest expected KPI delta. **Ground the diagnosis in the usage+log evidence,
     not the scorecard alone:** cite the specific consumer behaviour, dark output,
     error hotspot, or failing/over-running run that supports the root cause. A
     diagnosis with no usage/log citation is not acceptable. Account for the prior
     lever's result: if it under-performed, say why and whether to escalate or
     abandon it.
  2. Propose ONE concrete, highest-leverage change as numbered implementation
     steps an executor could follow without further design: exact file(s), the
     change, the lever value, the **expected KPI/breach delta as a falsifiable
     numeric target with a measure-by horizon** (e.g. "floor breaches 82→<40
     within 2 days"), and how the next measurement run will confirm it. Quality
     bar / service contracts stay fixed — never raise the KPI by lowering a
     quality gate. **Must not** be a lever in the in-flight/cooldown set.
  3. State assumptions and the one risk that would make it backfire.
  Give each a different framing nudge so they don't converge: e.g. agent 1
  "selection/throughput first", agent 2 "tiering/cadence/targets-achievability
  first", agent 3 "consolidation/architecture first". The nudge biases the lens,
  not the conclusion — each still considers all levers.
- **Output:** each agent **writes its recommendation to a temp file** and returns
  the path. Use a per-run temp dir derived from the project + date, e.g.
  `downloads/optimize-kpi/<YYYY-MM-DD>/agent-{1,2,3}.md` (create it; fall back to
  `/tmp/optimize-kpi-<date>/` if `downloads/` doesn't exist). One file per agent,
  full reasoning + the numbered steps. (Old per-run dirs are disposable — GC dirs
  older than ~14 days when you create today's.)

## Step 4 — Consolidate into ONE recommendation + a ranked backlog (single agent)

Spawn **one** consolidator agent (same `fable`→`opus`→`sonnet` failover, max thinking).
Give it the 3 temp files **and** the Step-2 in-flight/cooldown set. It must:

- Read all three, dedupe overlapping ideas, and **score** the distinct proposals
  by expected KPI delta × achievability × reversibility.
- **Reject any proposal not grounded in the usage+log evidence** — a root cause
  citing only the scorecard is not eligible. The winning lever must trace to an
  observed consumer behaviour, dark output, error hotspot, or failing/over-running
  run.
- **Drop any proposal that collides with the in-flight/cooldown set** (already
  queued or awaiting measurement) — those are not eligible this run.
- **Pick the single highest-leverage *eligible* lever** to change this iteration
  (resist bundling — one lever per iteration), grafting the best supporting ideas
  from the runners-up into the plan where they strengthen it.
- Verify targets are achievable for real throughput — if a proposal sets targets
  the system can't meet, say so and adjust rather than let the KPI lie.
- **Route the lever by ownership first.** If the winning lever's root cause
  belongs to an **upstream/downstream service** — the data source hasn't gathered
  the inputs, an upstream contract drifted, a consumer needs a change — the
  deliverable is a **cross-project filing via `/my-feedback <project>`** into THAT
  service's intake, not a this-project item this repo can't action. (Canonical
  case: signal-builder's sellable-KPI binding constraint is frequently the
  `acquisition` cohort — tickers Burrow simply hasn't gathered — which is filed to
  `burrow`, per this project's CLAUDE.md North-Star section.) A this-project-owned
  lever is filed here (next bullet); a **mixed** lever splits — the local half here
  via `/develop`, the upstream half via `/my-feedback`, each cross-referencing the
  other. Leaving an upstream-owned lever buried as a local item it can't fix is the
  failure mode this rule exists to prevent.
- **Write ONE consolidated feedback item** (for the this-project-owned half) into
  this project's intake folder, named by the folder README's convention
  (`feedback/<YYYY-MM-DD>-NN-kpi-optimization.md`, next free `NN`), with: title,
  **From:** `optimize-kpi loop`, date (PT), priority + why, **TL;DR**, **Evidence**
  (cite the Step-1 scorecard numbers, the **Step-1b usage+log findings** the root
  cause rests on, *and* the Step-2 prior-lever grade), **Why it matters**
  (expected KPI gain), and **Ask** (the numbered implementation steps from the
  winning proposal). The Ask **must** carry a falsifiable acceptance test: the
  numeric success criterion + measure-by date the next run will grade it against.
  Note which of the 3 agents it drew from and why it rejected the others.
- **Write/refresh a ranked backlog** at `docs/kpi-optimization-backlog.md`: the
  eligible-but-not-chosen levers, ranked, each with its one-line rationale and
  expected delta. The next iteration reads this first and can pull the next-best
  lever without re-deriving from scratch. Remove entries that shipped or went
  stale.

The consolidator writes the feedback file + backlog; it does **not** touch
project source.

## Step 5 — Hand off to the scheduler (do NOT implement)

Dispatch the consolidated item through the scheduler pipeline:

- Invoke **`/process-feedback`**, scoped to the one file you just wrote (name it
  explicitly — never let it sweep unrelated open items). `/process-feedback`
  evaluates it and queues the codeable work as PRDs via **`/develop`** onto the
  session-manager scheduler, then tracks those PRDs to completion.
- This skill does **not** edit code, run `/code-review`/`/security-review`, bump
  `VERSION`, commit, or reboot anything. All of that happens as the scheduled
  PRDs run headlessly. Your job ends at "filed + dispatched + tracked".

## Step 6 — Log the iteration

Append one line to `docs/kpi-optimization-log.md` (create if missing):
`<date> | KPI <today> (trend <dir>) | breaches <n> | prior lever: <one-line> → <helped|no-effect|regressed|too-early> | lever filed: <one-line> (target: <numeric>, by <date>) | feedback: <file> | PRDs: <ids or "queued">`.
This is the running record — and the input Step 2 grades next time.

## Stop conditions

- **No KPI declared** (Step 0) → STOP, ask the user to add it to CLAUDE.md.
- **Validity gate fails** (Step 1) → file the "restore the driving pipeline" item,
  hand off, log, and stop the iteration — skip the tuning fan-out entirely.
- **Step-1b audit finds an ops failure that is itself the dominant KPI cause**
  (a dead/failing consumer, a crashing or max-duration-overrunning pipeline) →
  file *that* fix and skip the tuning fan-out; it outranks any tuning lever.
- **KPI already at/above target** with zero breaches for 2 consecutive days →
  file a *consolidation / quality-hardening* recommendation instead of a coverage
  one (move toward the architecture end-state the KPI section describes).
- **Everything eligible is in-flight/cooldown** (Step 2 leaves no eligible lever)
  → do not invent a duplicate. Log "no eligible lever — N in flight" and stop;
  next run grades them.
- **Measurement, the agents, or `/process-feedback` fail** → STOP, leave the tree
  untouched (you never modified source anyway), and report what broke. Never file
  a recommendation built on a failed measurement.

## Scheduling

Typically run as a daily `/loop` (the project may install a cron that drives this
skill headless). Each firing runs Steps 0–6 once. Because implementation is
delegated to the scheduler, this skill stays fast and side-effect-light: its only
writes to the repo are the temp recommender files, the one feedback item, the
backlog, and the log line.
