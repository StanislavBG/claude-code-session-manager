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

## This project's npm publish requirements

Session-manager's own `registry: "npm"` target has requirements beyond the generic shape above —
this section is npm/session-manager-specific, not part of the resolver's generic contract.

### Required package.json metadata

Every published version must have:

- `name` — `claude-code-session-manager`
- `version` — semver, bumped before publish
- `license` — `MIT`
- `repository.url` — `https://github.com/StanislavBG/claude-code-session-manager.git`
- `homepage` — `https://github.com/StanislavBG/claude-code-session-manager#readme`
- `bugs.url` — `https://github.com/StanislavBG/claude-code-session-manager/issues`

No `publishConfig.provenance` field — it has never existed in this project's `package.json`
(current `publishConfig` is just `{ "access": "public" }`), and provenance itself is future work,
gated on a `release.yml` GitHub Actions workflow that doesn't exist yet (see the 2FA note below).

### GitHub repo requirement

The published package MUST have a corresponding GitHub repo at
`https://github.com/StanislavBG/claude-code-session-manager` — `package.json`'s `repository.url`
points there. `repository`/`homepage`/`bugs` only appear on the npm registry page after the
**next publish** following the commit that adds or changes them; they don't backfill old versions.

### npm write-path 2FA gate / Trusted Publishing

`npm publish` can 403 (`Two-factor authentication or granular access token with bypass 2fa enabled
is required to publish packages`) even when `npm whoami` succeeds — a separate gate from login. A
legacy "classic" publish token cannot satisfy it; only an account with 2FA enabled (interactive OTP
at publish time) or a **granular access token with "bypass 2FA for write actions"** (npmjs.com web
UI only — the CLI cannot create one) can. npm is deprecating the bypass-2FA token path itself —
Phase 2 (~Jan 2027) removes its publish capability entirely. The durable fix, once a `release.yml`
workflow exists, is **npm Trusted Publishing (OIDC)** — no token/2FA at all, since npm verifies the
GitHub Actions run's own short-lived identity. Until that workflow is built, this repo has no fully
unattended publish path; a local-worktree publish needs either a live human OTP or a (temporary,
pre-2027) bypass-2FA token per release.

### Publish command sequence

The exact, verified command sequence — including the isolated-worktree technique (`vite build`
reads the working directory, so publish always happens from a clean worktree checked out at the
release tag, never the live/dirty main working directory) and the real `prepublishOnly` chain
(`npm run build:project-pages && npm run build:project-pages-logic && npm run project-pages:gate
&& vite build` — not a bare `vite build`) — lives in
[`plugins/session-manager-dev/skills/builder/3-publish/SKILL.md`](../../plugins/session-manager-dev/skills/builder/3-publish/SKILL.md),
not here. That skill owns the procedure; this file only states the target's requirements.

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
