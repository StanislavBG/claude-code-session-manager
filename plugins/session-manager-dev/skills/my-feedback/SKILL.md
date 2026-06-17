---
name: my-feedback
description: >-
  File a feedback/enhancement request FROM the current project INTO another
  project's inbound feedback folder, following that project's own README
  convention. The cross-project complement of /process-feedback (which works the
  *current* project's inbox). Use whenever the user says "/my-feedback to X",
  "send feedback to X", "file a feedback item to X", "request an enhancement
  from X", "drop a note in X's feedback folder", or "ask X to add/fix Y". The
  target project MUST be named — error if it is missing. Keywords: feedback,
  cross-project request, enhancement request, upstream, downstream, service
  boundary, file feedback, request a feature, inter-service.
---

# my-feedback

**Role:** the *outbound* end of the agent↔agent channel — it files a request into another
project's intake, where their `/process-feedback` picks it up and (if codeable) runs it
through their `/develop` pipeline. It is the send side; `/process-feedback` is the receive
side. **Never** cross the service boundary to fix the other project's code yourself — the
deliverable is an auditable request, not a patch.

Write one actionable feedback file into **another** project's intake folder, so
the team that owns the boundary can act on it via their `/process-feedback`. The
current project is the **From**; the named project is the **To**.

This is the send side of the same channel `/process-feedback` reads. Respect the
service boundary: you are *requesting* a change in their code, never reaching
across to make it yourself.

## 0. Resolve the target — error if missing

The invocation is `/my-feedback to <<project>>` (or "send feedback to
<<project>>"). **`<<project>>` is required.**

- **If no target project is named, STOP and error.** Do not guess, do not file
  into the current project. Print: *"Name the target project: `/my-feedback to
  <project>`."* Then list candidate sibling projects that have an intake folder:
  ```bash
  for d in ~/Projects/*/; do
    [ -d "$d/feedback" ] && echo "  - $(basename "$d")  (feedback/)"
    [ -d "$d/external-feedback" ] && echo "  - $(basename "$d")  (external-feedback/)"
  done
  ```
  and stop.
- Resolve the path: `~/Projects/<project>/feedback/` (some projects
  use `external-feedback/` — check both). Fuzzy-match a near miss to a real
  directory, but confirm the resolved name before writing.
- **If the target has no feedback/external-feedback folder, STOP.** Don't invent
  one — say the project doesn't accept feedback this way and ask how to proceed
  (it may take requests via issues, a different folder, or not at all).

## 1. Read the target's README FIRST — it is the authority

**Every project's feedback folder has its own `README.md`, and the convention is
unique per project** (file-naming scheme, required sections, the status-log
table, the closing ritual). Read it before writing anything:

```bash
cat ~/Projects/<project>/feedback/README.md
ls  ~/Projects/<project>/feedback/                # open items + numbering
ls  ~/Projects/<project>/feedback/processed/ 2>/dev/null   # closed examples to match
```

Read one **processed** example end-to-end to copy the house format exactly — the
processed files are the calibrated bar. If the README and an example disagree,
the example wins (it's what actually got accepted).

## 2. Name the file by their convention

Most intakes use `YYYY-MM-DD-NN-short-slug.md` (today's date, next free `NN` for
the day — check existing files so you don't collide). Use the **target's** scheme
if it differs. The "From" is the **current project** — derive it from the cwd
basename, not an assumption.

## 3. Write to the bar — make it closeable without a back-and-forth

These hold across every intake (and most READMEs say the same):

- **Cite real `file:line` from the target's current `src/`** — verify by `grep`,
  not memory. "You spawn a process per call — `_burrow_mcp.py:75`" beats "your
  transport seems slow." Quote the offending code, then name the contract/PRD it
  violates so the gap is self-evident.
- **Lead with the cost already paid.** A concrete incident ("the silent 11-day
  mentions hole", "shorted into earnings on a stale zero") earns priority over a
  hypothetical. Tie it to money/correctness, not taste.
- **Give a copy-pasteable Fix _and_ the deps to unblock it** (env var, new tool,
  rate bucket). Don't leave the closer to discover side-asks.
- **Separate "must change" from "nice."** Credit what's already right so the file
  reads as calibrated, not a pile-on.
- **Name the symptom and hypothesize the cause, but don't confidently assign the
  fix's home.** A wrong attribution stalls; "frozen at 06-08 (evidence) — maybe
  scoring, maybe upstream gather" closes faster.
- **Flag third-service dependencies up front.** If an ask needs *another*
  project's tool/contract to land, say so — the closer forwards it on day one
  instead of discovering it mid-fix. (You can also file the dependent half
  directly into that third project with another `/my-feedback` pass.)
- **End with concrete Asks + the target's closing ritual** (the README usually
  specifies marking ✅ and appending `## RESOLUTION`). State what "done" looks
  like, with an acceptance test per ask.
- **One file = one coherent thread, scoped to the boundary.** Don't smuggle in
  unrelated requests.

Anti-patterns that stall: vague severity ("seems slow"), no reproduction, fixes
that assume internals the other team can't see, asks with no acceptance test.

## 4. Register and hand off

- If the README keeps a **status-log table**, add a row for the new item (open/🆕)
  using their exact column format. This is usually required — the log is the
  durable index.
- **Don't commit or push into the target repo unless the user asks.** The file in
  their tree is the deliverable; their team picks it up via `/process-feedback`.
  If you do commit, commit in the **target** repo only, and never touch their
  source — just the feedback file + README log row.
- Report back: the file path written, the From→To, priority, and the one-line
  ask — so the user can relay or follow up.

## Tips

- **You're the sender, not the fixer.** Resist editing the target's code to
  "just fix it" — that violates the boundary the channel exists to protect. The
  whole point is an auditable request the owner acts on.
- **Mirror their tone.** A terse intake wants terse; a structured one wants every
  section. Match the processed examples.
- **Reuse evidence you already have.** If this session surfaced the incident
  (logs, audit rows, live tool output), quote it verbatim — freshly-gathered
  `file:line` and timestamps are exactly what makes a file closeable.
- **Stale-claim guard.** Feedback captures the world when written; note the
  as-of timestamp on live data you cite, so the closer knows what to re-verify.
- **If the right home is a third project,** file there too rather than overloading
  one team with an ask they can only forward.
