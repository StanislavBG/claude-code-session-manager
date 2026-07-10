---
title: Scheduler marks PRD jobs "completed" (exitCode 0) even when the agent ends its turn asking a clarifying question and lands no commit
source: bilko (PRD 407 executor run, session 78ac034b-6874-4235-9f84-4d919ce80bdb)
type: bug
severity: blocker
---

# What happens / what's missing

PRDs 403 (`403-browser-picker-overlay`), 404 (`404-browser-capture-pipeline`),
405 (`405-browser-screenshot-capture`), and 406 (`406-browser-capture-panel-ui`)
all show `status: "completed"`, `exitCode: 0`, `error: null` in
`~/.claude/session-manager/scheduled-plans/queue.json`, and 406's own
`.verdicts.json` says `"verdict": "clean"`. But **none of their code exists in
the repo**: no `browserCapture.cjs`, no picker/capture/screenshot IPC handlers
in `src/main/browserView.cjs`, no matching entries in `src/preload/index.cjs`,
and no commit for them in `git log` (only PRD 402's commit `57a830c` — the
panel-slot scaffold — is present on any branch/reflog).

Reading 406's own run log
(`~/.claude/session-manager/scheduled-plans/runs/2026-07-10T06-56-52-023Z/406-browser-capture-panel-ui.log`),
the agent itself diagnosed this: it found 403/404/405 marked completed with no
landed code, correctly refused to build against a nonexistent IPC contract,
and ended its turn *asking the user which of two ways to proceed* — never
writing code, never committing, never emitting `SCHEDULER_VERDICT: PASS`.
Despite that, the scheduler recorded `status: completed, exitCode: 0`. This
is exactly the "exited 0 with uncommitted changes" failure mode called out in
the project's own execution-discipline doc (§ Finish so the verifier
auto-clears you) — except here the run didn't even reach the finish protocol;
it stopped mid-conversation on a clarifying question, and the scheduler still
treated `exitCode: 0` as success.

This then cascaded: PRD 407
(`407-browser-capture-destinations`, the run that discovered this) declares a
hard dependency on 406, and 407's own queued run started under the false
assumption that 406 had landed — I only caught it by cross-checking git
history against the queue status before writing any code.

# Evidence

- `~/.claude/session-manager/scheduled-plans/queue.json` — jobs `403-browser-picker-overlay`,
  `404-browser-capture-pipeline`, `405-browser-screenshot-capture`,
  `406-browser-capture-panel-ui` all `status: "completed"`, `exitCode: 0`, `error: null`.
- `~/.claude/session-manager/scheduled-plans/runs/2026-07-10T06-56-52-023Z/406-browser-capture-panel-ui.log`
  — final assistant message ends with a question to the user ("Want me to do
  that, or would you rather I stub the IPC surface here so 406 can ship
  now?"), `stop_reason: "end_turn"`, no `git commit` invocation anywhere in
  the transcript, no `SCHEDULER_VERDICT:` line anywhere in the log.
- `~/.claude/session-manager/scheduled-plans/runs/2026-07-10T06-56-52-023Z/406-browser-capture-panel-ui.meta.json`
  — `"exitCode": 0`.
- Repo verification: `git log --oneline -- src/renderer/components/tabs/browser/CapturePanel.tsx`
  shows only `57a830c` (PRD 402); `grep -n "picker\|capture\|screenshot"
  src/main/browserView.cjs src/preload/index.cjs` returns no matches for any
  of the three IPC surfaces 406 needed.

# Suggested direction (optional)

The finish-protocol / verdict-scanner logic (`dodDrainHook.cjs` and whatever
maps a `claude -p` process exit to `queue.json`'s `status`/`exitCode`) should
not accept `exitCode: 0` alone as "completed". At minimum:

1. Require a `SCHEDULER_VERDICT: PASS` sentinel as the literal last line
   before marking a job `completed` — its absence should downgrade to
   `needs_review` (mirrors the "uncommitted_changes" verifier verdict already
   used elsewhere in this same queue.json, e.g. job `91-sb-trending-velocity-discovery-tool`).
2. A run whose `stop_reason` is `end_turn` on a question/no tool calls in the
   final turn (i.e., the agent asked the user something and stopped) should
   never be classified `completed` — treat it the same as a timeout/blocker,
   not a success.
3. Since this already silently broke a 4-PRD dependency chain (403→404→405→406→407),
   worth an audit of the rest of `queue.json` for other `completed` entries with
   no matching commit, so other silently-stalled chains surface now rather than
   at the next dependent PRD.
