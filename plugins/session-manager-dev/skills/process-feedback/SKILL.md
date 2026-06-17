---
name: process-feedback
description: >-
  Process the current project's inbound feedback folder end-to-end: read every
  open item, evaluate it against real code, and for work that belongs to this
  project queue it as scheduled PRDs via /develop (never implement inline) —
  then track those PRDs to completion, archive the item as processed, and fold
  lessons back into the folder's README so future feedback (written by other
  agents/projects) gets better. Use whenever the user says "/process-feedback",
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
session-manager scheduler. process-feedback then watches those PRDs to
completion and does the bookkeeping. Implementing feedback inline — bypassing
the scheduler — is the one thing this skill must not do.

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
  per step 7, leaving the README better for next time).

### 1. Read the intake

- Read `feedback/README.md` (conventions + the status log), then every file
  whose status is open/🆕. Skip files already ✅/archived. Items already 🛠
  (queued — see step 4) are in flight: don't re-queue them, just re-check their
  PRD status (step 5).
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

### 4. Interim bookkeeping — commit the triage now

Two cases:

- **Closed-without-code** items (declines, upstream forwards): append a full
  `## RESOLUTION` (what was declined and why / what was forwarded where, with the
  upstream file id), flip the README row to ✅, and `git mv` the file to
  `feedback/processed/` — these are done.
- **Queued** items (sent to `/develop`): append a `## RESOLUTION (in progress)`
  recording the queued PRD filenames/ids and that execution is pending the
  scheduler. Flip the README row to **🛠 queued** (add 🛠 to the log's legend if
  absent) — **not** ✅. Leave the file in `feedback/` until the PRDs land. Do not
  fabricate verification for code that hasn't run yet.

Commit only this feedback bookkeeping + any upstream filings (message references
the feedback file id, e.g. `chore(feedback): triage + queue 2026-06-10-01`).
Only commit a clean, green tree; if unrelated in-flight work is mixed into the
working tree, stop and tell the user instead of committing around it.

### 5. Track to completion — delegate to /develop Phase 2

The queued PRDs run headlessly and can take a while. **Do not re-implement the
monitor here** — `/develop` Phase 2 already owns it (the 30-min scheduler watch,
the escalate-on-stuck/`needs_review`/timeout logic, and the live verification
against each PRD's acceptance criteria). When you call `/develop` in step 3, that
tracking runs as part of it.

Your only job in this step is to consume its outcome per queued item:

- **`/develop` escalated a PRD** (failed / stuck / needs attention) — relay it to
  the user with its specifics; leave the feedback item at 🛠 (still in flight)
  until it's resolved or re-queued. Don't archive a broken item as done.
- **`/develop` reported all of an item's PRDs landed + verified** — proceed to
  step 6 to finalize that item's bookkeeping.

### 6. Finalize the archive (when an item's PRDs land + verify)

Once `/develop` Phase 2 reports an item's PRDs merged and verified against the AC:

- Append the final `## RESOLUTION`: what changed, the PRD/commit refs, what was
  declined/forwarded, and how `/develop` verified it (cite its gate result —
  don't re-run the verification it already did).
- Flip the README row **🛠 → ✅** (keep the row — the log is the durable index).
- `git mv` the file to `feedback/processed/` (create the dir if needed). Closed
  items live there as the durable record; only files entered in error are ever
  deleted.
- Commit the bookkeeping.

### 7. Self-improve the intake (always do this)

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
- **Never mark a queued item ✅ or move it to `processed/` before its PRDs land
  and verify.** Queued ≠ done; 🛠 is the honest interim state. An item archived
  as resolved must point to merged, verified work.
- Never delete feedback files to "clear" the folder — archive them.
- Service boundaries outrank feedback asks: an item that requests a boundary
  violation gets a documented decline + an upstream filing, not compliance.
- Report honestly in the RESOLUTION: PRDs that failed or stalled, asks left
  open, deps on other teams. An archived item with open external deps should say
  what unblocks it.
