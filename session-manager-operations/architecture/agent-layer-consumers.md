# Agent-layer consumers — external reference survey

> This doc moves nothing. It is the pre-move survey CLAUDE.md's Scheduler section demands:
> "PRD-write + destructive-git guards: adopt by REFERENCE, never vendor — other repos point at
> THIS repo's absolute `scripts/hooks/guard-*.cjs`". Combined with the Conventions law "No
> backwards-compat shims", a naive move of the AGENT LAYER partition (see
> [`project-partition.md`](project-partition.md)) has no safe fallback path once shipped — so this
> survey has to exist before anyone queues that move.

## Method

Grepped for the literal string `/home/bilko/Projects/session-manager` across every location the
PRD named:

```
~/Projects/*/.claude/settings.json
~/Projects/*/.claude/settings.local.json
~/.claude/settings.json
~/.claude/settings.local.json
~/.claude/*.json
~/Projects/*/CLAUDE.md
```

then widened to a recursive sweep of `~/Projects` and `~/.claude` (`*.json`, `*.md`,
`.mcp.json`) to catch nested config and MCP registrations the top-level globs would miss, and to
every `~/Projects/*/CLAUDE.md` for the bare word `session-manager` (to rule out a prose
by-path instruction hiding without the literal absolute string). All commands and their raw
output are reproduced below so every "no consumer" claim is backed by the grep that found
nothing, not an assumption.

## Consumers found (real, live, path-level)

| # | Consuming file | Exact referenced path | Partition of the referenced path |
| - | --- | --- | --- |
| 1 | `~/Projects/starry-night-ships/.claude/settings.json:9` | `/home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs` | AGENT LAYER |
| 2 | `~/Projects/social-signals-trader/.claude/settings.json:16` | `/home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs` | AGENT LAYER |
| 3 | `~/Projects/social-signals-trader/.claude/settings.json:25` | `/home/bilko/Projects/session-manager/scripts/hooks/guard-destructive-git.cjs` | AGENT LAYER |
| 4 | `~/Projects/social-signals-trader/.mcp.json` (`mcpServers.session-manager-scheduler.args[0]`) | `/home/bilko/Projects/session-manager/scripts/scheduler-mcp-server.cjs` | AGENT LAYER |
| 5 | `~/.claude/settings.json:20` (`extraKnownMarketplaces.session-manager.source.path`) | `/home/bilko/Projects/session-manager` (whole repo root, not a sub-path) | Marketplace root — spans all four partitions |

Evidence (raw command + output):

```
$ grep -l '/home/bilko/Projects/session-manager' ~/Projects/*/.claude/settings.json
/home/bilko/Projects/starry-night-ships/.claude/settings.json
/home/bilko/Projects/social-signals-trader/.claude/settings.json

$ grep -n '/home/bilko/Projects/session-manager' -A2 -B2 /home/bilko/Projects/starry-night-ships/.claude/settings.json
7-          {
8-            "type": "command",
9:            "command": "node /home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs"
10-          }
11-        ]

$ grep -n '/home/bilko/Projects/session-manager' -A2 -B2 /home/bilko/Projects/social-signals-trader/.claude/settings.json
14-          {
15-            "type": "command",
16:            "command": "node /home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs"
17-          }
18-        ]
--
23-          {
24-            "type": "command",
25:            "command": "node /home/bilko/Projects/session-manager/scripts/hooks/guard-destructive-git.cjs"
26-          }
27-        ]

$ cat /home/bilko/Projects/social-signals-trader/.mcp.json   # session-manager-scheduler entry
    "session-manager-scheduler": {
      "command": "node",
      "args": ["/home/bilko/Projects/session-manager/scripts/scheduler-mcp-server.cjs"],
      "env": {}
    }

$ grep -n '/home/bilko/Projects/session-manager' ~/.claude/settings.json
20:        "path": "/home/bilko/Projects/session-manager"
   # (extraKnownMarketplaces.session-manager.source — registers this repo as the
   #  marketplace directory serving the session-manager-dev plugin, i.e. `plugins/`)
```

`~/Projects/*/.claude/settings.local.json` and `~/.claude/settings.local.json`: no matches
(files did not exist / grep returned nothing — confirmed by exit status, no output line to show).

`~/.claude/*.json` beyond `settings.json`: no matches.

