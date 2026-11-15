---
name: builder
description: Watch session-manager's git history against the published npm package and drive the next npm publish.
tools: Read, Grep, Glob, Bash
---

Project overlay for the generic `builder` agent (`~/.claude/agents/builder.md`) — that file has the
full protocol; this file only has what's specific to this repo. Read both.

Note: `~/.claude/agents/builder.md` is machine-local and not version-controlled in any repo — it
lives outside git entirely. This overlay is therefore the only tracked half of the protocol; any
change that must survive a machine rebuild belongs here or in the `session-manager-dev` plugin
skills, not in the global file.

## Release target

Read `session-manager-operations/architecture/build-target.json` for the package name, registry,
version-bump policy, and required gates — don't hardcode them here. If running inside the app,
call `src/main/lib/buildTarget.cjs`'s `resolveBuildTarget(cwd)`; if running as a bare skill/agent
outside the app, read the JSON file directly. Fallback if that file is missing: auto-discover from
`package.json` (`name` field, `conventional-commits` bump policy, no gates) — the same logic
`resolveBuildTarget` applies internally, so the two paths never disagree.

- Registry truth (dist-tag `latest`, using the `registry`/`packageName` resolved above):
  `npm view <packageName> version dist-tags`.
- Local truth: `package.json` `version` field. These two should always match at rest — a mismatch
  means a previous publish attempt half-completed.
- Tags: `vX.Y.Z` in git, one per publish (`git tag --sort=-creatordate`).
- Last-release diff: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`.

## Commit style actually used here

This repo's commits are conventional-commit-ish: `fix(scope): ...`, `feat(scope): ...`,
`docs(scope): ...`, `chore(scope): ...`. Trust the prefix for bump classification; scope in
parens is informational only.

## Gates before publish

- The `gates` array in `build-target.json` (currently `typecheck`, `test:unit`) names which
  `npm run <gate>` commands must pass before publish — read them from there, not from a hardcoded
  list here. A red gate on `HEAD` means something landed that shouldn't have; don't publish
  through it, flag it.
- **Working-tree dirtiness is expected here, not anomalous**: this repo runs many concurrent
  Epics/sessions against the same working directory (see project CLAUDE.md's TAB/EPIC model), so a
  dirty tree during a Builder run is very likely another session's live edit, not leftover debris.
  Never stash or discard it. It does not block publishing: `prepublishOnly` runs `vite
  build` off *whatever directory `npm publish` is invoked in* — so the publish sequence below runs
  from an isolated `git worktree` checkout of the release tag instead of the live working
  directory, which is clean by construction regardless of what other sessions are doing in the
  main tree.

## Publish sequence (once decided)

See step 4 of [`plugins/session-manager-dev/skills/builder/SKILL.md`](../../plugins/session-manager-dev/skills/builder/SKILL.md)
for the concrete worktree-isolated publish steps — that skill is the single source of truth for
the mechanics, don't re-describe them here. Once the decision to publish is made, run that
sequence straight through without pausing for confirmation at each step — the pause point is the
*decision*, not the mechanics.

## Publish auth: check this BEFORE assuming a plain login problem

`npm publish` can 403 with `Two-factor authentication or granular access token with bypass
2fa enabled is required to publish packages` even when `npm whoami` succeeds — this is a
**separate write-path gate**, not a stale-login problem. Don't loop on `npm login`/re-auth.

1. Check `npm profile get` (2FA status) and `npm token list` (token type) first.
2. If 2FA is disabled and the token is a legacy "classic" publish token (created via
   `npm token create`), publish is structurally blocked — classic tokens can't satisfy this
   requirement, and the CLI cannot create a granular access token (`npm token create` only
   makes classic tokens; granular/bypass-2FA tokens are npmjs.com-web-UI-only, confirmed via
   `npm help token`, 2026-08-22).
3. **Do not treat a bypass-2FA granular token as a durable automation fix** — npm is removing
   its publish capability (https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/);
   it is a bridge at best.
4. There is currently **no way for this agent to publish fully unattended** end-to-end on
   this machine — either a human enables 2FA and supplies a live OTP at publish time, or a
   human mints a bypass-2FA granular token via the npmjs.com web UI and drops it in
   `~/.npmrc` (bridge only, see above). The durable fix is moving the publish step into a
   GitHub Actions workflow using npm Trusted Publishing (OIDC), triggered on `v*` tag push —
   that eliminates the token/2FA problem entirely by running the publish inside CI, which can
   present npm with its own short-lived OIDC identity instead of any stored credential. That
   workflow does not exist yet in this repo (only local worktree-based publish does) — file
   it as its own PRD when the human wants unattended `/builder` restored; don't attempt to
   build it as a side effect of a release run.
5. When blocked here: stop, do NOT retry `npm login` or `npm publish` repeatedly, report the
   exact 403 output and the `npm profile get`/`npm token list` findings, and ask the human to
   either supply an OTP-based interactive publish or a bypass-2FA token for this release.
