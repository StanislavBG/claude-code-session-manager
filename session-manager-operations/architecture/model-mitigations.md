# Model mitigations — registry

REFERENCE. Every rule in this repo that exists only to work around how a model behaves gets one row
here: what the model did, which model, when it was seen, and where the rule lives, with the rule's
exact text as the needle. The rule itself cites its row id (`MM-<n>`), so a reader can tell a model
workaround from a product law, and can retire it when a newer model no longer needs it.

`npm run lint:docs` (`scripts/check-doc-hierarchy.cjs`, check 7) fails a row, naming its id, when
the location file is missing or no longer contains the needle verbatim. Edit the rule → update its
needle in the same commit. Retire a workaround → delete the rule and its row together.

Row format: `location` is a repo-relative path in backticks; `needle` is exact text from that file in
backticks (no backticks or `|` inside it). Ids are never reused.

| id | behavior | model | observed | location | needle |
| --- | --- | --- | --- | --- | --- |
| MM-1 | In a headless `-p` run, backgrounds a review agent or self-schedules, then ends its turn "waiting" for it — no next turn comes, so no verdict line prints and the job parks in `needs_review`. | Claude Sonnet / Opus (dev-lead executor) | 2026-10-01 | `plugins/session-manager-dev/skills/develop/standards.md` | `and ending your turn with something like "I'll wait for the review agents to complete": a headless run has no next turn` |
| MM-2 | Same as MM-1, stated as the dev-lead persona's per-run rule. | Claude Sonnet (dev-lead persona model) | 2026-10-01 | `src/seed/agents/dev-lead.md` | `Never call ScheduleWakeup or Monitor, never start background work, never invoke /develop or queue work.` |
| MM-3 | Same as MM-1, for the plan validator's headless run. | Claude Sonnet (validator persona model) | 2026-09-22 | `src/seed/agents/validator.md` | `run nothing in the background; do not call ScheduleWakeup, Monitor, or /develop` |
| MM-4 | Retyping a large base64 payload (~300 KB audio) into a tool argument corrupts it; a demo video once shipped silent. Save by file path instead. | Claude Opus (demo-video-builder persona model) | 2026-10-09 | `src/seed/agents/demo-video-builder.md` | `a ~300 KB payload retyped by the model is exactly how a run once shipped silent` |
