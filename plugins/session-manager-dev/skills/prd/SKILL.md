---
name: prd
description: >-
  Write a PRD for the session-manager scheduler queue (the right place for
  token-budget-managed work). Use this whenever the user says "make this a PRD",
  "queue this up", "add to the scheduler", or asks for a PRD without specifying a
  target location. Keywords: prd, queue, scheduler, scheduled-plans, token budget.
---

# /prd — author one scheduler PRD

**Role:** `/prd` is the single authority on one PRD's *structure, location, and scope sizing*. It does not own the engineering rules (that's `standards.md`) and does not decompose a large ask into multiple PRDs (that's `/develop`). Never restate rules that live in `standards.md` — reference and append them.

You are writing a PRD that will be executed by the user's session-manager scheduler — a system that runs `claude -p <prd-body> --dangerously-skip-permissions` jobs around 5-hour token-window resets, with auto-pause on rate-limit and auto-resume.

## Canonical location — non-negotiable

PRDs MUST be written to:

```
~/.claude/session-manager/scheduled-plans/prds/<NN>-<kebab-slug>.md
```

**Anywhere else doesn't get scheduled.** If you write to `data/prds/`, `docs/prds/`, or the project root, the scheduler will not see it and the user loses their token-budget-managed execution. There is exactly one queue for all projects — that's intentional, because the 5-hour token budget is global across all of the user's Claude work. The `~` expands to `os.homedir()` so the same convention works for any user on any machine.

## Filename rules

- `NN` is the **parallel group** (2-digit zero-padded). Jobs in the same group run in parallel up to a concurrency cap; groups run serially. Pick `NN` by reading the existing files in `~/.claude/session-manager/scheduled-plans/prds/` and choosing:
  - The same `NN` as a sibling that's logically independent and can run in parallel.
  - The next unused `NN` if this PRD has a hard dependency on prior work landing first.
- `<kebab-slug>` is a short, descriptive kebab-case identifier (e.g. `voice-commands-send-cancel`, `ticker-velocity-mcp`). Keep under 60 chars.

Compute the current max `NN` **deterministically** before writing — do NOT eyeball the `ls` or narrow the pattern (a grep like `'^10[0-9]'` silently misses `110+` and overwrites/mis-groups a PRD):

```bash
ls ~/.claude/session-manager/scheduled-plans/prds/ | grep -oE '^[0-9]+' | sort -n | uniq | tail -5
```

The last line is the highest in use; the next free group is **max+1**. Use that for an independent/dependent PRD, or reuse a specific sibling's `NN` only when you deliberately want it in that parallel group. Verify your chosen filename doesn't already exist before writing.

## Required frontmatter

```yaml
---
title: <one-line human-readable title>
cwd: <path to target project — where claude -p will run>
estimateMinutes: <integer wall-clock estimate>
---
```

`cwd` is critical. Without it the job runs in the scheduler's default cwd (session-manager). Always set it to the path of the project the work targets. **Write it as `~/Projects/<repo>`** — the parser expands `~` to `os.homedir()` at ingest, so the same PRD works on Linux and macOS. Avoid hardcoding an absolute home path (`/home/<you>/Projects/<repo>`); it breaks on any machine with a different home directory.

## Required body sections (in this order)

```markdown
# Goal

<2-4 sentences. What the executor will build and why it matters. NO "as a user I want to" framing. Concrete: name the function, the file, the user-visible change.>

# Acceptance criteria

- [ ] <each line is a verifiable check the executor can run after building>
- [ ] <include explicit file paths, function names, expected behavior>
- [ ] a bounded test command passes, e.g. `timeout 300 npm run typecheck` / `pytest -x` / `cargo check` (the run-before-done / never-end-on-red rule lives in standards.md → Execution discipline; the AC just has to name the command).

# Implementation notes

<file paths the executor will need to read first; the architectural pattern to follow; any non-obvious constraints. Be specific. Quote function signatures if it saves the executor a Read call.>

# Out of scope

<short bulleted list of what NOT to build, to prevent scope creep>
```

## Self-containment is load-bearing

The executor (`claude -p`) starts with NO conversation context — only this PRD body and the project files. So:

- Include exact file paths (`src/main/index.cjs:142`).
- Quote function signatures or relevant code blocks if the executor would have to grep for them.
- Name the libraries / patterns to use (e.g. "use the existing `validatePath` helper in `config.cjs`").
- Don't reference "the conversation we just had" or "the design we discussed."
- If the PRD depends on another PRD's output, say so in `# Implementation notes` AND give it a higher `NN` so it queues after.

## Scope sizing — keep it SMALL (data-driven, 2026-06)

Across 400+ real runs the median PRD finishes in **~7 minutes**, p90 **~21 min**, p99 **~66 min** — yet authored `estimateMinutes` ran **5–8× too high**. Oversized scoping is the root problem: it anchors PRDs too big and pushes them into the rare >60-min tail where ~100% of true hangs live (deploy poll-loops, unbounded e2e suites).

- **Target ~15 minutes of wall-clock work per PRD. Hard ceiling ~30 min — if you project more, SPLIT** into sequential `NN` PRDs and document the dependency in each.
- Set `estimateMinutes` realistically: **p50≈8, p90≈21**. Don't write 60/90 — it's almost always wrong and it hides real outliers.
- Each execution costs ~$0.50–$2; the 5-hour token window is global. Smaller PRDs = smaller blast radius when a run is rate-limited, timed out, or killed.
- **`rateLimited` exit-1 is NOT a failure** — it's the scheduler's designed auto-pause; the job auto-resumes at the next window reset. Don't add retry logic for it.

## Execution discipline — append it, don't restate it

The runtime rules (bound every command, verify-before-done, fail-loud, stay-in-AC,
negative-assertion-exits-0) have a single home: the **Execution discipline** section of
`~/.claude/skills/develop/standards.md`. Don't paraphrase them here — they drift.

Long hangs — not bad code — are the dominant *real* failure (the watchdog only fires at 4
hours, so an unbounded command burns hours), so these rules are load-bearing and MUST reach
the headless executor in the PRD body:

- If this PRD is being authored **via `/develop`**, that skill already appends `standards.md`
  verbatim — nothing to do here.
- If you are authoring a PRD **directly** (`/prd` alone), **append the Execution discipline
  section from `standards.md` to the PRD body** (under an `## Execution discipline` heading)
  before queueing. That is the only way the bounded-command / verify-before-done rules reach
  `claude -p`.

The one rule worth echoing inline because it shapes the AC: **wrap every test/build/deploy/poll
command in a hard timeout** (`timeout 300 npm run typecheck`, `timeout 120 npx playwright test
one.spec.ts` — shard e2e to one spec, never a full suite; `curl --max-time 15`; bound any
`until/while`). Never queue a publish that polls an endpoint until a condition — the #1 hang
offender (PRD_AUTHORING §1/§5).

## Workflow

1. Read existing PRDs in `~/.claude/session-manager/scheduled-plans/prds/` to pick `NN`.
2. Write the file with the structure above.
3. Confirm to the user:
   - The filename (so they can see it queued).
   - The chosen `parallelGroup` (NN) and the rationale (parallel-with-X / serial-after-Y).
   - The chosen `cwd` (so they can correct if it's wrong).
   - Estimated wall time + a token-cost ballpark.
4. Tell the user the PRD will fire when the scheduler's policy says — they can click "Run now" in the SchedulePanel to execute immediately, or wait for `when-available` polling.

## What NOT to do

- Don't write the PRD to `data/prds/`, `docs/prds/`, the project's own folder, or anywhere outside the canonical path. The user has explicitly flagged this as a recurring problem.
- Don't combine multiple unrelated features into one PRD. Each PRD is one focused, completable unit.
- Don't add a parallelGroup field to the frontmatter — the scheduler reads the filename prefix.
- Don't leave `cwd` unset hoping for the default. Be explicit.
- Don't write the PRD body inline in the chat for review *before* writing the file. Write the file directly, then confirm. The user wants the PRD queued, not draft-reviewed in chat.