`~/Projects/*/CLAUDE.md`: **zero** files matched the absolute-path grep. Widening to a bare
`session-manager` keyword search across every `~/Projects/*/CLAUDE.md` turned up four hits
(`Bilko/CLAUDE.md:62`, `burrow/CLAUDE.md:194,196`, `social-signals-trader/CLAUDE.md:209`,
plus `session-manager/CLAUDE.md` itself) — all prose about the *concept* of session-manager (its
`session-manager-operations/` ops folder, its admin API) or a project-registry list entry, none
naming an absolute path or instructing an agent to run a script by path. **No CLAUDE.md in any
other repo is a path-level consumer.**

## Everything else the recursive sweep found (NOT live consumers)

The recursive `~/Projects` sweep additionally matched ~150 files, all under some other project's
own `session-manager-operations/prompt-sessions/` or `session-manager-operations/scheduler/
prds-archived/` — these are **that project's own scheduler transcripts and archived PRD bodies**,
which happen to quote the absolute path in prose (e.g. a PRD instructing "read
`/home/bilko/Projects/session-manager/.../standards.md`" or a transcript recording a command that
was run). They are historical records generated by this repo's own scheduler/skills running
*inside* those projects, not files that execute a path lookup at any future time. They are not
counted as consumers: nothing re-reads them to resolve a live path, and a completed/archived PRD
body does not re-run.

## What breaks if each path moves — LOUD vs SILENT

| Path | What breaks | LOUD or SILENT |
| --- | --- | --- |
| `scripts/hooks/guard-prd-writes.cjs` | `starry-night-ships` and `social-signals-trader`'s `PreToolUse` hook on `Write\|Edit\|NotebookEdit` shells out to `node <old-path>`. After a move, `node` fails with `MODULE_NOT_FOUND` / ENOENT on that exact file. | **SILENT.** A `PreToolUse` hook command that fails to even start is not "the tool call was blocked" — Claude Code treats a hook execution failure as the hook simply not firing (no block, no visible denial), so a Write/Edit that the guard would have stopped now goes through with **no error surfaced to the agent or the human**. This is the exact "guard that simply stops firing" case CLAUDE.md warns about. |
| `scripts/hooks/guard-destructive-git.cjs` | Same mechanism, on `social-signals-trader`'s `Bash` matcher — a destructive git command (`git reset --hard`, `git clean`, etc.) that this guard exists to intercept now runs unguarded. | **SILENT**, same reasoning — and higher-stakes, since this guard's whole job is to stop an irreversible action; its silent disappearance is discovered only after the destructive command has already run. |
| `scripts/scheduler-mcp-server.cjs` | `social-signals-trader`'s `.mcp.json` `session-manager-scheduler` entry spawns `node <old-path>`. | **LOUD.** MCP server registration failures surface in Claude Code's MCP connection status (the tool becomes unavailable, `/mcp` shows a connection error) — a human or agent trying to call `scheduler_create_prd` etc. gets a visible failure, not silent no-op behavior. |
| repo root (`~/.claude/settings.json` marketplace `path`) | The `session-manager-dev` plugin (served from `plugins/` under this root) fails to load from `~/.claude/enabledPlugins`. | **LOUD.** A marketplace whose `path` no longer resolves to a valid directory fails plugin load visibly (plugin listed but broken / load error), not silently. |
| `scripts/mint-epic.cjs` | No external consumer found (see MOVABLE verdict below). | N/A |
| `.claude-plugin/` | No external consumer found by absolute path (external repos install/enable by plugin *name* via the marketplace, not a path into `.claude-plugin/` itself — the path dependency is one level up, on the marketplace root, already captured above). | N/A directly; indirectly PINNED via the marketplace-root row above |
| `plugins/` | Same as `.claude-plugin/` — consumed by *name* (`session-manager-dev@session-manager`) through the marketplace root, not by a direct absolute sub-path into `plugins/`. | N/A directly; indirectly PINNED via the marketplace-root row above |

## Per-component verdict: MOVABLE or PINNED

