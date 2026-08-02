# Runs SIGTERMed after their commit landed are classified `failed` and stay failed forever

Two jobs sat in the queue as `failed` (exit 143) even though their deliverable commits had
already landed and been verified:

- `776-chat-queue-primary-layout-swap` — work committed as `aad3399` (session-manager); the run
  died AFTER the commit-worthy work existed, while attempting an interactive Electron
  screenshot pass (playwright `electron.launch` from a headless executor — the known
  no-interactive-AC anti-pattern; likely SIGTERMed by the single-instance lock / app teardown).
- `768-sb-client-session-self-heal-on-timeout` — work committed as `92f7c58`
  (social-signals-trader).

Both had to be manually reconciled in queue.json on 2026-07-30 (see `completedBy` notes).

Two improvement levers, both in scheduler.cjs's run-outcome classifier:

1. **Post-mortem commit check on exit 143**: before classifying a SIGTERMed run as `failed`,
   check whether a commit referencing the slug/AC landed in the PRD's cwd during the run window
   (the commit-guard already knows how to attribute commits). If yes → classify `completed`
   (or `needs_review` with a "verify AC" hint), not `failed`.
2. **PRD lint for interactive validation steps**: queueOps.cjs's linter should flag PRD bodies
   whose AC/notes instruct launching the Electron app / playwright `electron.launch` /
   screenshots — same class as the unbounded-loop lint. 776's executor burned ~$1.64 and its
   exit state on a step that can never work headlessly.

**Why:** stale `failed` rows block chain links sequenced behind them and mislead the operator.
**How to apply:** queue via /develop as one small PRD against scheduler.cjs + queueOps.cjs.
