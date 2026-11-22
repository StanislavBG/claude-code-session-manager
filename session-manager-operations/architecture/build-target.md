# build-target.json — a project's release destination

`build-target.json` is what the builder agent reads to learn whether a
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

## How builds start

`resolveBuildTarget()` returns a target or `null`, and `null` means **not configured yet** —
never "this project cannot be built". There is no Build button and no IPC for the resolver:
a build is started from a user-created Macro (HOT KEYS strip), e.g. agent `builder`,
tag `build`, prompt "Build and publish this project". The builder agent reads this file (or
probes the project and proposes one) and stops for human approval before any first release.

A human gate between discovery and first execution is mandatory: writing a build target and
immediately executing a release against it, on a project the agent just met, is how you get
an accidental `npm publish`.

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
(current `publishConfig` is just `{ "access": "public" }`). `release.yml` builds installers only;
there is no npm provenance because publishing is local (see the 2FA note below).

### GitHub repo requirement

The published package MUST have a corresponding GitHub repo at
`https://github.com/StanislavBG/claude-code-session-manager` — `package.json`'s `repository.url`
points there. `repository`/`homepage`/`bugs` only appear on the npm registry page after the
**next publish** following the commit that adds or changes them; they don't backfill old versions.

### npm write-path 2FA gate / Trusted Publishing

No CI publish path (owner decision 2026-11-21; Trusted Publishing job removed, restore from commit
9f7b2627). Releases publish locally via the builder skill's isolated worktree with a granular token
that has **"Bypass two-factor authentication"** ticked, renewed before its 90-day expiry. With
`bypass_2fa: false`, `npm publish` fails E403 though `npm whoami` succeeds. Probe with
`npm token list --json` (`bypass_2fa`, `expiry`, `revoked`); `npm profile get` errors with granular
tokens. The builder skill's step 3 publish preflight names a missing or wrong token before any bump.
npm expects such tokens to lose direct publishing ~January 2027 ([changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).
A Trusted Publisher, if ever registered, needs `npm publish` ticked under Allowed actions (configs
created after 2026-09-03 allow only `npm stage publish` by default) and must complete its first
publish within 2 days or it expires.

### Publish command sequence

The exact, verified command sequence — including the isolated-worktree technique (`vite build`
reads the working directory, so publish always happens from a clean worktree checked out at the
release tag, never the live/dirty main working directory) and the real `prepublishOnly` chain
(`write-build-info.cjs && npm run build && npm run lint:readme` — see `package.json`) — lives in
[`plugins/session-manager-dev/skills/builder/SKILL.md`](../../plugins/session-manager-dev/skills/builder/SKILL.md) (step 4),
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

## Installer artifacts

`.github/workflows/release.yml` triggers on `v*` tags and attaches installers to the GitHub Release
(names from `electron-builder.yml`):

- `Session-Manager-mac-<arch>.dmg` (arm64 and x64)
- `Session-Manager-win-<arch>.exe`
- `Session-Manager-linux-<arch>.AppImage`

Signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)
are optional: without `CSC_LINK` the workflow builds unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