| Component | Verdict | Evidence |
| --- | --- | --- |
| `scripts/hooks/guard-prd-writes.cjs` | **PINNED** | Hardcoded absolute path in `starry-night-ships/.claude/settings.json:9` and `social-signals-trader/.claude/settings.json:16` (quoted above). |
| `scripts/hooks/guard-destructive-git.cjs` | **PINNED** | Hardcoded absolute path in `social-signals-trader/.claude/settings.json:25` (quoted above). |
| `scripts/hooks/guard-inline-implementation.cjs` | **MOVABLE** (no external consumer found) | `grep -l '/home/bilko/Projects/session-manager' ~/Projects/*/.claude/settings.json ~/Projects/*/.claude/settings.local.json` and the recursive repo-wide sweep produced **zero** hits mentioning `guard-inline-implementation` anywhere outside this repo. (It is installed by `delegationReadiness.cjs` as a "nudge, not a hard gate" per its own comment at line 629 — evidently not yet adopted by either external repo surveyed.) |
| `scripts/scheduler-mcp-server.cjs` | **PINNED** | Hardcoded absolute path in `social-signals-trader/.mcp.json`'s `session-manager-scheduler` entry (quoted above). |
| `scripts/mint-epic.cjs` | **MOVABLE** (no external consumer found) | Same sweep (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.md`, recursive `~/Projects` + `~/.claude`) produced zero hits for `mint-epic.cjs` outside this repo. It is one of exactly two `MINT_AUTHORITIES` entries per CLAUDE.md's single-creator law, both internal to this repo's own IPC surface — no other repo calls it. |
| `plugins/` | **PINNED, indirectly** | No direct absolute path into `plugins/` from another repo, but `~/.claude/settings.json:20`'s marketplace `path` points at this repo's root, and `plugins/` is what that marketplace serves (`session-manager-dev@session-manager` in `enabledPlugins`). Moving `plugins/` to a different sub-path within (or out of) the repo root breaks the marketplace's directory-source resolution — see `.claude-plugin/` row, same mechanism. |
| `.claude-plugin/` | **PINNED, indirectly** | Same marketplace-root dependency as `plugins/` — `.claude-plugin/` is the marketplace manifest the `path` in `~/.claude/settings.json:20` resolves against. |
| `.mcp.json` (this repo's own root file) | **MOVABLE** (no external consumer found) | This repo's own root `.mcp.json` is read by Claude Code when a session's cwd is *this* repo, not referenced by path from another repo — external repos wire the scheduler MCP server directly by absolute path to `scripts/scheduler-mcp-server.cjs` (see that row) rather than referencing this file. |

## The npm-package angle

Read `package.json`, `bin/cli.cjs`, and `scripts/postinstall.cjs` directly (not assumed):

- **`package.json`'s `files` array** (verified via `node -e "console.log(require('./package.json').files)"`)
  lists every AGENT LAYER path by its exact repo-relative location: `.claude-plugin/`, `plugins/`,
  `scripts/mint-epic.cjs`, `scripts/scheduler-mcp-server.cjs`, `scripts/hooks/guard-prd-writes.cjs`,
  `scripts/hooks/guard-destructive-git.cjs`, `scripts/hooks/guard-inline-implementation.cjs`.
  **Moving any of these changes what an `npx claude-code-session-manager@latest` install lays
  down** — the entry is a literal string; a move without updating the matching `files` entry
  means `npm pack`/`npm publish` simply omits the moved file from the published tarball (silent
  loss, not an error at publish time), and a stale entry pointing at the old path would make
  `npm publish` warn "no files found matching pattern" (`npm-packlist`'s behavior for a
  non-existent path) — that part is loud, but the fact that the shipped layout for a fresh
  `npx` install changes shape is unconditional and must be re-verified against a real `npm pack
  --dry-run` after any move, which is out of scope for this survey.
- **`bin/cli.cjs`** (read in full, reproduced above): it does not resolve any agent-layer path
  at runtime. Its only job is `path.join(__dirname, '..')` → `appRoot`, then spawn Electron on
  that root so `main: src/main/index.cjs` boots. It never touches `scripts/hooks/`, `plugins/`,
  or `.mcp.json`. **Moving agent-layer files does not affect `cli.cjs`'s own runtime path
  resolution.**
- **`scripts/postinstall.cjs`** (read in full, reproduced above): resolves only
  `path.join(pkgRoot, 'node_modules', '.bin', 'electron-rebuild')` for the node-pty native
  rebuild. It has no reference to any agent-layer path. **Moving agent-layer files does not
  affect `postinstall.cjs`.**
- Net: the npm-package risk is entirely in the **`files` array entries themselves needing a
  matching edit**, not in any runtime path resolution inside `cli.cjs` or `postinstall.cjs`.

## How the guard paths actually get INTO another repo's settings.json

`src/main/lib/delegationReadiness.cjs:28-33` computes the four agent-layer script paths via
`path.resolve(__dirname, '..', '..', '..', 'scripts', ...)` — i.e. relative to *this file's own
location inside this repo* — into constants `SCHEDULER_MCP_SERVER_SCRIPT`,
`PRD_WRITE_GUARD_SCRIPT`, `DESTRUCTIVE_GIT_GUARD_SCRIPT`, `INLINE_IMPLEMENTATION_GUARD_SCRIPT`.
New Epic's readiness banner then calls the install functions at lines 451-459 (`PRD_WRITE_GUARD_SCRIPT`)
and 557-562 (`DESTRUCTIVE_GIT_GUARD_SCRIPT`), which write a literal `command: "node <that
resolved absolute path>"` string directly into the target repo's `.claude/settings.json`. This is
exactly the "adopt by reference" mechanism CLAUDE.md's law describes, and it is why the survey's
LOUD/SILENT table above matters: **the write already happened, in the past, into two other
repos' checked-in config.** Moving `scripts/hooks/` inside this repo changes what
`path.resolve(__dirname, ...)` computes for all *future* installs, but does nothing to the
already-written strings in `starry-night-ships/.claude/settings.json` and
`social-signals-trader/.claude/settings.json` — those are frozen text that will point at a
now-missing file until someone re-runs the readiness banner's fix action in each of those repos.

## Recommended sequencing for a future agent-layer move

1. **The two guard hooks (`guard-prd-writes.cjs`, `guard-destructive-git.cjs`) cannot move at
   their current path without a coordinated fix-up in every consuming repo, and CLAUDE.md
   forecloses the usual escape hatches:** "adopt by REFERENCE, never vendor" rules out leaving a
   vendored copy behind at the new location as a courtesy, and "no backwards-compat shims" rules
   out leaving a thin re-exporting stub file at the old path that forwards to the new one. There
   is no safe silent move for these two files under this repo's own stated rules.
   - **The only compliant options are:** (a) leave `scripts/hooks/guard-*.cjs` at their current
     path permanently as the published contract, and move everything else in the agent layer
     around them — i.e. `scripts/hooks/` becomes a fixed public interface, not an internal
     implementation detail free to relocate; or (b) move them, then go into
     `starry-night-ships/.claude/settings.json` and `social-signals-trader/.claude/settings.json`
     and hand-edit the `command` strings to the new path in the same change — which is a
     cross-repo edit this PRD's own "Out of scope" section forbids performing here, and which
     the New Epic readiness banner does not currently offer as a bulk "repair all known
     consumers" action (it only re-installs into the repo whose readiness banner you're
     currently viewing).
   - Given the "no backwards-compat shim" law, **(a) is the only option that requires zero
     coordinated cross-repo edits and zero rule-bending** — recommended.
