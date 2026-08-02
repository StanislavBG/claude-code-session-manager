---
name: builder:gate
description: Step 2 of builder — run typecheck and unit tests, both time-bounded, as the hard pre-publish gate. A failing gate stops the pipeline; builder:publish never runs on a red gate.
---

# builder:gate

Run this project's own check commands against `HEAD` exactly as they run in CI/manually —
no shortcuts, no `--skip` flags.

```
timeout 180 npm run typecheck
timeout 300 npm run test:unit
```

(Adjust bounds per project if `CLAUDE.md` documents different timing expectations — these
values match session-manager's own commands: `tsc --noEmit` and `vitest run`.) Always wrap
in `timeout` — an unbounded gate command is exactly the kind of stuck-job failure mode
`PRD_AUTHORING.md` warns about elsewhere in this repo; a hang here should surface as a
timeout, not run forever.

## On failure

Stop immediately. Do not proceed to `builder:publish`. Report:
- which command failed (typecheck or test:unit)
- the actual failure output (not just "gate failed")
- that no version bump, tag, or publish happened

## On success

Proceed to `builder:publish` with no pause for reconfirmation — see the orchestrator's hard
rules on this.

## Output

- `PASS` or `FAIL` per command.
- Full failure output on `FAIL`, empty on `PASS`.
