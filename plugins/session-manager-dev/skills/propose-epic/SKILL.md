---
name: propose-epic
description: >-
  File work you think should happen as a PROPOSED Epic — an Epic that does not
  start until a human presses Approve. Replaces the retired /process-feedback
  and /my-feedback intake pipeline: there is no feedback folder, no triage
  pass, and no archiving convention, because the proposal IS the work item.
  Use whenever you would previously have written a feedback file — for this
  project or another one — or whenever the user says "/propose-epic",
  "propose this", "file this for later", "suggest we do X", "send feedback to
  X". Keywords: propose, proposal, feedback, enhancement request, file for
  approval, cross-project request, backlog.
---

# propose-epic

**Role:** the one way an agent asks for work to happen that it is not doing right now.

You do not implement, and you do not queue anything that runs. You file a **proposed
Epic** and stop. A human approves it in the Epics workspace, at which point its objective
becomes the first prompt of its own claude session — the same start path every hand-created
Epic takes.

## Why this replaced the feedback folder

The old flow was: write a markdown file into `session-manager-operations/feedback/` →
`/process-feedback` later reads it, evaluates it, dedupes it, queues PRDs via `/develop`,
archives the file to `processed/`, and updates a README with lessons. Four moving parts and
~400 lines of instructions existed to move an idea from "written down" to "being worked on".

An Epic already is that thing. It has a goal, an intent tag, its own session, its own PRD
directory, and a place in the UI. The only piece it was missing was "don't start yet" —
that is the `proposed` status. So the intake pipeline collapses into one command.

## How to file one

```bash
node "$SM_ROOT/scripts/propose-epic.cjs" <project-cwd> "<one-line title>" [feature|bug|discussion] <<'BODY'
<the full objective — this is sent verbatim as the first prompt on approval>
BODY
```

`$SM_ROOT` is session-manager's own package root. Resolve it once, in this order:
1. You are working inside the session-manager repo → `.` (use `scripts/propose-epic.cjs`).
2. Otherwise the installed package — this skill file lives at
   `<SM_ROOT>/plugins/session-manager-dev/skills/propose-epic/SKILL.md`, so
   `SM_ROOT` is four directories up from this file's own path.

- **`<project-cwd>`** — the project the work belongs to. Cross-project requests are just a
  proposal filed into *that* project's cwd; there is no separate outbound skill.
- **title** — one line. It is what the Epics list shows. Keep it specific: `Scheduler rows
  don't show their Epic`, not `Scheduler bug`.
- **body** — write it as an instruction to the agent that will pick it up, not as a report
  to a human. Include what you observed, where in the code it lives (file:line if you know
  it), and what done looks like. It is the first prompt, so it should be enough to act on.
- Re-proposing the same title into the same project **joins** the existing proposal and
  enriches it rather than duplicating it. Say more in the body and re-run; that is the
  update mechanism.

Report back the Epic id and the title you filed. Do not queue PRDs, do not edit code, and
do not ask whether you should file it — filing is the default action, and the approval gate
is the user's control, not your prompt.

## When NOT to propose

- The user asked you to do the work now → do it (or `/develop` it), don't propose it.
- It is a one-line fix you are already in the file for → just fix it.
- Nothing actionable → say so plainly and file nothing.
