---
name: process-feedback
description: >-
  Process the current project's inbound feedback folder end-to-end: read every
  open item, evaluate it against real code, and for work that belongs to this
  project queue it as scheduled PRDs via /develop (never implement inline),
  archive the item as processed **the moment it is queued** (the scheduler owns
  execution from there), and fold lessons back into the folder's README so
  future feedback (written by other agents/projects) gets better. Use whenever the user says "/process-feedback",
  "review the feedback folder", "work through the feedback", "any open
  feedback?", or drops new files into feedback/. Keywords: feedback, intake,
  external-feedback, cross-project requests, process feedback, triage feedback.
model: opus
---

# process-feedback

**Role:** the *agent-side intake* for the dev pipeline — the project-to-project complement of
an interactive human prompt. It evaluates inbound feedback, dispatches the codeable parts to
`/develop` (the shared pipeline), and owns the feedback-specific bookkeeping (status log,
RESOLUTION, archive). It does **not** implement, and it does **not** re-specify how PRDs are
tracked — that lives once, in `/develop` Phase 2.

Work the project's intra-project feedback intake (`feedback/` at the repo root;
some projects name it `external-feedback/`). Each file is a request from an
upstream/downstream service in the same stack (e.g. Burrow ⇄ signal-builder ⇄
social-signals-trader). The folder's own `README.md` is the authority on file
conventions — read it first; the steps below are the process.

**Core principle:** this skill *triages and dispatches*; it does not implement.
Anything that requires writing code for this project is decomposed and queued as
scheduled PRDs through **`/develop`**, which runs them headlessly on the
session-manager scheduler. **process-feedback is done the moment every item is
dispositioned — queued as a PRD, declined, or forwarded — and archived; the
scheduler owns execution from there on.** It does NOT hold items in the inbox
waiting for PRDs to land, and it does NOT babysit the scheduler. Implementing
feedback inline — bypassing the scheduler — is the one thing this skill must not
do.

**Definition of done (resilience contract):** the actionable inbox is empty.
Every open item has been turned into a scheduler PRD (or declined / forwarded
with a reason), given a `## RESOLUTION`, and moved to `processed/`. Archival
happens at **disposition time, not delivery time** — once an item is a queued
PRD, its job is done and the file is archived immediately. The README
status-log **row** (🛠) is the durable execution tracker that lives on after the
file is archived; it is reconciled 🛠→✅ (and failures flagged) by
`/project-status`'s scheduler-PRD audit, cross-referencing the queue — never by
process-feedback blocking on it. A pass that leaves a queued item sitting in the
inbox "until its PRD lands" is the non-resilient bug this contract exists to
prevent.

## Steps

### 0. Quick-exit — bail in milliseconds if there's nothing to do

**Do this first, cheaply, before reading any code or spawning anything.** This
skill is run on a schedule across many projects (the scheduler's feedback sweep),
so the empty case must cost almost nothing:

- If neither `feedback/` nor `external-feedback/` exists → report
  "no feedback intake in `<project>`" and **EXIT**.
- If the folder exists but holds **no open item** (every file is in `processed/`
  or marked ✅/archived; nothing open/🆕) → report "no open feedback in
  `<project>`" and **EXIT immediately**. Do NOT read source, evaluate, or start
  an agent loop.
- Only when at least one **open** item exists do you continue — an open item
  means *someone cares about this project*, so it's worth the full pass (and,
  per step 6, leaving the README better for next time).

### 1. Read the intake

- Read `feedback/README.md` (conventions + the status log), then every open/🆕
  file still in the inbox. Under this contract a **🛠 (queued) item has already
  been archived to `processed/`** at disposition time — so anything still sitting
  in the inbox is genuinely un-dispositioned and needs a pass. You will not find
  🛠 items in the inbox to "re-check"; their execution is tracked by the
  status-log row + `/project-status`'s scheduler audit, not by the folder.
- If the folder doesn't exist, say so and stop — don't invent one.

### 2. Evaluate before queueing

For each open item, verify the claims against current code and live data —
feedback cites the state of the world when it was written, which may have
drifted. Then classify each ask:

- **Ours, do it** — the fix belongs to this project. → goes to `/develop`
  (step 3). Do NOT write the code here.
- **Ours, decline** — conflicts with the project's contracts/vision (e.g. a
  convenience ask that violates a service boundary). Decline explicitly in the
  RESOLUTION with the reason; never silently skip. Resolved now (no code) →
  close immediately in step 4.
- **Theirs, forward** — the root cause lives in another service. Do NOT reach
  across the boundary to hack around it; file a feedback/PRD item in *that*
  project's intake folder and reference it (use `/my-feedback to <project>`).
  Resolved now (no code in *this* repo) → close immediately in step 4.

Root-cause with evidence (logs, live queries, health checks), not from the
file's narrative alone — the reporter sees symptoms, you can see causes.

### 3. Queue the work via /develop (never implement inline)

For every **Ours, do it** item, invoke the **`develop`** skill to turn the ask
into one or more self-contained PRDs in the scheduler queue. Hand `/develop` a
complete brief so it does not have to re-ask scope — your step-2 evaluation
already established it:

- The goal, in this-project terms.
- **Acceptance criteria taken from the feedback's own AC**, made verifiable
  (with the test/health command to prove them).
- The absolute `cwd`, plus the exact files/patterns/utilities to reuse that you
  found while root-causing (the API-reuse standard — don't make the headless run
  rediscover them).
- Any constraints, service boundaries, or "out of scope" lines.

`/develop` owns decomposition (small ~15-min PRDs), inlining the engineering
standards, the `NN-` parallel grouping, and — because each PRD publishes its own
work — the implementation **commit + deploy**. That means process-feedback does
**not** commit implementation code; the PRDs do, when they run.

Record the emitted PRD filenames/ids — you need them for steps 4–6.

### 4. Disposition + archive every item now — this is the definition of done

Every open item gets a disposition, a `## RESOLUTION`, and a `git mv` to
`feedback/processed/` **in this pass** — archival is at disposition time, not
delivery time. Do NOT leave a queued item in the inbox "until its PRD lands":
that is the drift this contract forbids. By disposition:

- **Queued (Ours, do it):** append `## RESOLUTION` naming the emitted PRD
  filename(s)/id(s) and stating execution is now the scheduler's job. Set the
  README status-log row to **🛠 queued (PRD NN)** (add 🛠 to the legend if
  absent). `git mv` the file (and any `-REPLY`) to `processed/` **now**. The 🛠
  row — not the file's location — is what tracks execution; do not fabricate
  verification for code that hasn't run yet, just record the handoff.
- **Declined (Ours, decline):** append `## RESOLUTION` with the reason (contract
  / boundary conflict), flip the row to ✅, `git mv` to `processed/`.
- **Forwarded (Theirs):** append `## RESOLUTION` naming the upstream filing
  (`/my-feedback to <project>` id), flip the row to ✅ (closed here — the ask now
  lives in their intake), `git mv` to `processed/`.

After this step the actionable inbox is **empty** — only genuinely un-dispositioned
items (still being triaged) may remain, and only within this same pass. Commit the
feedback bookkeeping + any upstream filings in one clean commit (message
references the file id, e.g. `chore(feedback): triage + queue 2026-06-10-01`).
Only commit a clean, green tree; if unrelated in-flight work is mixed into the
working tree, stop and tell the user instead of committing around it.

### 5. Hand off to the scheduler — do NOT babysit

Execution is the scheduler's job from here. **Do not run an interactive watch
loop, and do not block the pass on PRDs landing** — `/develop` already queued
them with the engineering standards inline, the scheduler runs them at its
cadence, and **`/project-status` owns the ongoing audit**: its scheduler-PRD
check cross-references `queue.json` to reconcile each 🛠 status-log row → ✅ when
its PRD lands (the file is already archived), and surfaces any `failed` /
`needs_review` / stuck Burrow PRD. If a PRD later fails, the requester re-files or
the status audit escalates it — the feedback pass does not stay open waiting for
that. If the user wants live progress, point them at the SchedulePanel.

### 6. Self-improve the intake (always do this)

Update the folder's `README.md` guidance section based on what this round
taught you:

- What made an item easy to queue + close? Distill it into a bullet other agents
  can imitate (cite the file as the example) — e.g. a feedback item that already
  carried a crisp, testable AC turned straight into a clean PRD.
- What slowed you down — a missing log path, an unverifiable claim, an ask that
  actually belonged to a third service, a PRD that got stuck? Add the
  counter-guidance.
- Keep the section calibrated and short: merge/rewrite stale bullets rather than
  appending forever.

This step is the point of the skill: every processing pass should make the
*next* pass cheaper.

## Guardrails

- **Never implement feedback inline.** Code that belongs to this project goes
  through `/develop` → the scheduler. The only commits process-feedback makes
  itself are feedback bookkeeping and upstream filings.
- **Archive at disposition time, not delivery time.** The moment an item is
  queued as a PRD (or declined / forwarded), give it a RESOLUTION and `git mv` it
  to `processed/` — do NOT leave it in the inbox waiting for the PRD to land. A
  queued item is archived with a **🛠** status-log row (not ✅); the row is the
  durable execution tracker and is reconciled 🛠→✅ by `/project-status` from the
  scheduler queue. Leaving dispositioned items in the inbox "until they verify"
  is the non-resilient behavior this contract exists to kill.
- **The status-log row is honest about state even after archival.** 🛠 = "PRD
  queued, scheduler owns it, not yet landed"; ✅ = "landed/verified (or
  declined/forwarded)". Never fabricate a ✅ for code that hasn't run — archive at
  🛠 and let the status audit flip it.
- Never delete feedback files to "clear" the folder — archive them.
- Service boundaries outrank feedback asks: an item that requests a boundary
  violation gets a documented decline + an upstream filing, not compliance.
- Report honestly in the RESOLUTION: which PRD id owns the work, what was
  declined/forwarded and why, deps on other teams. An archived item with open
  external deps should say what unblocks it.
