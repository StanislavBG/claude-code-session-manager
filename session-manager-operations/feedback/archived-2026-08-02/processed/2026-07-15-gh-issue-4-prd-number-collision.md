---
title: Prevent PRD number (NN) collisions when multiple projects share the scheduler queue
source: GitHub issue gh-issue-4 (https://github.com/StanislavBG/claude-code-session-manager/issues/4)
type: enhancement
severity: high
---

# What happens / what's missing

The `/develop` skill picks a new PRD's `NN` (parallel group) by scanning the **global**
PRD directory for the current max and incrementing. But
`~/.claude/session-manager/scheduled-plans/prds/` is a single namespace shared by **every**
project that uses the scheduler (each job carries its own `cwd`). Two projects authoring PRDs
concurrently compute the same max and allocate the same `NN`.

Reported incident (2026-07-14): session-manager held PRDs 05–11; Connector-Atlas allocated
06–09; result was duplicate NNs 05–09 requiring manual renumbering to 12–15.

Consequences the filer names, and which the code confirms are real:
- Silent collision — nothing checks for an existing `NN-*.md` before `Write`.
- `NN` is semantically overloaded: it is *both* the allocation counter *and* the
  parallel-group key, so a cross-project collision silently merges two unrelated projects'
  PRDs into one parallel group.

# Evidence

- `plugins/session-manager-dev/skills/develop/SKILL.md:76` — the exact cited command:
  `ls ~/.claude/session-manager/scheduled-plans/prds/ | grep -oE '^[0-9]+' | sort -n | uniq | tail -5`
- `plugins/session-manager-dev/skills/develop/SKILL.md:103-104` — "`NN` is the 2-digit
  zero-padded parallel group (picked per the `ls` command above)".
- `plugins/session-manager-dev/skills/develop/SKILL.md:215` — "the filename `NN-` prefix
  drives grouping" (confirms NN is load-bearing for scheduling, not just a name).
- `src/main/scheduler/prdParser.cjs:92` and `src/main/scheduler.cjs:2528` — both parse the
  PRD directory filtering on `.md`, deriving `parallelGroup` from the filename prefix.
- Live queue at triage: 577 PRDs in one flat directory, `defaultCwd`
  `/home/bilko/Projects/session-manager`, but per-job `cwd` values spanning projects.

# Triage evaluation (2026-07-15)

**Premise CONFIRMED.** The cited command exists verbatim at the cited location; the shared
global namespace is real; the collision mode is real.

**But the filer's recommended fix (Option A, per-project filename namespacing
`<project-slug>-<NN>-<slug>.md`) is REJECTED as specified** — it is not backward compatible
the way the issue claims. `NN` is parsed as the parallel group from the filename's leading
digits (`prdParser.cjs:92`, `scheduler.cjs:2528`, SKILL.md:215). Prefixing the filename with
a project slug means the leading token is no longer numeric, so `parallelGroup` parsing breaks
for every new PRD and the 577 existing files would need a migration. The issue's "Backward
compatible (just read existing format)" pro is simply false against this code.

`scheduler_watch_prd`-style polling is out of scope here (see gh-issue-6).

# Suggested direction

Adopt the filer's **Option C, hardened into atomic allocation, and put it server-side** rather
than in skill prose (a skill instruction cannot be enforced; a server function can):

1. Add an atomic `allocateParallelGroup()` in the scheduler that reads the max in-use `NN`
   and reserves the next free one under an exclusive lock/`O_EXCL` create, reusing the
   existing tmp+rename atomic-write helpers in `config.cjs` rather than a new lock scheme.
2. Preserve the `NN-<slug>.md` filename contract exactly — do not touch `parallelGroup` parsing.
3. Since `NN` doubles as the parallel-group key, allocation must still let a caller *opt into*
   an existing group for a genuine parallel sibling. Collision-avoidance applies to
   *new-group* allocation only; it must not break intentional same-`NN` siblings.
4. Expose it via the existing MCP surface (see gh-issue-6) so `/develop` calls one tool
   instead of shelling `ls | grep | tail`.

This supersedes the issue's Phase 1/Phase 2 split: Phase 2 (namespacing) is dropped.

## RESOLUTION

**Queued** as PRD `548-atomic-prd-parallel-group-allocation` (2026-07-15). Execution is the
scheduler's job from here.

Premise confirmed against real code; the filer's recommended fix (Option A, per-project filename
namespacing) was **rejected** — it breaks `parallelGroup` parsing (`prdParser.cjs:92`,
`scheduler.cjs:2528`) across all 577 existing PRDs, contrary to the issue's "backward compatible"
claim. Queued instead as the filer's Option C hardened into **atomic server-side allocation**,
reusing `config.cjs`'s existing tmp+rename helpers.

The MCP-tool half of the ask is tracked separately as PRD 549 (see gh-issue-6), which this PRD
unblocks.

A **second live reproduction was captured during triage** and folded into PRD 548 as its
regression fixture: at ~00:15 PDT another session authored `545-pr144-network-review-round3.md`
for `~/Projects/sigma` while this session was authoring 545s for session-manager — both computed
max=544, both allocated 545, and `queue.json` now shows the two projects sharing parallel group
545. Notably this refined the diagnosis: the real failure mode is **silent parallel-group
merging**, not the "silent overwrite / lost work" the issue claims (a collision only overwrites
when the slug also matches, which it didn't).

Originating issue: gh-issue-4 — https://github.com/StanislavBG/claude-code-session-manager/issues/4
