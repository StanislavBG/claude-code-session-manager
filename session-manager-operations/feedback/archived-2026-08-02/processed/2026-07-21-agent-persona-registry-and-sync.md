---
title: Own agent-persona files as a synced, drift-checked registry
source: bilko (via Developer agent session, /home/bilko/Projects/Agents)
type: enhancement
severity: normal
---

# What happens / what's missing

Claude Code's always-on system instructions live in a single hand-edited file per machine
(`~/.claude/CLAUDE.md`). There is no versioning, no backup, no way to see what changed when a
behavior regresses, and no way to share a persona across machines or projects.

Today (2026-07-21) I moved my global instructions into a git repo so they are at least
versioned:

```
~/Projects/Agents/                       git: https://github.com/StanislavBG/claude-agents (private)
├── shared/core.md                       agent-agnostic rules
├── Developer/developer_sg.md            the Developer persona
└── README.md
~/.claude/CLAUDE.md                      thin loader: preset block + two @imports
```

The gap session-manager could close is everything *after* "it's in git":

1. **Nothing pulls.** Keeping the working copy current is a manual
   `git -C ~/Projects/Agents pull --ff-only`. On a second machine, or after a scheduled job
   commits a persona edit, the interactive session silently runs stale instructions.

2. **Broken imports fail silently — this is the sharp edge.** Claude Code's `@path` import
   resolves a missing or moved file to *nothing*, with no warning. If `developer_sg.md` is
   renamed, deleted, or the repo is checked out elsewhere, every session loses its entire
   global instruction set and nobody finds out until the agent starts behaving wrongly. I
   mitigated this by hand with a canary line at the bottom of each persona file
   (`agents-repo:<path>@v1`), but there is no checker that asserts the canaries are actually
   reachable from the loader.

   Related finding worth knowing when implementing any check: **HTML comments in `CLAUDE.md`
   are stripped before the file reaches model context.** My first canary was
   `<!-- agents-repo: … -->` and a live probe returned `NOT-FOUND`; the same string as visible
   markdown returned both lines. Any integrity check that relies on a marker in the instruction
   file must use visible text.

3. **Personas are invisible to the scheduler.** A headless `claude -p` PRD execution inherits
   whatever `~/.claude/CLAUDE.md` happens to say at exec time. There is no record in the job's
   metadata of *which persona revision* ran it, so a behavioral regression across a batch of
   jobs cannot be correlated with an instruction change.

# Evidence

- `~/.claude/CLAUDE.md` — now `9f40911` in the `~/.claude` repo; reduced to the
  `<!-- claude-presets:start -->` block plus two `@` imports pointing at `~/Projects/Agents`.
- `~/Projects/Agents` — commit `3ef5d07`, pushed to `github.com/StanislavBG/claude-agents`.
- `~/Projects/Agents/README.md` §"Silent-failure risk" documents the canary convention.
- Prior art in this repo for the "state the sync gap explicitly" pattern:
  `session-manager-operations/feedback/README.md` lifecycle section.

Verified by hand this session: removing an imported file produces no error output in a new
session — the instructions are simply absent.

# Suggested direction (optional)

Treat agent personas as a first-class registry alongside PRDs and projects. Concretely, three
separable pieces — the first is the one that matters:

1. **Drift + integrity check** (highest value, smallest surface). A periodic check that, for
   each configured persona repo: runs `git fetch` and reports ahead/behind, and asserts every
   `@import` target in `~/.claude/CLAUDE.md` resolves to an existing, non-empty file. Surface
   the result in `/project-status` / the existing health rollup. This catches the silent-import
   failure, which is the actual risk.

2. **Scheduled pull.** A `git pull --ff-only` on the persona repo before a queue drain, so
   headless executors run current instructions. Must be `--ff-only` and must not touch a dirty
   working tree.

3. **Persona revision stamped on jobs.** Record the persona repo's HEAD SHA in each job's
   metadata at exec time, so a behavior regression across a batch can be correlated with an
   instruction commit. Cheap to capture, disproportionately useful in postmortems.

Piece 1 alone would be worth shipping without 2 or 3. I'd explicitly *not* suggest
session-manager owning persona *content* or editing `~/.claude/CLAUDE.md` — writing to the
file that defines agent behavior from a scheduler is a foot-gun; read-and-report is the right
boundary.

Open question for the implementer: where the list of "persona repos to watch" is configured —
a field in the existing project prefs, or a new top-level config. I don't have a strong view.

## Resolution

Piece 1 (drift + integrity check) queued as scheduler PRD
`675-persona-import-drift-health-check` — adds a `checkPersonaImports()` component to
`src/main/health.cjs` that parses `~/.claude/CLAUDE.md`'s `@import` chain recursively, asserts
every resolved target exists and is non-empty, and reports git ahead/behind for each unique
repo those imports live in. Surfaced as an informational `persona_imports` component (not
gating `status.ok`) in the existing `npm run health` rollup — no new config surface needed,
since the target list is derived entirely by parsing the loader file itself.

Pieces 2 (scheduled `git pull --ff-only` before queue drain) and 3 (persona revision stamped
on job metadata) deferred, per the filer's own framing ("piece 1 alone would be worth
shipping without 2 or 3") — both are larger changes session-manager doesn't have an open
design for yet (where would the pull run relative to concurrent jobs touching the same
worktree; what job-metadata shape would carry a persona SHA). Re-file as separate items if/when
there's a concrete design to build against.
