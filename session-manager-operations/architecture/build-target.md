# build-target.json — a project's release destination

`build-target.json` is what the Sessions toolbar's Build button reads to decide whether a
project knows how to ship itself. One file per project, at:

```
<project cwd>/session-manager-operations/architecture/build-target.json
```

`src/main/lib/buildTarget.cjs` resolves it. It is the *only* thing that resolver looks for,
besides one npm convenience fallback.

## Shape

```json
{
  "registry": "npm",
  "packageName": "claude-code-session-manager",
  "versionBumpPolicy": "conventional-commits",
  "gates": ["typecheck", "test:unit"]
}
```

| Field | Meaning |
| --- | --- |
| `registry` | Free-form. Where this project actually ships — `npm`, `git-tag`, `container`, … A project that publishes to no registry and releases by tagging says `git-tag`; that is a normal answer, not a missing one. |
| `packageName` | The name the release is known by. The one field the resolver validates (non-empty string) — a config without it is ignored. |
| `versionBumpPolicy` | How the next version is chosen, e.g. `conventional-commits`. |
| `gates` | Commands/checks that must pass before a release. Names are project-local (npm scripts here; `make test` elsewhere). |

The file only says **what** the target is. **How** to release — the exact command sequence,
in order, plus any post-release step — lives in the project-local
`.claude/agents/builder.md` overlay, which may override the global builder protocol *by name*,
not merely add to it. (Example: the isolated-worktree publish technique exists because
`vite build` reads the working directory; a project with no build step should say so and skip
it rather than cargo-cult it.)

## The three states of the Build button

`resolveBuildTarget()` returns a target or `null`, and `null` means **not configured yet** —
never "this project cannot be built". `src/renderer/lib/buildAction.ts` turns that into:

| Resolver says | Button | Press does |
| --- | --- | --- |
| a target | **Run Build** | release run (`/builder`) |
| `null` | **Set Up Build** | bootstrap session — probes the project read-only, writes this file *and* the `.claude/agents/builder.md` overlay, then **stops for human approval** |
| (a build session already open) | **Open Build** | re-opens it |

The bootstrap session never publishes. A human gate between discovery and first execution is
mandatory: writing a build target and immediately executing a release against it, on a project
the agent just met, is how you get an accidental `npm publish`.

## Why the resolver doesn't sniff pyproject.toml / Cargo.toml / go.mod

Deliberate. See the header comment in `src/main/lib/buildTarget.cjs`. Short version: an
ecosystem list in the main process always lags reality, file existence yields no publish
commands (plenty of local-first projects have a `pyproject.toml` and never touch PyPI), and no
amount of sniffing derives "bump `VERSION`, write the changelog, tag, and flag that the live
server needs a restart". That needs `CLAUDE.md` plus git history plus judgment — so the
resolver stays dumb and discovery lives in the agent.

## Worked non-npm example

A local-first Python cron daemon with no registry publish:

```json
{
  "registry": "git-tag",
  "packageName": "burrow",
  "versionBumpPolicy": "conventional-commits",
  "gates": ["test"]
}
```

Its overlay's release sequence: `make test` → tombstone check → bump the root `VERSION` file →
add a `## [x.y.z]` section to `CHANGELOG.md` → commit those files only → `git tag -a v<version>`
→ report whether the live MCP server and cron orchestrator need a restart. No registry publish
at any point.

Two things a bootstrap probe has to handle that the npm path has no analogue for:

- **Zero git tags.** The global builder protocol's step 1 is `git log <last-release-tag>..HEAD`.
  A project that has never tagged has no baseline — detect it and state the fallback rather
  than failing.
- **The isolated-worktree publish technique is npm-specific**, so the overlay must be able to
  override an inherited instruction by name.
