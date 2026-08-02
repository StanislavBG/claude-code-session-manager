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
  Never stash or discard it. This no longer blocks publishing, though: `prepublishOnly` runs `vite
  build` off *whatever directory `npm publish` is invoked in* — so the publish sequence below runs
  from an isolated `git worktree` checkout of the release tag instead of the live working
  directory, which is clean by construction regardless of what other sessions are doing in the
  main tree.

## Publish sequence (once decided)

See [`plugins/session-manager-dev/skills/builder/3-publish/SKILL.md`](../../plugins/session-manager-dev/skills/builder/3-publish/SKILL.md)
for the concrete worktree-isolated publish steps — that skill is the single source of truth for
the mechanics, don't re-describe them here. Once the decision to publish is made, run that
sequence straight through without pausing for confirmation at each step — the pause point is the
*decision*, not the mechanics.

## Known one-time exceptions logged here so they aren't re-litigated

- **v0.45.1** through **v0.47.1** below all landed the same day (2026-08-01), each a real npm
  publish proving the worktree technique end-to-end, not a batch of hypotheticals.
- **v0.45.1** — patch: `fix(browser)` allow real popup windows for identity-provider OAuth,
  bundled with a docs commit for the browser ops README.
- **v0.45.2** — patch: two `fix` commits, Epic Queue sidebar height + `navFace` made real state
  instead of derived.
- **v0.46.0** — minor: mixed `feat`/`fix`/`test` batch led by `feat(epics)` quote-reply affordance
  and row-menu actions (rename/duplicate/delete/reopen) — feat commits in the set forced the minor
  bump even though several commits in the same release were fixes.
- **v0.47.1** — patch: `fix(nav)` distinct tab highlighting + project-only Epics + Dashboard vs
  Project Home, landed as a follow-up patch directly on top of v0.47.0's larger feat/fix batch.