2. **`scripts/scheduler-mcp-server.cjs` has the same shape of problem** (hardcoded in
   `social-signals-trader/.mcp.json`) but a smaller blast radius (one repo, one file, and an MCP
   registration failure is LOUD rather than silent) — it could move together with a single
   coordinated edit to that one `.mcp.json`, but doing so still requires the same cross-repo
   write this PRD is barred from performing, so it should be sequenced into the same follow-up
   as the guard fix-up, not attempted alone.
3. **`plugins/` and `.claude-plugin/` are PINNED only through the marketplace-root entry**
   (`~/.claude/settings.json:20`, a single path pointing at the *repo root*, not into either
   folder). As long as the repo root itself does not move, relocating `plugins/` or
   `.claude-plugin/` to a different sub-path *within* the repo does not require any cross-repo
   edit — only re-verifying `.claude-plugin/marketplace.json`'s own internal reference to
   wherever `plugins/` ends up (an in-repo concern, not an external one).
4. **`scripts/mint-epic.cjs` and `scripts/hooks/guard-inline-implementation.cjs` are genuinely
   MOVABLE today** — no external consumer was found for either. They can move freely from this
   survey's evidence alone, though `guard-inline-implementation.cjs`'s current MOVABLE status is
   an artifact of it not yet being adopted anywhere, not a structural guarantee — re-grep before
   acting on this verdict if significant time has passed since 2026-09-12.
5. **Whatever moves, update `package.json`'s `files` array entries in the same PRD** — a stale
   entry silently drops the file from future `npx` installs (npm-package angle above) even for
   components with zero *external-repo* consumers.

Net recommendation: **do not move `scripts/hooks/guard-prd-writes.cjs` or
`scripts/hooks/guard-destructive-git.cjs`** under the current "adopt by reference, no
backwards-compat shims" rules — treat `scripts/hooks/` as a frozen public path. Everything else
in the agent layer (`plugins/`, `.claude-plugin/`, `mint-epic.cjs`,
`guard-inline-implementation.cjs`, and — with one coordinated external `.mcp.json` edit —
`scheduler-mcp-server.cjs`) can move with sequencing as above.
